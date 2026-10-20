/**
 * #111 acceptance against a REAL Signum application: a fetched entity, sent back unedited, is accepted
 * by `POST api/validateEntity`. That endpoint persists nothing, so this is safe to point at any app.
 *
 * Skipped unless a live target is named — see test/live-config.ts. For SIGNUM_LIVE_ENTITY, pick one
 * with an MList or embedded entity to exercise more of the converter.
 */

import { describe, expect, it } from "bun:test";
import { fetchEntity, serializeEntity, validateEntity } from "../src/core/entity.ts";
import { SignumHttp } from "../src/core/http.ts";
import { live } from "./live-config.ts";

const { url, token, lite } = live ?? {};
const configured = live !== undefined;

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
