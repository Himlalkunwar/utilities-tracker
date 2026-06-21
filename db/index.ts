import { drizzle } from "drizzle-orm/netlify-db";
import * as schema from "./schema.js";

// Connection is configured automatically by the Netlify Database adapter.
export const db = drizzle({ schema });
