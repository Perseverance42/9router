import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";
const { execute, logError, saveRequestDetail, executor } = vi.hoisted(() => {
  const execute = vi.fn();
  return { execute, logError: vi.fn(), saveRequestDetail: vi.fn(async () => {}), executor: { noAuth: true, execute, refreshCredentials: vi.fn() } };
});
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => executor }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {},
  logProviderResponse() {}, logConvertedResponse() {}, logError,
}) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest() {}, appendRequestLog: async () => {}, saveRequestDetail }));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const options = (extra = {}) => ({
  body: { messages: [{ role: "user", content: "Question" }], stream: false },
  modelInfo: { provider: "anthropic", model: "claude-sonnet-4" },
  credentials: { apiKey: "test", providerSpecificData: {} },
  sourceFormatOverride: "openai", internal: true,
  clientRawRequest: { endpoint: "/v1/messages", headers: { "user-agent": "claude-cli" }, body: {} },
  log: { debug() {}, info() {}, warn() {} }, ...extra,
});
const upstream = (body, format = "claude") => ({
  response: new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
  responseFormat: format, url: "https://example.test", headers: {}, transformedBody: {},
});

describe("Fusion internal chat boundary", () => {
  beforeEach(() => { execute.mockReset(); logError.mockClear(); saveRequestDetail.mockClear(); executor.noAuth = true; executor.refreshCredentials.mockReset(); });
  it.each([true, false])("keeps invalid JSON diagnostics private only for internal calls: %s", async (internal) => {
    const secret = "S3CR3T";
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      execute.mockResolvedValue({ ...upstream({}), response: new Response(secret, { headers: { "content-type": "application/json" } }) });
      const result = await handleChatCore(options({ internal }));
      expect(result.response.status).toBe(502);
      expect(await result.response.text()).not.toContain(secret);
      expect(JSON.stringify(output.mock.calls).includes(secret)).toBe(!internal);
    } finally { output.mockRestore(); }
  });
  it.each([true, false])("keeps blocked HTML diagnostics private only for internal calls: %s", async (internal) => {
    const secret = "SECRET_HTML_TITLE_BODY";
    const log = { debug() {}, info() {}, warn: vi.fn(), errorLine: vi.fn() };
    execute.mockResolvedValue({ ...upstream({}), response: new Response(`<title>${secret}</title>`, { headers: { "content-type": "text/html" } }) });
    const result = await handleChatCore(options({ internal, log, body: { messages: [{ role: "user", content: "Question" }], stream: true } }));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(internal ? 502 : 200);
    expect((await result.response.text()).includes(secret)).toBe(!internal);
    expect(JSON.stringify(log.errorLine.mock.calls).includes(secret)).toBe(!internal);
  });
  it("suppresses adjacent callback and persistence exception logs for internal completions", async () => {
    const secret = "SECRET_SUCCESS_CALLBACK_STORAGE_ERROR";
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      saveRequestDetail.mockRejectedValueOnce(new Error(secret));
      execute.mockResolvedValue(upstream({ type: "message", id: "msg_1", content: [{ type: "text", text: "Safe answer" }], stop_reason: "end_turn" }));
      const result = await handleChatCore(options({ onRequestSuccess: async () => { throw new Error(secret); } }));
      expect(result.success).toBe(true);
      expect(await result.response.text()).not.toContain(secret);
      await Promise.resolve();
      await Promise.resolve();
      expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
    } finally { output.mockRestore(); }
  });
  it.each([true, false])("keeps refresh retry exceptions private only for internal calls: %s", async (internal) => {
    const secret = "SECRET_REFRESH_THROW_MESSAGE";
    const log = { debug: vi.fn(), info() {}, warn: vi.fn(), error: vi.fn(), errorLine: vi.fn() };
    executor.noAuth = false;
    executor.refreshCredentials.mockRejectedValue(new Error(secret));
    execute.mockImplementation(async () => ({ ...upstream({}), response: Response.json({ error: { message: "Unauthorized" } }, { status: 401 }) }));
    vi.useFakeTimers();
    try {
      const pending = handleChatCore(options({ internal, log }));
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.response.status).toBe(401);
      expect(executor.refreshCredentials).toHaveBeenCalledTimes(3);
      expect(await result.response.text()).not.toContain(secret);
      expect(JSON.stringify(log.warn.mock.calls).includes(secret)).toBe(!internal);
    } finally { vi.useRealTimers(); }
  });
  it.each([true, false])("suppresses provider-error diagnostics only for internal calls: %s", async (internal) => {
    const secret = "SECRET_PROVIDER_MESSAGE_HEADER_STACK";
    const log = { debug() {}, info() {}, warn: vi.fn(), errorLine: vi.fn() };
    execute.mockResolvedValue({ ...upstream({}), response: Response.json({ error: { message: secret } }, { status: 502 }) });
    const result = await handleChatCore(options({ internal, log }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(log.errorLine.mock.calls).includes(secret)).toBe(!internal);
    expect(logError.mock.calls.length > 0).toBe(!internal);
    expect(saveRequestDetail.mock.calls.length > 0).toBe(!internal);
  });
  it("suppresses thrown executor messages and stacks for internal calls", async () => {
    const secret = "SECRET_EXECUTOR_STACK";
    const log = { debug() {}, info() {}, warn: vi.fn(), errorLine: vi.fn() };
    execute.mockRejectedValue(new Error(secret));
    const result = await handleChatCore(options({ log }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(log.errorLine.mock.calls)).not.toContain(secret);
    expect(await result.response.text()).not.toContain(secret);
    expect(saveRequestDetail).not.toHaveBeenCalled();
  });
  it("disables native CLI passthrough and preserves exposed reasoning and literal content", async () => {
    execute.mockResolvedValue(upstream({ type: "message", id: "msg_1", model: "claude", stop_reason: "end_turn", content: [
      { type: "thinking", thinking: "Visible summary" }, { type: "text", text: "```json\n{}\n```" },
    ] }));
    const result = await handleChatCore(options());
    expect(result.success).toBe(true);
    expect(execute.mock.calls[0][0].body.messages[0].content).toEqual(expect.any(Array));
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("```json\n{}\n```");
    expect(json.choices[0].message.reasoning_content).toBe("Visible summary");
  });
  it.each([4096, 8192, 1000])("enforces a private Fusion ceiling after Claude tool and thinking translation (%i)", async (maxOutputTokens) => {
    execute.mockResolvedValue(upstream({ type: "message", id: "msg_1", content: [{ type: "text", text: "Safe" }], stop_reason: "end_turn" }));
    const body = { messages: [{ role: "user", content: "Question" }], max_tokens: maxOutputTokens, thinking: { type: "enabled", budget_tokens: 10000 }, tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }], stream: false };
    expect((await handleChatCore(options({ body, maxOutputTokens }))).success).toBe(true);
    const payload = execute.mock.calls[0][0].body;
    expect(payload.max_tokens).toBeLessThanOrEqual(maxOutputTokens);
    if (payload.thinking?.type === "enabled") {
      expect(payload.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
      expect(payload.thinking.budget_tokens).toBeLessThan(payload.max_tokens);
    }
    if (maxOutputTokens === 1000) expect(payload.thinking.type).toBe("disabled");
  });
  it("does not trust a public-body output ceiling or change ordinary Claude tool minimums", async () => {
    execute.mockResolvedValue(upstream({ type: "message", id: "msg_1", content: [{ type: "text", text: "Safe" }], stop_reason: "end_turn" }));
    const body = { messages: [{ role: "user", content: "Question" }], max_tokens: 4096, maxOutputTokens: 100, tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }], stream: false };
    expect((await handleChatCore(options({ body }))).success).toBe(true);
    expect(execute.mock.calls[0][0].body.max_tokens).toBeGreaterThan(8192);
  });
  it("rejects missing native Claude envelopes rather than creating empty advice", async () => {
    execute.mockResolvedValue(upstream({}));
    const result = await handleChatCore(options());
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });
  it("rejects malformed buffered event framing instead of returning partial advice", async () => {
    execute.mockResolvedValue({ response: new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {broken\n\n', {
      headers: { "content-type": "text/event-stream" },
    }), responseFormat: "openai", transformedBody: {} });
    const result = await handleChatCore(options());
    expect(result.response.status).toBe(502);
  });
  it("suppresses adjacent forced-stream reader exception logs", async () => {
    const secret = "SECRET_FORCED_SSE_READER_ERROR";
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      execute.mockResolvedValue({ response: new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } }), {
        headers: { "content-type": "text/event-stream" },
      }), responseFormat: "openai-responses", transformedBody: {} });
      const result = await handleChatCore(options());
      expect(result.response.status).toBe(502);
      expect(await result.response.text()).not.toContain(secret);
      expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
    } finally { output.mockRestore(); }
  });
  it("rejects an unterminated Responses stream instead of fabricating empty advice", async () => {
    execute.mockResolvedValue({ response: new Response('event: response.created\ndata: {"response":{"id":"resp_1"}}\n\n', {
      headers: { "content-type": "text/event-stream" },
    }), responseFormat: "openai-responses", transformedBody: {} });
    const result = await handleChatCore(options());
    expect(result.response.status).toBe(502);
  });
  it("propagates cancellation into the executor immediately", async () => {
    const parent = new AbortController();
    let start;
    const started = new Promise((r) => { start = r; });
    execute.mockImplementation(({ signal }) => new Promise((_, reject) => {
      start();
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const pending = handleChatCore(options({ externalSignal: parent.signal }));
    await started;
    parent.abort();
    const result = await pending;
    expect(result.response.status).toBe(499);
    expect(execute.mock.calls[0][0].signal.aborted).toBe(true);
  });
});
