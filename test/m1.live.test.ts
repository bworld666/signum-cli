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
import { ExitCode, exitCodeOf } from "../src/core/errors.ts";
import { SignumHttp } from "../src/core/http.ts";
import { HANDLE_PREFIX } from "../src/core/privacy.ts";
import { live } from "./live-config.ts";

const { url, token, lite, queryKey } = live ?? {};
const configured = live !== undefined;

// An isolated config dir: nothing from the developer's profile is read, and nothing is left behind.
const configDir = mkdtempSync(join(tmpdir(), "signum-live-"));
const extraDirs: string[] = [];
afterAll(() => { for (const d of [configDir, ...extraDirs]) rmSync(d, { recursive: true, force: true }); });

interface Result { code: ExitCode; out: string; err: string }

/** Run one command as a human at a terminal (or as an agent), capturing output in memory only. */
async function cli(argv: string[], opts: { agent?: boolean; anonymous?: boolean; configDir?: string } = {}): Promise<Result> {
  let out = "", err = "";
  const env: Record<string, string> = { SIGNUM_CONFIG_DIR: opts.configDir ?? configDir, SIGNUM_URL: url as string };
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
    // As cli.ts `report` prints it: the hint is where an error routes to help.
    const { CliError } = await import("../src/core/errors.ts");
    return { code: exitCodeOf(e), out, err: err + (e instanceof CliError ? `error: ${e.message}\n${e.hint ?? ""}` : String(e)) };
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

/**
 * A query this login's role is denied, from Signum.Authorization's `queryAllowed: "None"`
 * (AuthServer.cs:161-176). The name stays in memory. An administrator is denied nothing, so then
 * there is none, and exit 4 cannot be provoked against this app with this login.
 */
const deniedQuery: string | undefined = live === undefined ? undefined : await (async () => {
  const http = new SignumHttp({ baseUrl: live.url, token: live.token, onTokenRotated: () => {} });
  const res = await http.request<Record<string, { queryAllowed?: unknown }>>({ method: "GET", path: "api/reflection/types" });
  return Object.entries(res.body ?? {}).find(([, t]) => t.queryAllowed === "None")?.[0];
})();

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

  it("anonymously, an entity the view hides is exit 3 with the login command, never 'unknown' (AC-61.4)", async () => {
    // Signum.Authorization lists no entity to an anonymous caller (AuthServer.cs:70-75); an app
    // without the module lists them, and then they explain as usual.
    const types = await cli(["types", "--json"], { anonymous: true });
    const hidden = !(json(types) as Array<{ entityKind: unknown }>).some((t) => typeof t.entityKind === "string");
    const r = await cli(["explain", lite!.type], { anonymous: true });
    if (hidden) {
      expect(types.err.includes("no entity")).toBe(true);
      expect(r.code).toBe(ExitCode.NotAuthenticated);
      expect(r.err.includes("auth login")).toBe(true);
      expect(r.err.includes("unknown")).toBe(false);
    } else {
      expect(r.code).toBe(ExitCode.Ok);
    }
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

  // The filters below name the entity by its own id, so they need its type's own query.
  const ownQuery = (): boolean => queryKey === lite!.type || queryKey === lite!.type.replace(/Entity$/, "");
  const numericIds = (): boolean => /^\d+$/.test(lite!.id);
  const count = async (filter: string): Promise<number> => {
    const r = await cli(["query", queryKey as string, "--filter", filter, "--count", "--json"]);
    expect(r.code).toBe(ExitCode.Ok);
    return Number(String((json(r) as { count: unknown }).count));
  };

  it("filters (REQ-021): equality, grouping, negation and in select exactly what they say", async () => {
    if (!ownQuery()) return;
    const id = JSON.stringify(lite!.id); // quoted: a GUID is not a bareword, and a quoted number still converts
    expect(await count(`Id = ${id}`)).toBe(1);
    expect(await count(`(Id = ${id} or Id = ${id}) and Id != ${id}`)).toBe(0);
    expect(await count(`Id in ${id}`)).toBe(1);
  });

  it("order (REQ-021): --order -Id sorts descending", async () => {
    if (!numericIds()) return; // GUID order is the database's, not comparable here
    const rows = json(await cli(["query", queryKey as string, "--column", "Id", "--order", "-Id", "--top", "5", "--json"])) as Array<{ Id: unknown }>;
    const ids = rows.map((r) => Number(r.Id));
    expect(ids.every((v, i) => i === 0 || v <= ids[i - 1]!)).toBe(true);
  });

  it("a mistyped token or value is a usage error, never a server fault (REQ-051/052)", async () => {
    const token = await cli(["query", queryKey as string, "--filter", "NoSuchToken_ = 1", "--count"]);
    expect(token.code).toBe(ExitCode.Usage);
    expect(token.err.includes("invalid query token")).toBe(true);
    if (ownQuery() && numericIds()) {
      const value = await cli(["query", queryKey as string, "--filter", "Id > notanumber", "--count"]);
      expect(value.code).toBe(ExitCode.Usage);
    }
  });

  it("a missing entity is exit 5 with a message, never a bare status (REQ-051/052)", async () => {
    const missing = numericIds() ? "2147483647" : "00000000-0000-0000-0000-000000000000";
    const r = await cli(["get", lite!.type, missing]);
    expect(r.code).toBe(ExitCode.NotFound);
    expect(r.err.includes("not found")).toBe(true);
    expect(/\b(404|500)\b/.test(r.err)).toBe(false);
  });

  // The cache checks each start from an empty config dir of their own, so what they see is theirs.
  interface CacheEntry { scope: string; fetchedAt: string; lastModified: unknown; types: number }
  const freshDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "signum-live-cache-"));
    extraDirs.push(d);
    return d;
  };
  const cacheEntries = async (dir: string): Promise<CacheEntry[]> =>
    json(await cli(["cache", "show", "--json"], { configDir: dir })) as CacheEntry[];

  it("metadata cache (REQ-010): stored with Last-Modified, then revalidated with a 304", async () => {
    const dir = freshDir();
    expect((await cli(["types", "--json"], { configDir: dir })).code).toBe(ExitCode.Ok);
    const [first] = await cacheEntries(dir);
    expect(typeof first?.lastModified).toBe("string");
    const again = await cli(["types", "--json"], { configDir: dir });
    expect(again.code).toBe(ExitCode.Ok);
    // A failed refresh also leaves fetchedAt alone (the stale cache is used, with a warning), so
    // rule that out before reading an unchanged fetchedAt as the server's 304.
    expect(again.err.includes("could not refresh")).toBe(false);
    // The document is rewritten only on a 200, so an unchanged fetchedAt means the server said 304.
    const [second] = await cacheEntries(dir);
    expect(second?.fetchedAt === first?.fetchedAt).toBe(true);
  });

  it("metadata cache (REQ-010, AC-24.4): a warm cache answers offline, identically; a cleared one cannot", async () => {
    const dir = freshDir();
    const online = await cli(["types", "--json"], { configDir: dir });
    const offline = await cli(["types", "--offline", "--json"], { configDir: dir });
    expect(offline.code).toBe(ExitCode.Ok);
    expect(offline.out === online.out).toBe(true);
    expect((await cli(["cache", "clear", "--url", url as string], { configDir: dir })).code).toBe(ExitCode.Ok);
    expect((await cacheEntries(dir)).length).toBe(0);
    expect((await cli(["types", "--offline"], { configDir: dir })).code).toBe(ExitCode.Transport);
  });

  it("metadata cache (AC-24.3): anonymous and authenticated documents are kept apart", async () => {
    const dir = freshDir();
    await cli(["types", "--json"], { configDir: dir, anonymous: true });
    await cli(["types", "--json"], { configDir: dir });
    const scopes = (await cacheEntries(dir)).map((e) => e.scope).sort();
    expect(scopes).toEqual(["anon", "auth"]);
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

  // Skipped for a login that is denied nothing; run the suite once with a restricted one.
  it.skipIf(deniedQuery === undefined)("a query the role is denied is exit 4, from the CLI and from the server (REQ-051, AC-08.2)", async () => {
    const r = await cli(["query", deniedQuery as string]);
    expect(r.code).toBe(ExitCode.NotAuthorized);
    // The server's own answer, past the CLI's check: 403 + UnauthorizedAccessException, never exit 3.
    const http = new SignumHttp({ baseUrl: url as string, token: token as string, onTokenRotated: () => {} });
    const failure = await http.request({
      method: "POST",
      path: `api/query/lites/${encodeURIComponent(deniedQuery as string)}`,
      body: { queryKey: deniedQuery, filters: [], orders: [], count: 1 },
    }).then(() => undefined, (e: unknown) => e);
    expect(exitCodeOf(failure)).toBe(ExitCode.NotAuthorized);
  });
});
