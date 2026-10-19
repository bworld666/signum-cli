/**
 * Lossless JSON numbers.
 *
 * `JSON.parse` turns `0.10` into `0.1` and rounds int64 ids past 2^53 — the second sends a write to a
 * DIFFERENT record. Kept separate from entity.ts so the transport (http.ts) can parse losslessly
 * without depending on the entity model.
 */

/** A JSON number kept as its exact source text, so `decimal` and int64 values survive. */
export interface RawJson {
  readonly rawJSON: string;
}

// ES2023's lib predates JSON.parse source access and JSON.rawJSON; Bun implements both.
declare global {
  interface JSON {
    rawJSON(text: string): RawJson;
    isRawJSON(value: unknown): value is RawJson;
  }
}

export function isRawJson(v: unknown): v is RawJson {
  return JSON.isRawJSON(v);
}

/** Parse keeping every number as its source text; `JSON.stringify` writes it back verbatim. */
export function parseLossless(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined ? JSON.rawJSON(context.source) : value,
  );
}
