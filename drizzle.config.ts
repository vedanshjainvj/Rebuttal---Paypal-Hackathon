import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// ---------- DRIZZLE KIT ----------
// Reads .env directly: drizzle-kit runs outside Next, so it does not get the
// framework's environment loading.

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set — drizzle-kit cannot run");
}

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url, ssl: "require" },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
