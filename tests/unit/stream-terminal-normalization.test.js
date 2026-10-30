import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  saveUsageHistory: vi.fn(async () => {}),
}));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { guardFusionStream } from "../../open-sse/services/fusionStream.js";

const data = (value) => `data: ${JSON.stringify(value)}\n\n`;
const frame = (value) => `event: ${value.type}\n${data(value)}`;
const done = "data: [DONE]\n\n";
const chat = (delta, finish_reason = null) => ({
  id: "chatcmpl-terminal-test", object: "chat.completion.chunk", model: "test", created: 1,
  choices: [{ index: 0, delta, finish_reason }],
});
const claude = (tool = false, reason = tool ? "tool_use" : "end_turn") => [
  { type: "message_start", message: { id: "msg_terminal", model: "test", usage: { input_tokens: 2 } } },
  { type: "content_block_start", index: 0, content_block: tool
    ? { type: "tool_use", id: "call_terminal", name: "lookup", input: {} }
    : { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: tool
    ? { type: "input_json_delta", partial_json: '{"city":"Paris"}' }
    : { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];
const responses = (tool = false) => [
  { type: "response.created", response: { id: "resp_terminal", model: "test", status: "in_progress" } },
  ...(tool ? [
    { type: "response.output_item.added", output_index: 0, item: { id: "fc_terminal", type: "function_call", call_id: "call_terminal", name: "lookup", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_terminal", output_index: 0, delta: '{"city":"Paris"}' },
  ] : [{ type: "response.output_text.delta", delta: "Hello" }]),
  { type: "response.completed", response: { id: "resp_terminal", status: "completed", usage: { input_tokens: 2, output_tokens: 3 } } },
];

async function run(raw, upstream = FORMATS.OPENAI, output = FORMATS.OPENAI, passthrough = false, callback = null) {
  const bytes = new TextEncoder().encode(raw);
  const input = new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 47) controller.enqueue(bytes.slice(i, i + 47));
    controller.close();
  } });
  const transform = passthrough ? createPassthroughStreamWithLogger("openai", null, "test", null, null, callback)
    : createSSETransformStreamWithLogger(upstream, output, "test", null, null, "test", null, null, callback);
  const [capture, guarded] = input.pipeThrough(transform).tee();
  // Capture transform errors separately: the guard must also reject, never validate.
  const normalized = new Response(capture).text().then(text => ({ text }), error => ({ error }));
  const abort = new AbortController();
  const validate = vi.fn();
  const detach = vi.fn();
  const result = guardFusionStream(new Response(guarded, { headers: { "content-type": "text/event-stream" } }), {
    sourceFormat: output, validate, signal: abort.signal,
    abort: error => abort.abort(error), detach,
  });
  const text = await result.text();
  return { ...(await normalized), output: text, validate, abort, detach };
}

function accepted(result, tool = false) {
  expect(result.error).toBeUndefined();
  expect(result.abort.signal.aborted).toBe(false);
  expect(result.validate).toHaveBeenCalledTimes(1);
  expect(result.output).not.toMatch(/"error":\s*\{/);
  const calls = result.validate.mock.calls[0][0].choices[0].message.tool_calls;
  expect(calls).toHaveLength(tool ? 1 : 0);
  if (tool) {
    expect(calls[0].function.name).toBe("lookup");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ city: "Paris" });
  }
}
function rejected(result) {
  expect(result.validate).not.toHaveBeenCalled();
  expect(result.abort.signal.aborted).toBe(true);
  expect(result.output).toContain('"error"');
  if (result.text) expect(result.text).not.toContain(done);
}

describe("wire completion normalization through registered translators and Fusion guard", () => {
  for (const tool of [false, true]) {
    for (const [name, format, events] of [
      ["Claude", FORMATS.CLAUDE, claude(tool)],
      ["Responses", FORMATS.OPENAI_RESPONSES, responses(tool)],
    ]) {
      it(`accepts completed ${name} ${tool ? "tool" : "text"} translated to OpenAI`, async () => {
        const result = await run(events.map(frame).join(""), format);
        accepted(result, tool);
        expect(result.text.match(/data: \[DONE\]/g)).toHaveLength(1);
        expect(result.text).toContain(`"finish_reason":"${tool ? "tool_calls" : "stop"}"`);
      });
      it(`keeps native ${name} ${tool ? "tool" : "text"} completion`, async () => {
        accepted(await run(events.map(frame).join(""), format, format), tool);
      });
      it(`rejects truncated ${name} ${tool ? "tool" : "text"}`, async () => {
        const result = await run(events.slice(0, -1).map(frame).join(""), format);
        rejected(result);
        // Claude message_delta and Responses' flush already synthesize finish_reason.
        expect(result.text).toContain('"finish_reason":');
      });
    }
  }

  for (const passthrough of [false, true]) {
    it(`preserves native OpenAI DONE (${passthrough ? "passthrough" : "translate"})`, async () => {
      const result = await run(data(chat({ content: "Hello" })) + data(chat({}, "stop")) + done, FORMATS.OPENAI, FORMATS.OPENAI, passthrough);
      accepted(result);
      expect(result.text.match(/data: \[DONE\]/g)).toHaveLength(1);
    });
    it(`preserves native OpenAI tools (${passthrough ? "passthrough" : "translate"})`, async () => {
      const tool = { index: 0, id: "call_terminal", type: "function", function: { name: "lookup", arguments: '{"city":"Paris"}' } };
      accepted(await run(data(chat({ tool_calls: [tool] })) + data(chat({}, "tool_calls")) + done, FORMATS.OPENAI, FORMATS.OPENAI, passthrough), true);
    });
    it(`rejects native finish without DONE (${passthrough ? "passthrough" : "translate"})`, async () => {
      rejected(await run(data(chat({ content: "Hello" })) + data(chat({}, "stop")), FORMATS.OPENAI, FORMATS.OPENAI, passthrough));
    });
    it(`rejects native partial content (${passthrough ? "passthrough" : "translate"})`, async () => {
      rejected(await run(data(chat({ content: "Hello" })), FORMATS.OPENAI, FORMATS.OPENAI, passthrough));
    });
    it(`rejects upstream native errors (${passthrough ? "passthrough" : "translate"})`, async () => {
      rejected(await run(data({ error: { message: "failed" } }) + done, FORMATS.OPENAI, FORMATS.OPENAI, passthrough));
    });
    it(`does not hide malformed native data with DONE (${passthrough ? "passthrough" : "translate"})`, async () => {
      rejected(await run(data(chat({ content: "Hello" })) + "data: {broken\n\n" + done, FORMATS.OPENAI, FORMATS.OPENAI, passthrough));
    });
  }

  for (const output of [FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]) {
    for (const tool of [false, true]) {
      const delta = tool ? { tool_calls: [{ index: 0, id: "call_terminal", type: "function", function: { name: "lookup", arguments: '{"city":"Paris"}' } }] } : { content: "Hello" };
      const raw = data(chat(delta)) + data(chat({}, tool ? "tool_calls" : "stop"));
      it(`requires upstream DONE for OpenAI -> ${output} ${tool ? "tool" : "text"}`, async () => {
        rejected(await run(raw, FORMATS.OPENAI, output));
        rejected(await run("data: {broken\n\n" + raw + done, FORMATS.OPENAI, output));
        accepted(await run(raw + done, FORMATS.OPENAI, output), tool);
      });
    }
  }
  for (const passthrough of [false, true]) {
    for (const multiline of [false, true]) {
      it(`accepts ${multiline ? "multiline JSON" : "empty data events"} (${passthrough ? "passthrough" : "translate"})`, async () => {
        const content = multiline
          ? JSON.stringify(chat({ content: "Hello" }), null, 2).split("\n").map(line => `data: ${line}\n`).join("") + "\n"
          : data(chat({ content: "Hello" }));
        const raw = ": comment\r\nunknown: ignored\r\ndata:\r\n\r\n" + content + "data: \n\n" + data(chat({}, "stop")) + done;
        const result = await run(raw, FORMATS.OPENAI, FORMATS.OPENAI, passthrough);
        accepted(result);
        expect(result.text).toContain("Hello");
        if (!passthrough) {
          for (const output of [FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]) {
            const translated = await run(raw, FORMATS.OPENAI, output);
            accepted(translated);
            expect(translated.text).toContain("Hello");
          }
        }
      });
    }
  }
  for (const [format, events] of [[FORMATS.CLAUDE, claude()], [FORMATS.OPENAI_RESPONSES, responses()]]) {
    it(`does not release malformed native ${format} completion`, async () => {
      rejected(await run("data: {broken\n\n" + events.map(frame).join("") + done, format, format));
    });
  }
  it("gates pivoted Claude -> Responses terminals", async () => {
    rejected(await run(claude().slice(0, -1).map(frame).join(""), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES));
    accepted(await run(claude().map(frame).join(""), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES));
  });
  it("does not translate length into successful Responses completion", async () => {
    rejected(await run(data(chat({ content: "Hello" })) + data(chat({}, "length")) + done, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES));
  });

  for (const output of [FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]) {
    it(`requires Ollama done:true for ${output}`, async () => {
      const partial = JSON.stringify({ model: "test", message: { role: "assistant", content: "Hello" }, done: false }) + "\n\n";
      const terminal = JSON.stringify({ model: "test", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 2, eval_count: 3 });
      rejected(await run(partial, FORMATS.OLLAMA, output));
      accepted(await run(partial + terminal, FORMATS.OLLAMA, output));
      rejected(await run(partial + "{broken\n" + terminal, FORMATS.OLLAMA, output));
    });
  }

  it("handles a terminal data line without a final newline", async () => {
    const result = await run(claude().map(frame).join("").trimEnd(), FORMATS.CLAUDE);
    accepted(result);
    expect(result.text).toContain(done);
  });
  it("preserves terminal native DONE without a newline", async () => {
    accepted(await run(data(chat({ content: "Hello" })) + "data: [DONE]"));
    accepted(await run(data(chat({ content: "Hello" })) + "data: [DONE]", FORMATS.OPENAI, FORMATS.OPENAI, true));
  });
  it("rejects malformed translated data even with a later terminal", async () => {
    rejected(await run(claude().slice(0, -1).map(frame).join("") + "data: {broken\n\n" + frame({ type: "message_stop" }), FORMATS.CLAUDE));
  });
  it("rejects translated upstream errors even with a later completed event", async () => {
    rejected(await run([...responses().slice(0, -1), { type: "error", error: { message: "failed" } }, responses().at(-1)].map(frame).join(""), FORMATS.OPENAI_RESPONSES));
    rejected(await run([...claude().slice(0, -1), { type: "error", error: { message: "failed" } }, { type: "message_stop" }].map(frame).join(""), FORMATS.CLAUDE));
  });
  it("rejects empty input and errors with no valid completion", async () => {
    rejected(await run(""));
    rejected(await run(frame({ type: "message_stop" }), FORMATS.CLAUDE));
    rejected(await run(frame({ type: "response.completed", response: { status: "failed" } }), FORMATS.OPENAI_RESPONSES));
    rejected(await run(frame({ type: "response.failed", response: { status: "failed", error: { message: "failed" } } }), FORMATS.OPENAI_RESPONSES));
  });
  it("preserves native Responses content_filter incomplete without fabricated success", async () => {
    const incomplete = { type: "response.incomplete", response: { id: "resp_terminal", status: "incomplete", incomplete_details: { reason: "content_filter" } } };
    const result = await run(frame(responses()[0]) + frame(incomplete), FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES);
    expect(result.text).toContain(data(incomplete));
    expect(result.text).not.toContain("response.completed");
    expect(result.text).not.toContain("response.failed");
    expect(result.text).not.toContain(done);
    // Fusion permits incomplete text; it must still reject truncated tool output.
    expect(result.abort.signal.aborted).toBe(false);
    expect(result.validate).toHaveBeenCalledTimes(1);
    const tool = await run([...responses(true).slice(0, -1), incomplete].map(frame).join(""), FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES);
    expect(tool.text).toContain(data(incomplete));
    expect(tool.text).not.toContain(done);
    expect(tool.validate).not.toHaveBeenCalled();
    expect(tool.abort.signal.aborted).toBe(true);
    expect(tool.output).toContain('"error"');
  });
  it("does not bless incomplete Responses with synthetic stop", async () => {
    rejected(await run([...responses().slice(0, -1), { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }].map(frame).join(""), FORMATS.OPENAI_RESPONSES));
  });
  it("preserves Claude length for text, but rejects length-limited tool calls", async () => {
    const result = await run(claude(false, "max_tokens").map(frame).join(""), FORMATS.CLAUDE);
    accepted(result);
    expect(result.text).toContain('"finish_reason":"length"');
    const tool = await run(claude(true, "max_tokens").map(frame).join(""), FORMATS.CLAUDE);
    expect(tool.validate).not.toHaveBeenCalled();
    expect(tool.abort.signal.aborted).toBe(true);
    expect(tool.output).toContain('"error"');
  });
  it("propagates completion callback errors instead of emitting successful DONE", async () => {
    const callback = () => { throw new Error("callback failed"); };
    const result = await run(claude().map(frame).join(""), FORMATS.CLAUDE, FORMATS.OPENAI, false, callback);
    rejected(result);
    expect(result.error?.message).toBe("callback failed");
    for (const passthrough of [false, true]) {
      const native = await run(data(chat({ content: "Hello" })) + done, FORMATS.OPENAI, FORMATS.OPENAI, passthrough, callback);
      rejected(native);
      expect(native.error?.message).toBe("callback failed");
    }
  });
});
