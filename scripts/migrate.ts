import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// ---------- MIGRATE ----------
// Two stages. Extensions must exist before the generated migrations run,
// because the schema declares a `vector` column and an hnsw index whose
// operator class ships with that extension.
//
// Uses its own single connection rather than the app pool: migrations run once
// and must not be affected by pooling or prepared-statement settings.

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1, prepare: false });

async function main() {
  console.log("→ enabling extensions");
  await sql`create extension if not exists vector`;
  await sql`create extension if not exists pg_trgm`;

  console.log("→ applying migrations");
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });

  // Full-text index over chunk content. Expressed as raw SQL because the
  // expression index uses to_tsvector, which Drizzle's builder does not model.
  console.log("→ ensuring full-text index");
  await sql`
    create index if not exists evidence_chunks_fts_idx
    on evidence_chunks
    using gin (to_tsvector('english', content))
  `;

  console.log("✓ migrations complete");
}

main()
  .catch((error) => {
    console.error("✗ migration failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
