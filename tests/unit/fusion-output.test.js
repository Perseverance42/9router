import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { deliverFusionCompletion } = await import("../../open-sse/services/fusionOutput.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const completion = () => ({
  id: "chatcmpl-fusion-output-123",
  object: "chat.completion",
  created: 1700000000,
  model: "test-model",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      reasoning_content: "Consider both files.",
      content: "Inspect these files.",
      tool_calls: [
        { id: "call_one", type: "function", function: { name: "inspect", arguments: '{ "path": "a\\nb", "nested": {"ok":true} }' } },
        { id: "call_two", type: "function", function: { name: "Read", arguments: '{"file_path":"notes.txt","limit":"3000","offset":-2,"pages":"invalid"}' } },
      ],
    },
    finish_reason: "tool_calls",
  }],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 8,
    total_tokens: 28,
    prompt_tokens_details: { cached_tokens: 3, cache_creation_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 4 },
  },
});

async function frames(response) {
  expect(response).toBeInstanceOf(Response);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const text = await response.text();
  expect(text.endsWith("\n\n")).toBe(true);
  return text.trimEnd().split("\n\n").map((frame) => {
    const lines = frame.split("\n");
    const data = lines.find((line) => line.startsWith("data: ")).slice(6);
    return { event: lines.find((line) => line.startsWith("event: "))?.slice(7), data: data === "[DONE]" ? data : JSON.parse(data) };
  });
}

function textCompletion(finishReason = "stop", content = "Hello") {
  const body = completion();
  body.choices[0] = { index: 0, message: { role: "assistant", content }, finish_reason: finishReason };
  return body;
}

describe("deliverFusionCompletion JSON", () => {
  it("preserves canonical OpenAI content, IDs, finish reason and exact usage", async () => {
    const input = completion();
    const original = structuredClone(input);
    const response = deliverFusionCompletion(input, { sourceFormat: FORMATS.OPENAI, stream: false });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(original);
    expect(input).toEqual(original);
  });

  it("reuses Claude message conversion without dropping reasoning or tool IDs", async () => {
    const input = completion();
    const body = await deliverFusionCompletion(input, { sourceFormat: FORMATS.CLAUDE, stream: false }).json();
    expect(body).toMatchObject({ id: "fusion-output-123", type: "message", model: input.model, stop_reason: "tool_use" });
    expect(body.content.slice(0, 2)).toEqual([
      { type: "thinking", thinking: input.choices[0].message.reasoning_content },
      { type: "text", text: input.choices[0].message.content },
    ]);
    expect(body.content.filter((block) => block.type === "tool_use")).toEqual(input.choices[0].message.tool_calls.map((call) => ({
      type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments),
    })));
    expect(body.usage).toEqual({ input_tokens: 15, output_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 });
  });

  it("reuses Responses conversion with function arguments and usage details", async () => {
    const input = completion();
    const body = await deliverFusionCompletion(input, { sourceFormat: FORMATS.OPENAI_RESPONSES, stream: false }).json();
    expect(body).toMatchObject({ id: "resp_fusion-output-123", object: "response", created_at: input.created, model: input.model, status: "completed" });
    expect(body.output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call", "function_call"]);
    expect(body.output.filter((item) => item.type === "function_call").map((item) => [item.call_id, item.arguments])).toEqual(input.choices[0].message.tool_calls.map((call) => [call.id, call.function.arguments]));
    expect(body.usage).toEqual({ input_tokens: 20, output_tokens: 8, total_tokens: 28, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 4 } });
  });
});

describe("deliverFusionCompletion buffered SSE", () => {
  it("emits Chat chunks, indexed native tool calls, optional usage trailer and exactly one DONE", async () => {
    const input = completion();
    const output = await frames(deliverFusionCompletion(input, { sourceFormat: FORMATS.OPENAI, stream: true, includeUsage: true }));
    expect(output.at(-1).data).toBe("[DONE]");
    expect(output.filter((frame) => frame.data === "[DONE]")).toHaveLength(1);
    const chunks = output.slice(0, -1).map((frame) => frame.data);
    expect(chunks.every((chunk) => chunk.id === input.id && chunk.created === input.created && chunk.model === input.model && chunk.object === "chat.completion.chunk")).toBe(true);
    expect(chunks[0].choices[0].delta).toEqual({ ...input.choices[0].message, tool_calls: input.choices[0].message.tool_calls.map((call, index) => ({ ...call, index })) });
    expect(chunks[1].choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "tool_calls" });
    expect(chunks[2]).toMatchObject({ choices: [], usage: input.usage });
    const withoutUsage = await frames(deliverFusionCompletion(input, { sourceFormat: FORMATS.OPENAI, stream: true }));
    expect(withoutUsage.some((frame) => frame.data.usage)).toBe(false);
  });

  it("emits Claude block lifecycle, exact tool JSON and message_stop without DONE", async () => {
    const input = completion();
    const output = await frames(deliverFusionCompletion(input, { sourceFormat: FORMATS.CLAUDE, stream: true }));
    expect(output[0]).toMatchObject({ event: "message_start", data: { message: { id: "fusion-output-123", usage: { input_tokens: 15, output_tokens: 0 } } } });
    expect(output.at(-1)).toEqual({ event: "message_stop", data: { type: "message_stop" } });
    expect(output.every((frame) => frame.data !== "[DONE]" && frame.event === frame.data.type)).toBe(true);
    expect(output.filter((frame) => frame.event === "message_stop")).toHaveLength(1);
    const starts = output.filter((frame) => frame.data.content_block?.type === "tool_use");
    expect(starts.map((frame) => [frame.data.content_block.id, frame.data.content_block.name])).toEqual([["call_one", "inspect"], ["call_two", "Read"]]);
    for (const [index, start] of starts.entries()) {
      expect(output.find((frame) => frame.data.index === start.data.index && frame.data.delta?.type === "input_json_delta").data.delta.partial_json).toBe(input.choices[0].message.tool_calls[index].function.arguments);
      expect(output.filter((frame) => frame.data.index === start.data.index && frame.event === "content_block_stop")).toHaveLength(1);
    }
    expect(output.find((frame) => frame.event === "message_delta").data).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 15, output_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } });
    expect(output.find((frame) => frame.data.delta?.type === "thinking_delta").data.delta.thinking).toBe(input.choices[0].message.reasoning_content);
  });

  it("emits Responses terminal output with distinct reasoning/message/tool indices", async () => {
    const input = completion();
    const output = await frames(deliverFusionCompletion(input, { sourceFormat: FORMATS.OPENAI_RESPONSES, stream: true }));
    expect(output[0].event).toBe("response.created");
    expect(output.at(-1).event).toBe("response.completed");
    expect(output.filter((frame) => frame.event === "response.completed")).toHaveLength(1);
    expect(output.every((frame) => frame.event === frame.data.type)).toBe(true);
    expect(output.map((frame) => frame.data.sequence_number)).toEqual(output.map((_, index) => index + 1));
    const doneItems = output.filter((frame) => frame.event === "response.output_item.done");
    expect(doneItems.map((frame) => frame.data.output_index)).toEqual([0, 1, 2, 3]);
    const terminal = output.at(-1).data.response;
    expect(terminal).toMatchObject({ id: "resp_fusion-output-123", created_at: input.created, model: input.model, status: "completed", usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 4 } } });
    expect(terminal.output).toEqual(doneItems.map((frame) => frame.data.item));
    expect(terminal.output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call", "function_call"]);
    expect(output.filter((frame) => frame.event === "response.function_call_arguments.done").map((frame) => frame.data.arguments)).toEqual(input.choices[0].message.tool_calls.map((call) => call.function.arguments));
  });

  it("keeps literal think tags as native content rather than reinterpreting an upstream envelope", async () => {
    const input = textCompletion("stop", "Example: <think>literal</think>.");
    const output = await frames(deliverFusionCompletion(input, { sourceFormat: FORMATS.OPENAI_RESPONSES, stream: true }));
    expect(output.filter((frame) => frame.event === "response.output_text.delta").map((frame) => frame.data.delta).join("")).toBe(input.choices[0].message.content);
    expect(output.at(-1).data.response.output[0].content[0].text).toBe(input.choices[0].message.content);
    expect(output.some((frame) => frame.event === "response.reasoning_summary_text.delta")).toBe(false);
  });

  it.each([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES])("terminates empty %s responses without inventing usage", async (sourceFormat) => {
    const input = textCompletion("stop", "");
    delete input.usage;
    const output = await frames(deliverFusionCompletion(input, { sourceFormat, stream: true }));
    expect(output.at(-1).event || output.at(-1).data).toBe(sourceFormat === FORMATS.OPENAI ? "[DONE]" : sourceFormat === FORMATS.CLAUDE ? "message_stop" : "response.completed");
    if (sourceFormat === FORMATS.OPENAI_RESPONSES) expect(output.at(-1).data.response).not.toHaveProperty("usage");
  });

  it.each([["length", "max_output_tokens"], ["content_filter", "content_filter"]])("preserves %s as Responses incomplete in JSON and SSE", async (finishReason, reason) => {
    const input = textCompletion(finishReason);
    const body = await deliverFusionCompletion(input, { sourceFormat: FORMATS.OPENAI_RESPONSES, stream: false }).json();
    expect(body).toMatchObject({ status: "incomplete", incomplete_details: { reason } });
    const output = await frames(deliverFusionCompletion(input, { sourceFormat: FORMATS.OPENAI_RESPONSES, stream: true }));
    expect(output.at(-1)).toMatchObject({ event: "response.incomplete", data: { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason } } } });
    expect(output.some((frame) => frame.event === "response.completed")).toBe(false);
  });
});

describe("fusion output boundaries", () => {
  it.each([FORMATS.GEMINI, FORMATS.ANTIGRAVITY, FORMATS.OLLAMA, "unknown", undefined])("rejects unsupported format %s rather than passing Chat through", (sourceFormat) => {
    expect(() => deliverFusionCompletion(completion(), { sourceFormat, stream: false })).toThrow("Unsupported fusion output format");
  });

  it("rejects malformed completions and non-text content instead of losing data", () => {
    expect(() => deliverFusionCompletion({}, { sourceFormat: FORMATS.OPENAI, stream: true })).toThrow(TypeError);
    const input = completion();
    input.choices[0].message.content = [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }];
    expect(() => deliverFusionCompletion(input, { sourceFormat: FORMATS.CLAUDE, stream: true })).toThrow(TypeError);
  });

  it("rejects malformed Claude tool JSON instead of replacing arguments with an empty object", () => {
    const input = completion();
    input.choices[0].message.tool_calls[0].function.arguments = "invalid";
    expect(() => deliverFusionCompletion(input, { sourceFormat: FORMATS.CLAUDE, stream: false })).toThrow("Claude tool arguments must be a JSON object");
  });

  it.each([FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES])("rejects multiple choices for %s", (sourceFormat) => {
    const input = completion();
    input.choices.push({ ...input.choices[0], index: 1 });
    expect(() => deliverFusionCompletion(input, { sourceFormat, stream: true })).toThrow("exactly one choice");
  });
});

describe("non-streaming provider/OpenAI/client composition", () => {
  it("preserves exact Claude text only when requested, including through composition", () => {
    const text = '  ```json\n{"answer":"exact"}\n```  ';
    const providerBody = { id: "msg_exact", model: "test-model", content: [{ type: "text", text }], stop_reason: "end_turn" };
    expect(translateNonStreamingResponse(providerBody, FORMATS.CLAUDE, FORMATS.OPENAI).choices[0].message.content).toBe('{"answer":"exact"}');
    expect(translateNonStreamingResponse(providerBody, FORMATS.CLAUDE, FORMATS.OPENAI, null, { preserveText: true }).choices[0].message.content).toBe(text);
    expect(translateNonStreamingResponse(providerBody, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, null, { preserveText: true }).output[0].content[0].text).toBe(text);
  });

  it("converts Claude tools through OpenAI into Responses items", () => {
    const providerBody = { id: "msg_composition", model: "test-model", content: [{ type: "tool_use", id: "call_composed", name: "inspect", input: { path: "a" } }], stop_reason: "tool_use", usage: { input_tokens: 12, output_tokens: 3 } };
    const body = translateNonStreamingResponse(providerBody, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES);
    expect(body.object).toBe("response");
    expect(body.output).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_composed", arguments: '{"path":"a"}' }));
    expect(body.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });
  });

  it.each([FORMATS.GEMINI, FORMATS.ANTIGRAVITY])("converts %s text/thought/tools through OpenAI into Claude blocks", (targetFormat) => {
    const response = { responseId: "composed-gemini", modelVersion: "test-model", candidates: [{ content: { parts: [{ thought: true, text: "Think" }, { text: "Answer" }, { functionCall: { name: "inspect", args: { path: "a" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 } };
    const body = translateNonStreamingResponse(targetFormat === FORMATS.ANTIGRAVITY ? { response } : response, targetFormat, FORMATS.CLAUDE);
    expect(body.type).toBe("message");
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toEqual([
      { type: "thinking", thinking: "Think" },
      { type: "text", text: "Answer" },
      expect.objectContaining({ type: "tool_use", name: "inspect", input: { path: "a" } }),
    ]);
  });
});
