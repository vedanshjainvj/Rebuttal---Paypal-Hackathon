import "dotenv/config";

// ---------- PAYPAL WEBHOOK ADMIN ----------
//   npm run paypal:webhook list
//   npm run paypal:webhook register [url]
//   npm run paypal:webhook delete <webhookId>
//
// Registration is done through the API rather than the dashboard because the
// tunnel URL changes every time ngrok restarts, and re-registering by hand is
// the step people forget when webhooks mysteriously stop arriving.

const WEBHOOK_PATH = "/api/webhooks/paypal";

async function main() {
  const { env } = await import("../src/lib/env");
  const { createWebhook, deleteWebhook, listWebhooks } = await import(
    "../src/lib/paypal/webhooks"
  );

  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case "list": {
      const webhooks = await listWebhooks();
      if (webhooks.length === 0) {
        console.log("\nNo webhooks registered on this PayPal app.\n");
        return;
      }
      console.log(`\n${webhooks.length} webhook(s) registered:\n`);
      for (const webhook of webhooks) {
        console.log(`  id     ${webhook.id}`);
        console.log(`  url    ${webhook.url}`);
        console.log(`  events ${webhook.event_types.map((e) => e.name).join(", ")}`);
        console.log();
      }
      return;
    }

    case "register": {
      const base = argument ?? env.APP_BASE_URL;
      const url = new URL(WEBHOOK_PATH, base).toString();

      if (url.startsWith("http://localhost")) {
        console.error(
          "\n✗ PayPal cannot deliver to localhost.\n" +
            "  Start a tunnel and pass its URL, or set APP_BASE_URL in .env.\n",
        );
        process.exitCode = 1;
        return;
      }

      // A stale registration pointing at a dead tunnel silently swallows every
      // delivery, so existing registrations are reported before adding another.
      const existing = await listWebhooks();
      const duplicate = existing.find((w) => w.url === url);
      if (duplicate) {
        console.log(`\n✓ Already registered for this URL.\n\n  PAYPAL_WEBHOOK_ID=${duplicate.id}\n`);
        return;
      }

      if (existing.length > 0) {
        console.log(`\nNote: ${existing.length} other webhook(s) exist on this app:`);
        for (const w of existing) console.log(`  ${w.id}  ${w.url}`);
        console.log("  Delete stale tunnel URLs with: npm run paypal:webhook delete <id>");
      }

      const created = await createWebhook(url);
      console.log(`\n✓ Registered ${url}\n`);
      console.log("  Copy this into .env:\n");
      console.log(`  PAYPAL_WEBHOOK_ID=${created.id}\n`);
      return;
    }

    case "delete": {
      if (!argument) {
        console.error("\n✗ Usage: npm run paypal:webhook delete <webhookId>\n");
        process.exitCode = 1;
        return;
      }
      await deleteWebhook(argument);
      console.log(`\n✓ Deleted webhook ${argument}\n`);
      return;
    }

    default:
      console.error("\nUsage: npm run paypal:webhook <list|register|delete> [argument]\n");
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("\n✗ Failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
