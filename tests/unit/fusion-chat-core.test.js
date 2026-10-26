import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {},
  logProviderResponse() {}, logConvertedResponse() {}, logError() {},
}) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest() {}, appendRequestLog: async () => {}, saveRequestDetail: async () => {} }));
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
  beforeEach(() => { execute.mockReset(); });
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
