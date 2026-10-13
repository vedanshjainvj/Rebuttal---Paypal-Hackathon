// ---------- CHUNKING ----------
// Evidence records are short and structured — a carrier scan, one order row, a
// support thread. Most produce a single chunk. Splitting matters only for long
// policy documents and transcripts.
//
// Boundaries are chosen at paragraph breaks first, then sentence ends, and only
// then mid-text. A citation that lands on half a sentence is useless to the
// merchant reviewing the packet, so boundary quality is a product concern, not
// just a retrieval one.

export interface ChunkOptions {
  /** Soft ceiling in characters. Chunks may run shorter at a clean boundary. */
  maxChars?: number;
  /** Carried from the end of the previous chunk to preserve context. */
  overlapChars?: number;
  /** Chunks shorter than this are merged backwards rather than kept alone. */
  minChars?: number;
}

const DEFAULTS = {
  maxChars: 900,
  overlapChars: 150,
  minChars: 120,
} as const;

/** Splits on blank lines, keeping list items and headings attached to context. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Conservative sentence split: avoids breaking on common abbreviations. */
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function tailOverlap(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return "";
  const tail = text.slice(-overlapChars);
  // Start the overlap at a sentence boundary when one is nearby.
  const boundary = tail.search(/(?<=[.!?])\s+/);
  return boundary >= 0 ? tail.slice(boundary).trim() : tail.trim();
}

/** Hard split for a single run of text longer than maxChars with no breaks. */
function splitOversized(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars).trim());
  }
  return out.filter(Boolean);
}

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const overlapChars = options.overlapChars ?? DEFAULTS.overlapChars;
  const minChars = options.minChars ?? DEFAULTS.minChars;

  const normalised = text.replace(/\r\n/g, "\n").trim();
  if (!normalised) return [];
  if (normalised.length <= maxChars) return [normalised];

  // Flatten to units that are each guaranteed to fit.
  const units: string[] = [];
  for (const paragraph of splitParagraphs(normalised)) {
    if (paragraph.length <= maxChars) {
      units.push(paragraph);
      continue;
    }
    for (const sentence of splitSentences(paragraph)) {
      if (sentence.length <= maxChars) units.push(sentence);
      else units.push(...splitOversized(sentence, maxChars));
    }
  }

  // Greedily pack units, carrying overlap across the seam.
  const chunks: string[] = [];
  let current = "";

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;

    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);
    const overlap = tailOverlap(current, overlapChars);
    current = overlap ? `${overlap}\n\n${unit}` : unit;
  }

  if (current) chunks.push(current);

  // A stranded tail fragment reads badly as a citation. Fold it backwards when
  // doing so does not blow the ceiling by much.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const previous = chunks[chunks.length - 2];
    if (last.length < minChars && previous.length + last.length <= maxChars * 1.3) {
      chunks.splice(chunks.length - 2, 2, `${previous}\n\n${last}`);
    }
  }

  return chunks;
}
