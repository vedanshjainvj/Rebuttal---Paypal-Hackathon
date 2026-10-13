import "dotenv/config";

// ---------- AI DOCTOR ----------
// Lists the models this API key can actually reach and what each supports.
// Model availability differs by key, region and API version, so guessing a
// model name from documentation is how you get a 404 at the worst moment.

interface ModelInfo {
  name: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("\n✗ GEMINI_API_KEY is not set\n");
    process.exitCode = 1;
    return;
  }

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: { "x-goog-api-key": key },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    console.error(`\n✗ ListModels failed (HTTP ${response.status})`);
    console.error((await response.text()).slice(0, 600), "\n");
    process.exitCode = 1;
    return;
  }

  const { models = [] } = (await response.json()) as { models?: ModelInfo[] };

  const embedders = models.filter((m) =>
    m.supportedGenerationMethods?.some((s) => s.toLowerCase().includes("embed")),
  );
  const generators = models.filter((m) =>
    m.supportedGenerationMethods?.includes("generateContent"),
  );

  console.log(`\nembedding models (${embedders.length})`);
  for (const m of embedders) {
    console.log(`  ${m.name.replace("models/", "")}`);
    console.log(`    methods: ${m.supportedGenerationMethods?.join(", ")}`);
  }

  console.log(`\ngeneration models (${generators.length})`);
  for (const m of generators.slice(0, 20)) {
    console.log(`  ${m.name.replace("models/", "")}`);
  }

  console.log(`\nconfigured in .env`);
  console.log(`  GEMINI_EMBEDDING_MODEL = ${process.env.GEMINI_EMBEDDING_MODEL ?? "(default)"}`);
  console.log(`  GEMINI_MODEL           = ${process.env.GEMINI_MODEL ?? "(default)"}\n`);
}

main().catch((error) => {
  console.error("\n✗ Failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
