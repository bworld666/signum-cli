/**
 * #111 acceptance against a REAL Signum application: a fetched entity, sent back unedited, is accepted
 * by `POST api/validateEntity`. That endpoint persists nothing, so this is safe to point at any app.
 *
 * Skipped unless all three are set (the token comes from the environment, never from a file):
 *   SIGNUM_LIVE_URL     base URL of the app
 *   SIGNUM_LIVE_TOKEN   a bearer token for it
 *   SIGNUM_LIVE_ENTITY  a Lite key to fetch, e.g. "Role;1" — pick one with an MList or embedded
 *                       entity to exercise more of the converter
 */

import { describe, expect, it } from "bun:test";
import { fetchEntity, serializeEntity, validateEntity } from "../src/core/entity.ts";
import { SignumHttp } from "../src/core/http.ts";
import { parseLiteKey } from "../src/core/text.ts";

const url = process.env["SIGNUM_LIVE_URL"];
const token = process.env["SIGNUM_LIVE_TOKEN"];
const lite = parseLiteKey(process.env["SIGNUM_LIVE_ENTITY"] ?? "");
const configured = url !== undefined && url !== "" && token !== undefined && token !== "" && lite !== undefined;

describe.skipIf(!configured)("entity round trip against a live app (#111)", () => {
  it("a fetched entity, unedited, is accepted by api/validateEntity", async () => {
    // Rotation is not persisted here: a live test must not write to the developer's credential store.
    const http = new SignumHttp({ baseUrl: url as string, token, onTokenRotated: () => {} });
    const entity = await fetchEntity(http, lite!.type, lite!.id);
    const payload = serializeEntity(entity);
    expect(payload.modified).toBe(false);
    await validateEntity(http, payload);
  });
});
