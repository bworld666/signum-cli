/**
 * Named instances: a short slug for a target application's URL, so `signum -i renew types` works
 * instead of `signum --url https://renew.example/home types`.
 *
 * REQ-001 (connection profiles), first half: the slug → URL registry. A slug names a URL only; the
 * credential is still matched by URL (credentials.ts), so `-i renew` reaches the stored token
 * exactly when `--url <same url>` would.
 *
 * Stored as `instances.json` in the config directory, written owner-only like every other store:
 * a list of a customer's application URLs is not a secret, but it is nobody else's business either.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, writePrivate } from "./config.ts";
import { CliError, ExitCode, UsageError } from "./errors.ts";
import { nearest, normalizeUrl } from "./text.ts";

export interface Instance {
  slug: string;
  url: string;
}

interface InstancesFile {
  version: 1;
  instances: Record<string, { url: string }>;
}

/** Lowercase, starts with a letter or digit; short enough to type, never mistaken for a URL. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function instancesPath(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), "instances.json");
}

function read(env?: NodeJS.ProcessEnv): InstancesFile {
  const path = instancesPath(env);
  if (!existsSync(path)) return { version: 1, instances: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InstancesFile>;
    if (parsed.instances === null || typeof parsed.instances !== "object") throw new Error("no instances map");
    return { version: 1, instances: parsed.instances };
  } catch (err) {
    // Loud, not empty: a registry that silently reads as empty turns every `-i` into "unknown
    // instance", which sends the user hunting for a typo that is not there.
    throw new CliError(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`, ExitCode.Unexpected, {
      hint: "Fix or delete the file, then re-add instances with `signum instance add`.",
    });
  }
}

export function listInstances(env?: NodeJS.ProcessEnv): Instance[] {
  return Object.entries(read(env).instances)
    .filter(([, v]) => typeof v?.url === "string")
    .map(([slug, v]) => ({ slug, url: v.url }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The URL's first host label, e.g. `https://renew.example.org/home` → `renew`. */
export function slugFromUrl(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  // An IP address has no meaningful first label; `127` names nothing.
  if (/^[\d.]+$/.test(host) || host.includes(":")) return undefined;
  const first = host.split(".")[0] ?? "";
  return SLUG.test(first) ? first : undefined;
}

export function validateSlug(slug: string): string {
  const s = slug.toLowerCase();
  if (!SLUG.test(s)) {
    throw new UsageError(`invalid instance name '${slug}'`, {
      hint: "Use letters, digits, '-' and '_', starting with a letter or digit (at most 63 characters).",
    });
  }
  return s;
}

/** Check and canonicalise a URL before it is stored; only http(s) targets make sense. */
export function validateUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`not a URL: '${url}'`, { hint: "Give the full address, e.g. https://app.example.org" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(`unsupported scheme '${parsed.protocol}' in '${url}'`, { hint: "Use an http or https URL." });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    // A credential in the URL would be stored in plain text and echoed by `instance list`.
    throw new UsageError("the URL contains a user name or password", {
      hint: "Store the address only, then run `signum auth login -i <name> --with-token`.",
    });
  }
  return normalizeUrl(url);
}

export function addInstance(slug: string, url: string, env?: NodeJS.ProcessEnv): Instance {
  const file = read(env);
  const existing = file.instances[slug];
  if (existing !== undefined) {
    throw new UsageError(`instance '${slug}' already exists (${existing.url})`, {
      hint: `Remove it first with \`signum instance remove ${slug}\`, or choose another name.`,
    });
  }
  file.instances[slug] = { url };
  writePrivate(instancesPath(env), JSON.stringify(file, null, 2) + "\n");
  return { slug, url };
}

export function removeInstance(slug: string, env?: NodeJS.ProcessEnv): Instance | undefined {
  const file = read(env);
  const existing = file.instances[slug];
  if (existing === undefined) return undefined;
  delete file.instances[slug];
  writePrivate(instancesPath(env), JSON.stringify(file, null, 2) + "\n");
  return { slug, url: existing.url };
}

/** The URL a slug names, or a UsageError that says what does exist. */
export function resolveInstance(slug: string, env?: NodeJS.ProcessEnv): string {
  const all = listInstances(env);
  const found = all.find((i) => i.slug === slug.toLowerCase());
  if (found !== undefined) return found.url;
  const near = nearest(slug.toLowerCase(), all.map((i) => i.slug));
  throw new UsageError(`unknown instance '${slug}'`, {
    hint: all.length === 0
      ? "No instances are registered. Add one with `signum instance add <url> [name]`."
      : (near !== undefined ? `Did you mean '${near}'? ` : "") +
        `Registered: ${all.map((i) => i.slug).join(", ")}. See \`signum instance list\`.`,
  });
}
