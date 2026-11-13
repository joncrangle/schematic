import { describe, expect, it, vi } from "vitest";
import {
  loadCompiledServer,
  requireCompiledServer,
  startBunServer,
  type CompiledServer,
} from "../../scripts/lib/server-bootstrap";

describe("self-hosted server bootstrap", () => {
  it("requires the generated default export and its scheduler hook", () => {
    const fetch = vi.fn<CompiledServer["fetch"]>();
    const initSchedulers = vi.fn();

    expect(requireCompiledServer({ default: { fetch, initSchedulers } })).toEqual({
      fetch,
      initSchedulers,
    });
  });

  it("fails when the compiled entry has no scheduler hook", () => {
    expect(() => requireCompiledServer({ default: { fetch: vi.fn() } })).toThrow(
      "missing initSchedulers()",
    );
  });

  it("reports a missing compiled entry instead of continuing without startup", async () => {
    await expect(
      loadCompiledServer(async () => {
        throw new Error("module not found");
      }),
    ).rejects.toThrow('Unable to load compiled server entry "dist/worker/index.js"');
  });

  it("initializes schedulers before serving the compiled fetch handler", () => {
    const calls: string[] = [];
    const fetch = vi.fn<CompiledServer["fetch"]>();
    const app: CompiledServer = {
      fetch,
      initSchedulers: () => calls.push("initSchedulers"),
    };
    const serve = vi.fn(() => calls.push("serve"));

    startBunServer(app, { serve }, { PORT: "4310", HOST: "127.0.0.1" });

    expect(calls).toEqual(["initSchedulers", "serve"]);
    expect(serve).toHaveBeenCalledWith({ fetch, port: 4310, hostname: "127.0.0.1" });
  });
});
