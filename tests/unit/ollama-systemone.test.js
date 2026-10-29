import { afterEach, describe, expect, it, vi } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { buildSystemoneUrl, handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";

const localCfg = PROVIDER_MEDIA["ollama-local"]?.systemoneConfig;

describe("buildSystemoneUrl", () => {
  it("uses the registry URL when no host is saved", () => {
    expect(buildSystemoneUrl(undefined, localCfg)).toBe("http://localhost:11434/v1/systemone");
  });

  it.each([
    ["http://localhost:11434", "http://localhost:11434/v1/systemone"],
    ["http://localhost:11434/", "http://localhost:11434/v1/systemone"],
    ["http://localhost:11434/v1", "http://localhost:11434/v1/systemone"],
    ["http://localhost:11434/v1/", "http://localhost:11434/v1/systemone"],
    ["http://localhost:11434/v1/systemone", "http://localhost:11434/v1/systemone"],
    ["http://localhost:11434/v1/systemone/", "http://localhost:11434/v1/systemone"],
  ])("joins saved host %s", (host, expected) => {
    expect(buildSystemoneUrl(host, localCfg)).toBe(expected);
  });

  it("keeps an override untouched when the provider defines no path", () => {
    expect(buildSystemoneUrl("https://proxy.example/custom", { baseUrl: "https://x/y" })).toBe("https://proxy.example/custom");
  });
});

describe("Ollama System One providers", () => {
  it.each(["ollama", "ollama-local"])("%s supports System One", (id) => {
    const entry = REGISTRY.find((e) => e.id === id);
    expect(entry.serviceKinds).toContain("systemone");
    expect(entry.serviceKinds).toContain("llm");
    expect(PROVIDER_MEDIA[id]?.systemoneConfig?.baseUrl).toMatch(/\/v1\/systemone$/);
  });

  it("lists clef models as System One kind", () => {
    const kinds = (id) => Object.fromEntries(REGISTRY.find((e) => e.id === id).models.map((m) => [m.id, m.kind]));
    expect(kinds("ollama")).toMatchObject({ clef: "systemone", "clef-flash": "systemone", "clef:cloud": "systemone" });
    expect(kinds("ollama-local")).toMatchObject({ clef: "systemone", "clef-flash": "systemone" });
  });
});

describe("handleSystemoneCore request", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function call(provider, model, credentials) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleSystemoneCore({
      body: { state: "s", questions: { q: { type: "noul", instructions: "i" } } },
      modelInfo: { provider, model },
      credentials,
    });
    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    return { url, headers: init.headers, body: JSON.parse(init.body) };
  }

  it("posts to <host>/v1/systemone for Ollama Local without OpenCode header", async () => {
    const r = await call("ollama-local", "clef-flash", { providerSpecificData: { baseUrl: "http://192.168.1.5:11434/" } });
    expect(r.url).toBe("http://192.168.1.5:11434/v1/systemone");
    expect(r.headers["x-opencode-session"]).toBeUndefined();
    expect(r.body.model).toBe("clef-flash");
  });

  it("posts to ollama.com with Bearer auth for Ollama Cloud", async () => {
    const r = await call("ollama", "clef:cloud", { apiKey: "key123" });
    expect(r.url).toBe("https://ollama.com/v1/systemone");
    expect(r.headers.Authorization).toBe("Bearer key123");
    expect(r.headers["x-opencode-session"]).toBeUndefined();
  });

  it("propagates cancellation to fetch and suppresses success after body cancellation", async () => {
    const parent = new AbortController();
    const reason = new Error("Fusion sibling failed");
    const onRequestSuccess = vi.fn();
    let upstreamSignal;
    vi.stubGlobal("fetch", vi.fn(async (_url, { signal }) => {
      upstreamSignal = signal;
      return { ok: true, json: async () => { parent.abort(reason); return { ok: true }; } };
    }));
    await expect(handleSystemoneCore({
      body: { state: "s", questions: { q: {} } },
      modelInfo: { provider: "ollama-local", model: "clef" }, credentials: {},
      signal: parent.signal, onRequestSuccess,
    })).rejects.toBe(reason);
    expect(upstreamSignal.aborted).toBe(true);
    expect(upstreamSignal.reason).toBe(reason);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("does not fetch after cancellation", async () => {
    const parent = new AbortController();
    parent.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(handleSystemoneCore({ signal: parent.signal })).rejects.toBe(parent.signal.reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends the session header to OpenCode Zen", async () => {
    const r = await call("opencode-zen", "jev-1.13", { apiKey: "k" });
    expect(r.headers["x-opencode-session"]).toMatch(/^ses_/);
  });
});
