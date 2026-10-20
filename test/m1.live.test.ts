/**
 * m1 against a REAL Signum application — the automated half of docs/reference/live-verification-runbook.md.
 *
 * Every m1 requirement stays open until it has run against a live app (REQ-077). This suite runs each
 * m1 command in-process against one and checks SHAPES, never values: every assertion compares a
 * boolean, a type name or a count, so a failure cannot print a row, a name or an id into a log
 * (runbook rule 2). Read only — nothing here sends a write.
 *
 * Skipped unless a live target is named — see test/live-config.ts for the variables:
 *
 *   SIGNUM_LIVE_INSTANCE=renew ./node_modules/.bin/bun test test/m1.live.test.ts
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Io } from "../src/core/ctx.ts";
import { ExitCode } from "../src/core/errors.ts";
import { HANDLE_PREFIX } from "../src/core/privacy.ts";
import { live } from "./live-config.ts";

const { url, token, lite, queryKey } = live ?? {};
const configured = live !== undefined;

// An isolated config dir: nothing from the developer's profile is read, and nothing is left behind.
const configDir = mkdtempSync(join(tmpdir(), "signum-live-"));
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

interface Result { code: ExitCode; out: string; err: string }

/** Run one command as a human at a terminal (or as an agent), capturing output in memory only. */
async function cli(argv: string[], opts: { agent?: boolean; anonymous?: boolean } = {}): Promise<Result> {
  let out = "", err = "";
  const env: Record<string, string> = { SIGNUM_CONFIG_DIR: configDir, SIGNUM_URL: url as string };
  if (opts.anonymous !== true) env["SIGNUM_TOKEN"] = token as string;
  if (opts.agent === true) env["CLAUDECODE"] = "1";
  const io: Io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdoutIsTty: opts.agent !== true,
    stdinIsTty: true,
    env: env as NodeJS.ProcessEnv,
    readStdin: async () => "",
  };
  try {
    return { code: await run(argv, io), out, err };
  } catch (e) {
    const { exitCodeOf } = await import("../src/core/errors.ts");
    return { code: exitCodeOf(e), out, err: err + String(e) };
  }
}

/** Parse JSON output; a failure reports only that it was not JSON, never the text. */
function json(r: Result): unknown {
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Error(`output was not JSON (exit ${r.code}, ${r.out.length} chars)`);
  }
}

const KINDS = new Set(["Entity", "Enum", "Message", "Query", "SymbolContainer"]);

describe.skipIf(!configured)("m1 against a live app (REQ-077)", () => {
  it("version: the target is reachable", async () => {
    const r = json(await cli(["version", "--json"])) as { target: { reachable: boolean; appVersion: unknown } };
    expect(r.target.reachable).toBe(true);
    // Reported, not required: VersionFilterAttribute can be removed by an app.
    expect(["string", "object"]).toContain(typeof r.target.appVersion);
  });

  it("auth status (REQ-007): authenticated as a user, token never printed", async () => {
    const res = await cli(["auth", "status", "--json"]);
    const r = json(res) as { authenticated: boolean; user: unknown; credential: string };
    expect(r.authenticated).toBe(true);
    expect(typeof r.user).toBe("string");
    expect(r.credential).toBe("environment");
    expect((res.out + res.err).includes(token as string)).toBe(false);
  });

  it("types (REQ-011): kind is KindOfType, entityKind is separate, the entity's type is listed with one", async () => {
    const types = json(await cli(["types", "--json"])) as Array<{ name: string; kind: unknown; entityKind: unknown }>;
    expect(types.length > 0).toBe(true);
    expect(types.every((t) => KINDS.has(String(t.kind)))).toBe(true);
    // Only an IEntity has an entity kind; model and embedded types are kind Entity without one.
    expect(types.filter((t) => t.entityKind !== null).every((t) => t.kind === "Entity" && typeof t.entityKind === "string")).toBe(true);
    const own = types.find((t) => t.name.replace(/Entity$/, "") === lite!.type.replace(/Entity$/, ""));
    expect(typeof own?.entityKind).toBe("string");
  });

  it("types anonymously: discovery needs no credential (AC-61.4)", async () => {
    expect((await cli(["types", "--json"], { anonymous: true })).code).toBe(ExitCode.Ok);
  });

  it("queries and explain (REQ-011, REQ-012): the query is offered and its tokens resolve", async () => {
    const queries = json(await cli(["queries", "--json"])) as Array<{ name: string }>;
    expect(queries.length > 0).toBe(true);
    const ex = json(await cli(["explain", queryKey as string, "--json"])) as { queryTokens: unknown[] | null };
    expect(Array.isArray(ex.queryTokens)).toBe(true);
  });

  it("query (REQ-020/022/024): rows de-intern, the count is a number", async () => {
    const rows = await cli(["query", queryKey as string, "--top", "2", "--json"]);
    expect(rows.code).toBe(ExitCode.Ok);
    const parsed = json(rows) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length <= 2).toBe(true);
    const count = json(await cli(["query", queryKey as string, "--count", "--json"])) as { count: unknown };
    expect(Number.isFinite(Number(String(count.count)))).toBe(true);
  });

  it("query --lites and --entities (REQ-024): the variant endpoints answer in their shapes", async () => {
    const lites = json(await cli(["query", queryKey as string, "--lites", "--top", "2", "--json"])) as Array<Record<string, unknown>>;
    expect(lites.every((l) => typeof l["EntityType"] === "string" && l["id"] !== undefined)).toBe(true);
    const entities = json(await cli(["query", queryKey as string, "--entities", "--top", "1", "--json"])) as Array<Record<string, unknown>>;
    expect(entities.every((e) => typeof e["Type"] === "string" && typeof e["ticks"] === "string")).toBe(true);
  });

  it("get (REQ-030): the entity is retrieved with Type, id and a string ticks; --exists agrees", async () => {
    const doc = json(await cli(["get", `${lite!.type};${lite!.id}`, "--json"])) as Record<string, unknown>;
    expect(typeof doc["Type"]).toBe("string");
    expect(typeof doc["ticks"]).toBe("string");
    const exists = json(await cli(["get", lite!.type, lite!.id, "--exists", "--json"])) as { exists: boolean };
    expect(exists.exists).toBe(true);
  });

  it("under an AI caller (REQ-056/057): data comes back pseudonymized, the identity as a handle", async () => {
    const r = await cli(["get", `${lite!.type};${lite!.id}`, "--json"], { agent: true });
    expect(r.code).toBe(ExitCode.Ok);
    const doc = json(r) as Record<string, unknown>;
    expect(String(doc["id"]).startsWith(HANDLE_PREFIX)).toBe(true);
    expect(r.err.includes("pseudonymized")).toBe(true);
  });

  it("a bad token is exit 3 with the handoff steps, never a 401 (AC-08.1, AC-12.11)", async () => {
    let out = "", err = "";
    const io: Io = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdoutIsTty: true, stdinIsTty: true,
      env: { SIGNUM_CONFIG_DIR: configDir, SIGNUM_URL: url as string, SIGNUM_TOKEN: "deliberately-invalid" } as unknown as NodeJS.ProcessEnv,
      readStdin: async () => "",
    };
    const code = await run(["query", queryKey as string, "--top", "1"], io).catch(async (e) => {
      const { exitCodeOf, CliError } = await import("../src/core/errors.ts");
      err += e instanceof CliError ? `${e.message}\n${e.hint ?? ""}` : String(e);
      return exitCodeOf(e);
    });
    expect(code).toBe(ExitCode.NotAuthenticated);
    expect(err.includes("401")).toBe(false);
    expect(out).toBe("");
  });
});
