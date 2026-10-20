/**
 * `signum instance add|list|remove` — named instances (REQ-001, first half).
 *
 * Purely local: nothing here touches the network, so an instance can be registered before the
 * application is reachable. A registered slug is then usable anywhere `--url` is, as `-i <slug>`.
 */

import type { Ctx } from "../core/ctx.ts";
import { ExitCode, NotFoundError, UsageError } from "../core/errors.ts";
import { renderDocument } from "../core/output.ts";
import {
  addInstance, instancesPath, listInstances, removeInstance, slugFromUrl, validateSlug, validateUrl,
} from "../core/instances.ts";

function isJson(ctx: Ctx): ctx is Ctx & { format: "json" | "ndjson" } {
  return ctx.format === "json" || ctx.format === "ndjson";
}

function add(ctx: Ctx): ExitCode {
  const [, rawUrl, rawSlug] = ctx.args.positionals;
  if (rawUrl === undefined) {
    throw new UsageError("`instance add` needs a URL", {
      hint: "signum instance add https://renew.example.org/home          (name: renew)\n" +
            "signum instance add https://app.example.org/home renew",
    });
  }
  const url = validateUrl(rawUrl);
  const derived = rawSlug ?? slugFromUrl(url);
  if (derived === undefined) {
    throw new UsageError(`cannot derive a name from '${rawUrl}'`, {
      hint: `Name it explicitly: signum instance add ${rawUrl} <name>`,
    });
  }
  const added = addInstance(validateSlug(derived), url, ctx.io.env);

  if (isJson(ctx)) {
    renderDocument(added, { format: ctx.format, write: ctx.io.out });
  } else {
    ctx.io.out(`added  ${added.slug}  ${added.url}\n`);
    ctx.io.err(`Use it with: signum -i ${added.slug} <command>\n`);
  }
  return ExitCode.Ok;
}

function list(ctx: Ctx): ExitCode {
  const all = listInstances(ctx.io.env);
  if (isJson(ctx)) {
    renderDocument(all, { format: ctx.format, write: ctx.io.out });
    return ExitCode.Ok;
  }
  if (all.length === 0) {
    // Empty is the normal first state, not an error.
    ctx.io.err("no instances registered\n");
    ctx.io.err("Add one with: signum instance add <url> [name]\n");
    return ExitCode.Ok;
  }
  const w = Math.max(...all.map((i) => i.slug.length));
  for (const i of all) ctx.io.out(`${i.slug.padEnd(w)}  ${i.url}\n`);
  return ExitCode.Ok;
}

function remove(ctx: Ctx): ExitCode {
  const slug = ctx.args.positionals[1];
  if (slug === undefined) {
    throw new UsageError("`instance remove` needs a name", { hint: "signum instance remove renew" });
  }
  const removed = removeInstance(slug.toLowerCase(), ctx.io.env);
  if (removed === undefined) {
    throw new NotFoundError(`unknown instance '${slug}'`, { hint: "See `signum instance list`." });
  }
  if (isJson(ctx)) renderDocument(removed, { format: ctx.format, write: ctx.io.out });
  else ctx.io.out(`removed  ${removed.slug}  ${removed.url}\n`);
  // The stored credential is matched by URL, not by name, so it is deliberately left alone.
  return ExitCode.Ok;
}

function path(ctx: Ctx): ExitCode {
  // Explicit format only, as in `cache path`: a shell substitution wants the bare string.
  const explicit = ctx.args.flags.output;
  if (explicit === "json" || explicit === "ndjson") {
    renderDocument({ path: instancesPath(ctx.io.env) }, { format: explicit, write: ctx.io.out });
  } else {
    ctx.io.out(instancesPath(ctx.io.env) + "\n");
  }
  return ExitCode.Ok;
}

export function runInstance(ctx: Ctx): ExitCode {
  const sub = ctx.args.positionals[0]?.toLowerCase();
  switch (sub) {
    case "list":
    case undefined: // bare `signum instance` is the harmless, informative one
      return list(ctx);
    case "add": return add(ctx);
    case "remove": return remove(ctx);
    case "path": return path(ctx);
    default:
      throw new UsageError(`unknown instance subcommand '${sub}'`, {
        hint: "Valid subcommands: add, list, remove, path.",
      });
  }
}
