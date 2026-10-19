/**
 * Lossless JSON numbers.
 *
 * `JSON.parse` turns `0.10` into `0.1` and rounds int64 ids past 2^53 — the second sends a write to a
 * DIFFERENT record, and shows the reader an id that does not exist. Kept separate from entity.ts so
 * the transport (http.ts) can parse losslessly without depending on the entity model.
 */

// ES2023's lib predates JSON.parse source access and JSON.rawJSON; Bun implements both.
declare global {
  interface JSON {
    rawJSON(text: string): unknown;
  }
}

/**
 * What a number IS, decided once at parse time from its member name.
 *
 * `identifier` is the one that matters: privacy recognises a Lite by its id, and a number that only
 * looked like a value would let an identity through unpseudonymized.
 */
export type JsonNumberType = "identifier" | "number";

/** The members whose numeric value is a primary key (`EntityJsonConverter.cs:268`, `MListJsonConverter.cs:76-77`). */
const IDENTIFIER_MEMBERS = new Set(["id", "rowId", "partitionId"]);

/** A JSON number kept as its exact source text, tagged with what it is. Serializes back verbatim. */
export class JsonNumber {
  constructor(readonly type: JsonNumberType, readonly text: string) {
    Object.freeze(this);
  }

  toJSON(): unknown {
    return JSON.rawJSON(this.text);
  }

  /** So `${id}` and `String(id)` give the digits, exactly as they would for a plain number. */
  toString(): string {
    return this.text;
  }
}

/** Parse keeping every number exact; `JSON.stringify` writes each back as it arrived. */
export function parseLossless(text: string): unknown {
  return JSON.parse(text, (key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined
      ? new JsonNumber(IDENTIFIER_MEMBERS.has(key) ? "identifier" : "number", context.source)
      : value,
  );
}

/**
 * The text of a Lite or entity id, or undefined when `id` is not one.
 *
 * The single answer to "is this an id", shared by privacy (identity detection) and output (Lite
 * keys) — two copies of it is how a lossless id once became invisible to the privacy walk.
 */
export function idText(id: unknown): string | undefined {
  if (typeof id === "string" || typeof id === "number") return String(id);
  if (id instanceof JsonNumber && id.type === "identifier") return id.text;
  return undefined;
}
