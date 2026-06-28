'use strict';

const express = require('express');
const multer  = require('multer');
const Database = require('better-sqlite3');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const ExcelJS = require('exceljs');
const os      = require('os');

// ─── App setup ───────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const DB_PATH      = path.join(__dirname, 'camp_utilities.db');
const UPLOADS_DIR  = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── SQLite ───────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL UNIQUE,
    unit      TEXT    NOT NULL,
    icon      TEXT    DEFAULT '📦',
    color     TEXT    DEFAULT '#4361ee',
    active    INTEGER DEFAULT 1,
    created_at TEXT   DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    category_name   TEXT,
    quantity        REAL,
    unit            TEXT,
    supplier        TEXT,
    vehicle_number  TEXT,
    delivery_date   TEXT,
    notes           TEXT,
    image_filename  TEXT,
    extracted_data  TEXT,
    recorded_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Seed default categories if empty
const catCount = db.prepare('SELECT COUNT(*) as n FROM categories').get().n;
if (catCount === 0) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO categories (name, unit, icon, color) VALUES (?, ?, ?, ?)`
  );
  [
    ['Fuel (Diesel)',  'Liters', '⛽', '#e63946'],
    ['Fuel (Petrol)',  'Liters', '🛢️', '#f77f00'],
    ['Water',          'Liters', '💧', '#0077b6'],
    ['LPG',            'kg',     '🔥', '#f4a261'],
    ['Sewage',         'm³',     '🚽', '#6d6875'],
    ['Waste',          'kg',     '🗑️', '#588157'],
    ['Electricity',    'kWh',   '⚡', '#ffd60a'],
  ].forEach(([name, unit, icon, color]) => insert.run(name, unit, icon, color));
}

// Seed default settings
db.prepare(`INSERT OR IGNORE INTO settings VALUES ('camp_name', 'Camp Operations')`).run();
db.prepare(`INSERT OR IGNORE INTO settings VALUES ('anthropic_api_key', '')`).run();
db.prepare(`INSERT OR IGNORE INTO settings VALUES ('claude_model', 'claude-haiku-4-5-20251001')`).run();

// ─── Multer ──────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ts  = Date.now();
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `util_${ts}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images are allowed'));
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function safeExistingImageFilename(filename) {
  if (!filename) return null;
  const base = path.basename(String(filename));
  if (base !== filename) return null;
  const fp = path.join(UPLOADS_DIR, base);
  return fs.existsSync(fp) ? base : null;
}

// ─── API: Settings ────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj  = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  obj.server_ip   = getLocalIP();
  obj.server_port = PORT;
  res.json(obj);
});

app.put('/api/settings', (req, res) => {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [key, value] of Object.entries(req.body)) {
    upsert.run(key, String(value));
  }
  res.json({ ok: true });
});

// ─── API: Categories ──────────────────────────────────────────────────────────
app.get('/api/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY name').all());
});

app.post('/api/categories', (req, res) => {
  const { name, unit, icon = '📦', color = '#4361ee' } = req.body;
  if (!name || !unit) return res.status(400).json({ error: 'name and unit required' });
  const info = db.prepare(
    'INSERT INTO categories (name, unit, icon, color) VALUES (?, ?, ?, ?)'
  ).run(name.trim(), unit.trim(), icon, color);
  res.json({ id: info.lastInsertRowid, name, unit, icon, color, active: 1 });
});

app.put('/api/categories/:id', (req, res) => {
  const { name, unit, icon, color, active } = req.body;
  db.prepare(
    'UPDATE categories SET name=?, unit=?, icon=?, color=?, active=? WHERE id=?'
  ).run(name, unit, icon, color, active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── API: Records ─────────────────────────────────────────────────────────────
app.get('/api/records', (req, res) => {
  const { category_id, from, to, q, limit = 100, offset = 0 } = req.query;
  let sql = `SELECT r.*, c.icon, c.color
             FROM records r LEFT JOIN categories c ON r.category_id = c.id
             WHERE 1=1`;
  const params = [];
  if (category_id) { sql += ' AND r.category_id = ?'; params.push(category_id); }
  if (from)        { sql += ' AND r.delivery_date >= ?'; params.push(from); }
  if (to)          { sql += ' AND r.delivery_date <= ?'; params.push(to); }
  if (q)           { sql += ' AND (r.supplier LIKE ? OR r.vehicle_number LIKE ? OR r.notes LIKE ?)';
                     params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY r.recorded_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const rows  = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as n FROM records').get().n;
  res.json({ total, rows });
});

app.get('/api/records/:id', (req, res) => {
  const row = db.prepare(
    'SELECT r.*, c.icon, c.color FROM records r LEFT JOIN categories c ON r.category_id = c.id WHERE r.id = ?'
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/records', upload.single('image'), (req, res) => {
  const {
    category_id, category_name, quantity, unit,
    supplier, vehicle_number, delivery_date, notes, extracted_data, existing_image
  } = req.body;
  const image_filename = req.file ? req.file.filename : safeExistingImageFilename(existing_image);
  const info = db.prepare(`
    INSERT INTO records
      (category_id, category_name, quantity, unit, supplier, vehicle_number,
       delivery_date, notes, image_filename, extracted_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    category_id || null, category_name || null,
    quantity ? Number(quantity) : null, unit || null,
    supplier || null, vehicle_number || null,
    delivery_date || null, notes || null,
    image_filename, extracted_data || null
  );
  res.json({ id: info.lastInsertRowid, image_filename });
});

app.put('/api/records/:id', (req, res) => {
  const {
    category_id, category_name, quantity, unit,
    supplier, vehicle_number, delivery_date, notes
  } = req.body;
  db.prepare(`
    UPDATE records SET
      category_id=?, category_name=?, quantity=?, unit=?,
      supplier=?, vehicle_number=?, delivery_date=?, notes=?
    WHERE id=?
  `).run(
    category_id || null, category_name || null,
    quantity ? Number(quantity) : null, unit || null,
    supplier || null, vehicle_number || null,
    delivery_date || null, notes || null,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/records/:id', (req, res) => {
  const row = db.prepare('SELECT image_filename FROM records WHERE id=?').get(req.params.id);
  if (row?.image_filename) {
    const fp = path.join(UPLOADS_DIR, row.image_filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM records WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── API: OCR / AI Extraction ─────────────────────────────────────────────────
app.post('/api/extract', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) {
    return res.status(400).json({ error: 'Anthropic API key not configured. Go to Settings.' });
  }

  const model    = getSetting('claude_model') || 'claude-haiku-4-5-20251001';
  const imageData = fs.readFileSync(req.file.path);
  const base64   = imageData.toString('base64');
  const mime     = req.file.mimetype;

  const prompt = `You are extracting utility delivery data from a camp operations image.
The image may be a delivery receipt, meter reading, handwritten log, or truck delivery docket.

Return ONLY valid JSON (no explanation, no markdown) with these fields:
{
  "quantity": <number or null>,
  "unit": "<liters|kg|m3|kWh|gallons|null>",
  "category": "<Fuel (Diesel)|Fuel (Petrol)|Water|LPG|Sewage|Waste|Electricity|Other>",
  "supplier": "<supplier/vendor name or null>",
  "vehicle_number": "<truck plate or null>",
  "delivery_date": "<YYYY-MM-DD or null>",
  "notes": "<any other visible relevant text>"
}`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 30000
      }
    );

    const text = response.data.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const extracted = JSON.parse(jsonMatch[0]);
    // include the uploaded filename so the frontend can use it
    extracted.image_filename = req.file.filename;
    res.json(extracted);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    // Still return the filename so image isn't lost
    res.status(500).json({ error: msg, image_filename: req.file.filename });
  }
});

// ─── API: Dashboard ───────────────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  const totalRecords = db.prepare('SELECT COUNT(*) as n FROM records').get().n;
  const thisMonth = db.prepare(`
    SELECT COUNT(*) as n FROM records
    WHERE strftime('%Y-%m', recorded_at) = strftime('%Y-%m', 'now')
  `).get().n;

  const byCategory = db.prepare(`
    SELECT c.name, c.unit, c.icon, c.color,
           COUNT(r.id) as count,
           SUM(r.quantity) as total_qty
    FROM categories c
    LEFT JOIN records r ON r.category_id = c.id
    WHERE c.active = 1
    GROUP BY c.id
    ORDER BY total_qty DESC
  `).all();

  const recent = db.prepare(`
    SELECT r.*, c.icon, c.color
    FROM records r LEFT JOIN categories c ON r.category_id = c.id
    ORDER BY r.recorded_at DESC LIMIT 5
  `).all();

  const trend = db.prepare(`
    SELECT strftime('%Y-%m-%d', delivery_date) as day,
           category_name,
           SUM(quantity) as qty
    FROM records
    WHERE delivery_date >= date('now', '-30 days')
    GROUP BY day, category_name
    ORDER BY day
  `).all();

  res.json({ totalRecords, thisMonth, byCategory, recent, trend });
});

// ─── API: Export ──────────────────────────────────────────────────────────────
function groupRowsByCategory(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.category_id || row.category_name || 'uncategorized';
    if (!groups.has(key)) {
      groups.set(key, {
        name: row.category_name || 'Uncategorized',
        icon: row.icon || '',
        unit: row.unit || '',
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function safeWorksheetName(name, index) {
  const cleaned = String(name || `Category ${index}`)
    .replace(/[:\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || `Category ${index}`).slice(0, 31);
}

function uniqueWorksheetName(name, index, usedNames) {
  const base = safeWorksheetName(name, index);
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const ending = ` ${suffix++}`;
    candidate = `${base.slice(0, 31 - ending.length)}${ending}`;
  }
  usedNames.add(candidate);
  return candidate;
}

app.get('/api/export/excel', async (req, res) => {
  const { from, to, category_id } = req.query;
  let sql = 'SELECT r.*, c.icon FROM records r LEFT JOIN categories c ON r.category_id = c.id WHERE 1=1';
  const params = [];
  if (category_id) { sql += ' AND r.category_id = ?'; params.push(category_id); }
  if (from)        { sql += ' AND r.delivery_date >= ?'; params.push(from); }
  if (to)          { sql += ' AND r.delivery_date <= ?'; params.push(to); }
  sql += ' ORDER BY COALESCE(r.category_name, "Uncategorized") ASC, r.delivery_date DESC, r.recorded_at DESC';
  const rows = db.prepare(sql).all(...params);
  const groups = groupRowsByCategory(rows);

  const campName = getSetting('camp_name') || 'Camp Operations';
  const wb = new ExcelJS.Workbook();
  wb.creator = campName;
  const ws = wb.addWorksheet('Records by Category', { views: [{ state: 'frozen', ySplit: 2 }] });

  // Title row
  ws.mergeCells('A1:J1');
  ws.getCell('A1').value = `${campName} — Utility Records by Category`;
  ws.getCell('A1').font  = { bold: true, size: 14 };
  ws.getCell('A1').fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4361EE' } };
  ws.getCell('A1').font  = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').alignment = { horizontal: 'center' };

  // Header
  const headers = ['#', 'Date', 'Category', 'Quantity', 'Unit', 'Supplier', 'Vehicle #', 'Notes', 'Image', 'Recorded At'];
  ws.addRow(headers);
  ws.getRow(2).font = { bold: true };
  ws.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  ws.columns = [
    { key: 'id',             width: 5  },
    { key: 'delivery_date',  width: 14 },
    { key: 'category_name',  width: 18 },
    { key: 'quantity',       width: 12 },
    { key: 'unit',           width: 10 },
    { key: 'supplier',       width: 20 },
    { key: 'vehicle_number', width: 14 },
    { key: 'notes',          width: 30 },
    { key: 'image',          width: 40 },
    { key: 'recorded_at',    width: 20 },
  ];

  const ip = getLocalIP();
  const addRecordRow = (sheet, r, shade = false) => {
    const imageUrl = r.image_filename
      ? `http://${ip}:${PORT}/uploads/${r.image_filename}`
      : '';
    const row = sheet.addRow([
      r.id, r.delivery_date, r.category_name,
      r.quantity, r.unit, r.supplier,
      r.vehicle_number, r.notes, imageUrl, r.recorded_at
    ]);
    if (imageUrl) {
      row.getCell(9).value = { text: 'View Image', hyperlink: imageUrl };
      row.getCell(9).font  = { color: { argb: 'FF0000FF' }, underline: true };
    }
    if (shade) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    }
  };

  groups.forEach((group) => {
    ws.addRow([]);
    const totalQty = group.rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
    const categoryRow = ws.addRow([
      `${group.icon ? `${group.icon} ` : ''}${group.name}`,
      '',
      `Records: ${group.rows.length}`,
      `Total Qty: ${totalQty}`,
      group.unit,
      '', '', '', '', ''
    ]);
    categoryRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    categoryRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    group.rows.forEach((r, i) => addRecordRow(ws, r, i % 2 === 1));
  });

  const usedSheetNames = new Set(['Records by Category', 'Summary']);
  groups.forEach((group, index) => {
    const sheet = wb.addWorksheet(uniqueWorksheetName(group.name, index + 1, usedSheetNames), { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    sheet.columns = ws.columns.map(col => ({ key: col.key, width: col.width }));
    group.rows.forEach((r, i) => addRecordRow(sheet, r, i % 2 === 1));
    const totalQty = group.rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
    sheet.addRow([]);
    const totalRow = sheet.addRow(['', 'TOTAL', group.rows.length, totalQty, group.unit, '', '', '', '', '']);
    totalRow.font = { bold: true };
  });

  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { key: 'category', width: 24 },
    { key: 'unit', width: 10 },
    { key: 'records', width: 12 },
    { key: 'total', width: 14 }
  ];
  summary.addRow(['Category', 'Unit', 'Records', 'Total Qty']);
  summary.getRow(1).font = { bold: true };
  groups.forEach((group) => {
    summary.addRow([
      `${group.icon ? `${group.icon} ` : ''}${group.name}`,
      group.unit,
      group.rows.length,
      group.rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0)
    ]);
  });

  if (!rows.length) {
    ws.addRow(['No records found for the selected filters']);
  }

  // Totals
  ws.addRow([]);
  const totalRow = ws.addRow(['', 'TOTAL RECORDS', rows.length, '', '', '', '', '', '', '']);
  totalRow.font = { bold: true };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="utility_records_${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
});

app.get('/api/export/csv', (req, res) => {
  const { from, to, category_id } = req.query;
  let sql = 'SELECT r.* FROM records r WHERE 1=1';
  const params = [];
  if (category_id) { sql += ' AND r.category_id = ?'; params.push(category_id); }
  if (from)        { sql += ' AND r.delivery_date >= ?'; params.push(from); }
  if (to)          { sql += ' AND r.delivery_date <= ?'; params.push(to); }
  sql += ' ORDER BY COALESCE(r.category_name, "Uncategorized") ASC, r.delivery_date DESC';
  const rows = db.prepare(sql).all(...params);
  const groups = groupRowsByCategory(rows);

  const ip = getLocalIP();
  const header = 'ID,Date,Category,Quantity,Unit,Supplier,Vehicle#,Notes,ImageURL,RecordedAt\n';
  const esc = v => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const lines = [];
  groups.forEach(group => {
    const totalQty = group.rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
    lines.push('');
    lines.push([
      `${group.icon ? `${group.icon} ` : ''}${group.name}`,
      `Records: ${group.rows.length}`,
      `Total Qty: ${totalQty}`,
      group.unit
    ].map(esc).join(','));
    group.rows.forEach(r => {
      lines.push([
        r.id, r.delivery_date, r.category_name, r.quantity, r.unit,
        r.supplier, r.vehicle_number, r.notes,
        r.image_filename ? `http://${ip}:${PORT}/uploads/${r.image_filename}` : '',
        r.recorded_at
      ].map(esc).join(','));
    });
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="utility_records_${Date.now()}.csv"`);
  res.send(header + lines.join('\n'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n✅ Camp Utilities Server running`);
  console.log(`   Desktop: http://localhost:${PORT}`);
  console.log(`   Mobile:  http://${ip}:${PORT}`);
  console.log(`\n   Share the Mobile URL with camp devices on the same WiFi.\n`);
});
