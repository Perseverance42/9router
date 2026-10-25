import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ providerOverrides: { openrouter: { routing: { zdr: true, quantizations: ["bf16"] } } } }) }));
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: async () => ({ provider: "openrouter", model: "typesafe/jev-1.13" }) }));
vi.mock("../../src/sse/services/auth.js", () => ({ getProviderCredentials: async () => ({ apiKey: "test" }) }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_provider, credentials) => credentials }));

import { resolveSmartChoice } from "../../src/sse/services/systemoneRouter.js";

afterEach(() => vi.unstubAllGlobals());

it("enforces saved OpenRouter policy on internal Smart Router inference", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: {} })));
  vi.stubGlobal("fetch", fetchMock);
  await resolveSmartChoice({
    body: { messages: [{ role: "user", content: "Choose a model for coding" }] },
    models: ["openrouter/vendor/model-a", "openrouter/vendor/model-b"],
    routerModel: "openrouter/typesafe/jev-1.13",
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).provider).toEqual({ zdr: true, quantizations: ["bf16"] });
});
