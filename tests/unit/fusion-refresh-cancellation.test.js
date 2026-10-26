import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), refreshCredentials: vi.fn(), refreshTokenByProvider: vi.fn(),
  refreshCopilotToken: vi.fn(), getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(), getProviderConnections: vi.fn(),
  getSettings: vi.fn(), getProxyPools: vi.fn(), resolveConnectionProxyConfig: vi.fn(),
  shouldRefreshCredentials: vi.fn(), getProjectIdForConnection: vi.fn(),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", async (original) => ({
  ...await original(), refreshTokenByProvider: mocks.refreshTokenByProvider,
  refreshCopilotToken: mocks.refreshCopilotToken,
}));
vi.mock("../../open-sse/services/oauthCredentialManager.js", async (original) => ({
  ...await original(), shouldRefreshCredentials: mocks.shouldRefreshCredentials,
}));
vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings, getProxyPools: mocks.getProxyPools,
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig, pickProxyPoolId: vi.fn(),
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: vi.fn(), getAntigravityModelQuota: vi.fn(),
}));
vi.mock("../../open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: mocks.getProjectIdForConnection,
  invalidateProjectId: vi.fn(), removeConnection: vi.fn(),
}));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({
  noAuth: false, execute: mocks.execute, refreshCredentials: mocks.refreshCredentials,
}) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {},
  logProviderResponse() {}, logConvertedResponse() {}, logError() {},
}) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest() {}, appendRequestLog: async () => {}, saveRequestDetail: async () => {},
}));
const { refreshWithRetry } = await import("../../open-sse/services/tokenRefresh.js");
const { checkAndRefreshToken, updateProviderCredentials } = await import("../../src/sse/services/tokenRefresh.js");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const credentials = () => ({ connectionId: "account", refreshToken: "old", accessToken: "access" });
const reasons = [
  ["client", () => new DOMException("client disconnected", "AbortError")],
  ["sibling", () => new Error("sibling completed")],
];
const options = (signal, callback) => ({
  body: { messages: [{ role: "user", content: "Question" }], stream: false },
  modelInfo: { provider: "anthropic", model: "claude-sonnet-4" },
  credentials: credentials(), sourceFormatOverride: "openai", internal: true,
  externalSignal: signal, onCredentialsRefreshed: callback,
  log: { debug() {}, info() {}, warn() {} },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnectionById.mockResolvedValue(null);
  mocks.updateProviderConnection.mockResolvedValue({ id: "account" });
  mocks.getProviderConnections.mockResolvedValue([{ id: "account", apiKey: "key" }]);
  mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.shouldRefreshCredentials.mockReturnValue(true);
  mocks.execute.mockResolvedValue({ response: new Response("unauthorized", { status: 401 }), transformedBody: {} });
});
afterEach(() => { vi.useRealTimers(); });

describe.each(reasons)("%s cancellation", (_, reasonFactory) => {
  it("does not start refresh or credential selection after cancellation", async () => {
    const controller = new AbortController();
    const reason = reasonFactory();
    controller.abort(reason);
    const refresh = vi.fn();
    await expect(refreshWithRetry(refresh, 3, null, controller.signal)).rejects.toBe(reason);
    await expect(checkAndRefreshToken("codex", credentials(), { signal: controller.signal })).rejects.toBe(reason);
    await expect(getProviderCredentials("codex", null, null, { signal: controller.signal })).rejects.toBe(reason);
    await expect(updateProviderCredentials("account", { accessToken: "new" }, { signal: controller.signal })).rejects.toBe(reason);
    expect(refresh).not.toHaveBeenCalled();
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("interrupts retry sleep without another refresh callback", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = reasonFactory();
    const refresh = vi.fn().mockResolvedValue(null);
    const pending = refreshWithRetry(refresh, 3, null, controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    controller.abort(reason);
    await rejected;
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a callback cancelled in flight", async () => {
    const controller = new AbortController();
    const reason = reasonFactory();
    const refresh = vi.fn(async () => { controller.abort(reason); throw new Error("provider failed"); });
    await expect(refreshWithRetry(refresh, 3, null, controller.signal)).rejects.toBe(reason);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh after cancellation during the database lookup", async () => {
    const controller = new AbortController();
    const reason = reasonFactory();
    mocks.getProviderConnectionById.mockImplementationOnce(async () => { controller.abort(reason); return null; });
    await expect(checkAndRefreshToken("codex", credentials(), { signal: controller.signal })).rejects.toBe(reason);
    expect(mocks.refreshTokenByProvider).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not persist an in-flight nonrotating refresh or start Copilot work", async () => {
    const controller = new AbortController();
    const reason = reasonFactory();
    mocks.refreshTokenByProvider.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { accessToken: "new", refreshToken: "old" };
    });
    await expect(checkAndRefreshToken("github", credentials(), { signal: controller.signal })).rejects.toBe(reason);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    expect(mocks.refreshCopilotToken).not.toHaveBeenCalled();
  });

  it("does not write account-selection metadata after cancellation during lookup", async () => {
    const controller = new AbortController();
    const reason = reasonFactory();
    mocks.getProviderConnections.mockImplementationOnce(async () => {
      controller.abort(reason);
      return [{ id: "account" }];
    });
    await expect(getProviderCredentials("codex", null, null, { signal: controller.signal })).rejects.toBe(reason);
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not persist Copilot credentials after cancellation in its refresh", async () => {
    const controller = new AbortController();
    const reason = reasonFactory();
    mocks.shouldRefreshCredentials.mockReturnValueOnce(false);
    mocks.refreshCopilotToken.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { token: "copilot-new", expiresAt: 9999999999 };
    });
    await expect(checkAndRefreshToken("github", credentials(), { signal: controller.signal })).rejects.toBe(reason);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not select another account after cancellation while queued on the selection mutex", async () => {
    const lookup = deferred();
    const started = deferred();
    mocks.getProviderConnections.mockImplementationOnce(() => { started.resolve(); return lookup.promise; });
    const first = getProviderCredentials("codex");
    await started.promise;
    const controller = new AbortController();
    const second = getProviderCredentials("codex", null, null, { signal: controller.signal });
    const reason = reasonFactory();
    const rejected = expect(second).rejects.toBe(reason);
    controller.abort(reason);
    lookup.resolve([{ id: "account" }]);
    await first;
    await rejected;
    expect(mocks.getProviderConnections).toHaveBeenCalledTimes(1);
    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
  });

  it("returns 499 without persistence callback or upstream retry after refresh cancellation", async () => {
    const controller = new AbortController();
    const started = deferred();
    const refreshed = deferred();
    const callback = vi.fn();
    mocks.refreshCredentials.mockImplementationOnce(() => { started.resolve(); return refreshed.promise; });
    const pending = handleChatCore(options(controller.signal, callback));
    await started.promise;
    controller.abort(reasonFactory());
    refreshed.resolve({ accessToken: "new", refreshToken: "old" });
    const result = await pending;
    expect(result.response.status).toBe(499);
    expect(mocks.refreshCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
  });
});

it("does not retry upstream after cancellation during the persistence callback", async () => {
  const controller = new AbortController();
  const callback = vi.fn(async () => { controller.abort(new Error("sibling completed")); });
  mocks.refreshCredentials.mockResolvedValueOnce({ accessToken: "new" });
  const result = await handleChatCore(options(controller.signal, callback));
  expect(result.response.status).toBe(499);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it("propagates AbortError without a signal rather than retrying it", async () => {
  const reason = new DOMException("aborted", "AbortError");
  const refresh = vi.fn().mockRejectedValue(reason);
  await expect(refreshWithRetry(refresh)).rejects.toBe(reason);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("retains the rotated proactive refresh token but does not continue request work", async () => {
  const controller = new AbortController();
  const reason = new Error("sibling completed");
  mocks.refreshTokenByProvider.mockImplementationOnce(async () => {
    controller.abort(reason);
    return { accessToken: "new", refreshToken: "rotated" };
  });
  await expect(checkAndRefreshToken("github", credentials(), { signal: controller.signal })).rejects.toBe(reason);
  expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
  expect(mocks.updateProviderConnection).toHaveBeenCalledWith("account", expect.objectContaining({ refreshToken: "rotated" }));
  expect(mocks.refreshCopilotToken).not.toHaveBeenCalled();
});

it("retains a rotated reactive token with an explicit preservation callback, without retrying upstream", async () => {
  const controller = new AbortController();
  const callback = vi.fn();
  mocks.refreshCredentials.mockImplementationOnce(async () => {
    controller.abort(new Error("sibling completed"));
    return { accessToken: "new", refreshToken: "rotated" };
  });
  const result = await handleChatCore(options(controller.signal, callback));
  expect(result.response.status).toBe(499);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(callback).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "rotated" }), { preserveRotatedToken: true });
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it("keeps successful refresh and persistence backwards compatible without a signal", async () => {
  mocks.refreshTokenByProvider.mockResolvedValueOnce({ accessToken: "new", refreshToken: "rotated" });
  const result = await checkAndRefreshToken("codex", credentials());
  expect(result.accessToken).toBe("new");
  expect(mocks.updateProviderConnection).toHaveBeenCalledWith("account", expect.objectContaining({ refreshToken: "rotated" }));
});
