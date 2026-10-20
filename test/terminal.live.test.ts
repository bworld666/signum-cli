/**
 * REQ-050 against a REAL terminal: the CLI runs as a child process, once on a pseudo-terminal and
 * once into a pipe, against a live app.
 *
 * The in-process suites inject `stdoutIsTty`, so they prove what the CLI does with the answer, never
 * that it asks the right question. Only a real pty does: `process.stdout.isTTY` read in `main()`.
 *
 * The child gets a clean environment: no agent marker, so it is the human (or the script) REQ-050
 * describes, and its rows are never pseudonymized. They stay in memory, and every assertion compares
 * a boolean or a code, so a failure cannot print one (runbook rule 2). Read only.
 *
 *   SIGNUM_LIVE_INSTANCE=renew ./node_modules/.bin/bun test test/terminal.live.test.ts
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../src/core/errors.ts";
import { live } from "./live-config.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const home = mkdtempSync(join(tmpdir(), "signum-live-tty-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function childEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin", HOME: home, SIGNUM_CONFIG_DIR: home,
    SIGNUM_URL: live?.url ?? "", SIGNUM_TOKEN: live?.token ?? "", ...extra,
  };
}

/** Run on a pty. stdout and stderr share it, so `quiet` sends stderr to /dev/null to tell them apart. */
async function inTerminal(argv: string[], opts: { env?: Record<string, string>; quiet?: boolean } = {}): Promise<{ code: number; screen: string }> {
  let screen = "";
  const decoder = new TextDecoder();
  let closed!: () => void;
  const eof = new Promise<void>((resolve) => { closed = resolve; });
  const cmd = opts.quiet === true
    ? ["/bin/sh", "-c", 'exec "$@" 2>/dev/null', "sh", process.execPath, CLI, ...argv]
    : [process.execPath, CLI, ...argv];
  const proc = Bun.spawn(cmd, {
    env: childEnv(opts.env ?? {}),
    terminal: {
      cols: 200, rows: 50,
      data(_t, chunk) { screen += decoder.decode(chunk, { stream: true }); },
      exit() { closed(); },
    },
  });
  const code = await proc.exited;
  await eof;
  // A pty turns every \n into \r\n; undo it so the screen reads like a pipe's output.
  return { code, screen: screen.replaceAll("\r\n", "\n") };
}

async function piped(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...argv], { env: childEnv({}), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

const ESC = "\x1b[";
const isJson = (s: string): boolean => { try { JSON.parse(s); return true; } catch { return false; } };
/** The table's second line: dashes under each column. */
const hasRule = (s: string): boolean => /^-+( +-+)*$/.test(s.split("\n")[1] ?? "");

describe.skipIf(live === undefined || process.platform === "win32")("output in a real terminal (REQ-050)", () => {
  const key = live?.queryKey ?? "";

  it("at a terminal, `query` is an aligned table whose header is bold", async () => {
    const r = await inTerminal(["query", key, "--top", "3"]);
    expect(r.code).toBe(ExitCode.Ok);
    expect(r.screen.startsWith(`${ESC}1m`)).toBe(true);
    expect(hasRule(r.screen)).toBe(true);
    expect(isJson(r.screen)).toBe(false);
  });

  it("NO_COLOR and --no-color drop the colour, never the table", async () => {
    for (const r of [
      await inTerminal(["query", key, "--top", "3"], { env: { NO_COLOR: "1" } }),
      await inTerminal(["query", key, "--top", "3", "--no-color"]),
    ]) {
      expect(r.code).toBe(ExitCode.Ok);
      expect(r.screen.includes(ESC)).toBe(false);
      expect(hasRule(r.screen)).toBe(true);
    }
  });

  it("an explicit format wins at a terminal: --json is JSON, -o csv is CSV, neither coloured", async () => {
    const j = await inTerminal(["query", key, "--top", "3", "--json"]);
    expect(isJson(j.screen)).toBe(true);
    const c = await inTerminal(["types", "-o", "csv"]);
    expect(c.screen.startsWith("name,kind,entityKind,")).toBe(true);
    expect(j.screen.includes(ESC)).toBe(false);
    expect(c.screen.includes(ESC)).toBe(false);
  });

  it("into a pipe, `query` and `types` are JSON; asking for a table gets one, uncoloured", async () => {
    for (const argv of [["query", key, "--top", "3"], ["types"]]) {
      const r = await piped(argv);
      expect(r.code).toBe(ExitCode.Ok);
      expect(isJson(r.out)).toBe(true);
    }
    const t = await piped(["query", key, "--top", "3", "-o", "table"]);
    expect(hasRule(t.out)).toBe(true);
    expect(t.out.includes(ESC)).toBe(false);
  });

  it("an error goes to stderr and never to stdout, at a terminal and into a pipe", async () => {
    const tty = await inTerminal(["query", key, "--column", "NoSuchToken"], { quiet: true });
    expect(tty.code).toBe(ExitCode.Usage);
    expect(tty.screen).toBe("");
    const pipe = await piped(["query", key, "--column", "NoSuchToken"]);
    expect(pipe.code).toBe(ExitCode.Usage);
    expect(pipe.out).toBe("");
    expect(pipe.err.startsWith("error: ")).toBe(true);
  });
});
