import "dotenv/config";
import postgres from "postgres";

// ---------- LISTEN/NOTIFY CHECK ----------
// Diagnoses the live event stream.
//
// Neon's pooled host runs PgBouncer in transaction pooling mode, which does
// not support LISTEN: the subscription is bound to a session, and the pooler
// hands the connection to someone else the moment the transaction ends. The
// call appears to succeed and no event ever arrives — a silent failure that
// looks exactly like a bug in the application.
//
// This compares the pooled and direct endpoints so the cause is visible
// rather than inferred.

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

/** Neon exposes the same database on a direct host without the -pooler suffix. */
const direct = url.replace("-pooler", "");

async function trial(label: string, connectionString: string): Promise<boolean> {
  const sql = postgres(connectionString, { ssl: "require", max: 2, prepare: false });
  let received: string | null = null;

  try {
    await sql.listen("notify_probe", (payload) => {
      received = payload;
    });
    // Give the LISTEN time to register before publishing.
    await new Promise((r) => setTimeout(r, 800));
    await sql.notify("notify_probe", "ping");
    await new Promise((r) => setTimeout(r, 2500));

    console.log(`  ${label.padEnd(8)} ${received ? "✓ received" : "✗ nothing received"}`);
    return received !== null;
  } catch (error) {
    console.log(`  ${label.padEnd(8)} ✗ ${error instanceof Error ? error.message : error}`);
    return false;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  console.log(`\npooled host  ${new URL(url!).host}`);
  console.log(`direct host  ${new URL(direct).host}\n`);

  const pooled = await trial("pooled", url!);
  const directOk = await trial("direct", direct);

  console.log();
  if (!pooled && directOk) {
    console.log("Diagnosis: the pooled endpoint cannot carry LISTEN/NOTIFY.");
    console.log("The event bus must use the direct endpoint. This is handled");
    console.log("automatically in src/lib/events/bus.ts.\n");
  } else if (pooled && directOk) {
    console.log("Both endpoints carry LISTEN/NOTIFY.\n");
  } else if (!pooled && !directOk) {
    console.log("Neither endpoint works — check network access to Neon.\n");
  }
}

main().catch((error) => {
  console.error("\n✗ Failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
