import "dotenv/config";
import postgres from "postgres";

// ---------- DB STATUS ----------
// Operational snapshot: what exists, how full it is, and whether anything is
// stuck in the queue. Read-only, safe to run against production.

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1, prepare: false });

const TABLES = [
  "merchants",
  "disputes",
  "evidence_documents",
  "evidence_chunks",
  "packets",
  "packet_claims",
  "webhook_events",
  "jobs",
] as const;

async function main() {
  const extensions = await sql<{ extname: string; extversion: string }[]>`
    select extname, extversion from pg_extension where extname in ('vector', 'pg_trgm')
  `;

  const present = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'public'
  `;
  const presentNames = new Set(present.map((r) => r.table_name));

  console.log("\nextensions");
  for (const e of extensions) console.log(`  ${e.extname.padEnd(20)} ${e.extversion}`);

  console.log("\ntables");
  for (const table of TABLES) {
    if (!presentNames.has(table)) {
      console.log(`  ${table.padEnd(20)} MISSING`);
      continue;
    }
    // Table names come from the constant above, never from user input.
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from ${sql(table)}
    `;
    console.log(`  ${table.padEnd(20)} ${count} rows`);
  }

  if (presentNames.has("jobs")) {
    const byStatus = await sql<{ status: string; count: string }[]>`
      select status::text as status, count(*)::text as count from jobs group by status order by status
    `;
    if (byStatus.length > 0) {
      console.log("\njobs by status");
      for (const r of byStatus) console.log(`  ${r.status.padEnd(20)} ${r.count}`);
    }
  }

  console.log();
}

main()
  .catch((error) => {
    console.error("✗ status failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
