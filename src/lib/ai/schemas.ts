import { z } from "zod";

// ---------- DRAFTING OUTPUT ----------
// Two representations of the same contract, deliberately kept side by side:
// a Zod schema that validates what came back, and an OpenAPI-subset schema
// that constrains what the model may produce.
//
// Both are needed. Provider-side schemas reduce malformed output but do not
// guarantee it, and OpenAI and Gemini accept different schema dialects. The
// Zod parse is the only check that runs identically for every provider.

export const draftedClaimSchema = z.object({
  /**
   * One assertion, in the merchant's voice, that PayPal can act on.
   * Deliberately not a paragraph: each claim is cited independently.
   */
  text: z.string().min(10).max(400),
  /** Id of the retrieved chunk this claim rests on. Validated against the set. */
  chunkId: z.string().min(1),
  /**
   * Verbatim span copied from that chunk. The grounding check confirms it
   * really appears there, which is what makes a fabricated citation fail
   * rather than merely look suspicious.
   */
  quote: z.string().min(10).max(600),
});

export const draftResultSchema = z.object({
  claims: z.array(draftedClaimSchema).min(1).max(8),
  /** Prose submitted to PayPal as the evidence note. */
  narrative: z.string().min(40).max(2000),
  winScore: z.number().int().min(0).max(100),
  scoreReasons: z.array(z.string().min(5).max(200)).min(1).max(5),
});

export type DraftedClaim = z.infer<typeof draftedClaimSchema>;
export type DraftResult = z.infer<typeof draftResultSchema>;

// ---------- PROVIDER SCHEMA ----------
// OpenAPI 3.0 subset. No $ref, no oneOf, no additionalProperties — Gemini
// rejects all three. propertyOrdering is a Gemini extension that measurably
// improves adherence; OpenAI ignores unknown keys.

export const DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "One factual assertion supporting the merchant, under 400 characters.",
          },
          chunkId: {
            type: "string",
            description: "The chunk_id of the record this claim is taken from. Copy it exactly.",
          },
          quote: {
            type: "string",
            description:
              "A span copied word for word from that chunk's text. Do not paraphrase, " +
              "reword, or correct it. It is checked character by character.",
          },
        },
        required: ["text", "chunkId", "quote"],
        propertyOrdering: ["text", "chunkId", "quote"],
      },
    },
    narrative: {
      type: "string",
      description:
        "A short note to PayPal summarising the merchant's position. Plain, factual, " +
        "no salesmanship. 60 to 300 words.",
    },
    winScore: {
      type: "integer",
      description: "Probability from 0 to 100 that this evidence resolves the dispute favourably.",
    },
    scoreReasons: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: { type: "string" },
      description:
        "Short reasons for the score. Include weaknesses when the evidence is thin — " +
        "an honest low score is more useful than an optimistic one.",
    },
  },
  required: ["claims", "narrative", "winScore", "scoreReasons"],
  propertyOrdering: ["claims", "narrative", "winScore", "scoreReasons"],
} as const;
