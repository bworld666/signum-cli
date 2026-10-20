/**
 * Where the live suites point, shared by every `*.live.test.ts`.
 *
 * Two ways to name the app, both explicit:
 *   SIGNUM_LIVE_INSTANCE  a registered instance (`signum instance add`) whose stored login is used —
 *                         the token is read from the credential store in memory, never printed
 *   SIGNUM_LIVE_URL + SIGNUM_LIVE_TOKEN   the app's URL and a bearer token, from the environment
 *
 * And what to read:
 *   SIGNUM_LIVE_ENTITY    a Lite key that exists, e.g. "Role;1". Optional: without it the first
 *                         entity of SIGNUM_LIVE_QUERY (default "Role", the least personal type every
 *                         authorized Signum app has) is used — its id stays in memory, never printed.
 *   SIGNUM_LIVE_QUERY     optional query key; defaults to the entity's type
 *
 * Nothing is set → the suites skip. Something is set but unusable → this throws and says why, so a
 * misconfigured run fails loudly instead of skipping as if nothing had been asked for.
 */

import { loadCredential } from "../src/core/credentials.ts";
import { SignumHttp } from "../src/core/http.ts";
import { resolveInstance } from "../src/core/instances.ts";
import { parseLiteKey } from "../src/core/text.ts";

export interface LiveConfig {
  url: string;
  token: string;
  lite: { type: string; id: string };
  queryKey: string;
}

const env = process.env;
const instance = env["SIGNUM_LIVE_INSTANCE"] || undefined;
const asked = instance !== undefined || (env["SIGNUM_LIVE_URL"] || undefined) !== undefined;

async function resolve(): Promise<LiveConfig> {
  let url: string, token: string;
  if (instance !== undefined) {
    url = resolveInstance(instance, env);
    const stored = loadCredential(url, env)?.credential.token;
    if (stored === undefined) throw new Error(`instance '${instance}' has no stored login — run \`signum -i ${instance} auth login\``);
    token = stored;
  } else {
    url = env["SIGNUM_LIVE_URL"] as string;
    token = env["SIGNUM_LIVE_TOKEN"] ?? "";
    if (token === "") throw new Error("SIGNUM_LIVE_URL is set but SIGNUM_LIVE_TOKEN is empty (or use SIGNUM_LIVE_INSTANCE)");
  }

  const given = env["SIGNUM_LIVE_ENTITY"] || undefined;
  if (given !== undefined) {
    const lite = parseLiteKey(given);
    if (lite === undefined) throw new Error("SIGNUM_LIVE_ENTITY is not a Lite key like \"Role;1\"");
    return { url, token, lite, queryKey: env["SIGNUM_LIVE_QUERY"] || lite.type };
  }

  const queryKey = env["SIGNUM_LIVE_QUERY"] || "Role";
  const http = new SignumHttp({ baseUrl: url, token, onTokenRotated: () => {} });
  const res = await http.request<unknown>({
    method: "POST",
    path: `api/query/lites/${encodeURIComponent(queryKey)}`,
    body: { queryKey, filters: [], orders: [], count: 1 },
  });
  const first = Array.isArray(res.body) ? (res.body[0] as { EntityType?: unknown; id?: unknown } | undefined) : undefined;
  if (typeof first?.EntityType !== "string" || first.id === undefined) {
    throw new Error(`query '${queryKey}' returned no entity to read — set SIGNUM_LIVE_ENTITY`);
  }
  return { url, token, lite: { type: first.EntityType, id: String(first.id) }, queryKey };
}

/** The live target, or undefined when no live run was asked for. */
export const live: LiveConfig | undefined = asked ? await resolve() : undefined;
