import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Application user accounts. Roles: "admin" or "user".
// Admins can configure the shared Anthropic API key and manage users;
// regular users can use the app but never see or change the API key.
export const users = pgTable("users", {
  id: serial().primaryKey(),
  username: text().notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text().notNull().default("user"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Shared, server-only configuration (Anthropic API key, model, session
// secret). Stored as key/value rows. The API key never leaves the server.
export const appConfig = pgTable("app_config", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
