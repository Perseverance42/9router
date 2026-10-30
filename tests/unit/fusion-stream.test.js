import { describe, it, expect } from "vitest";
import { guardFusionStream } from "../../open-sse/services/fusionStream.js";

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
const toolEvents = {
  openai: (name) => frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "{}" } }] } }] }) + frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n",
  claude: (name) => frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name } }) + frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }) + frame({ type: "message_stop" }),
  "openai-responses": (name) => frame({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name, arguments: "" } }) + frame({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" }) + frame({ type: "response.completed" }),
};

describe("Fusion streamed tool boundary", () => {
  it("finishes at the logical terminal without waiting for transport EOF", async () => {
    let cancelled = false;
    const parent = new AbortController();
    const response = guardFusionStream(new Response(new ReadableStream({
      start(output) { output.enqueue(new TextEncoder().encode(toolEvents.openai("read_file"))); },
      cancel() { cancelled = true; },
    })), { sourceFormat: "openai", signal: parent.signal, abort() {}, detach() {}, validate() {} });
    expect(await response.text()).toBe(toolEvents.openai("read_file"));
    expect(cancelled).toBe(true);
  });
  it("does not commit calls from truncated or unterminated streams", async () => {
    for (const events of [
      toolEvents.openai("read_file").replace("tool_calls\"}]", "length\"}]"),
      toolEvents.openai("read_file").replace("data: [DONE]\n\n", ""),
    ]) {
      const parent = new AbortController();
      const response = guardFusionStream(new Response(events), {
        sourceFormat: "openai", signal: parent.signal, abort() {}, detach() {}, validate() {},
      });
      const text = await response.text();
      expect(text).not.toContain("read_file");
      expect(text).toContain(events.includes('"length"') ? '"code":"fusion_tool_output_truncated"' : '"code":"fusion_stream_incomplete"');
    }
  });
  for (const [sourceFormat, events] of Object.entries(toolEvents)) {
    it(`${sourceFormat}: holds complete calls and never exposes internal tools`, async () => {
      for (const name of ["read_file", "consult_panel"]) {
        const controller = new AbortController();
        let detached = false;
        const bytes = new TextEncoder().encode(events(name));
        const response = guardFusionStream(new Response(new ReadableStream({ start(output) {
          // Exercise split event and UTF-8 decoding boundaries.
          for (const byte of bytes) output.enqueue(Uint8Array.of(byte));
          output.close();
        } })), {
          sourceFormat, signal: controller.signal, abort: (error) => controller.abort(error), detach: () => { detached = true; },
          validate: (completion) => {
            const call = completion.choices[0].message.tool_calls[0];
            expect(call.function.arguments).toBe("{}");
            if (call.function.name !== "read_file") throw new Error("Unknown tool");
          },
        });
        const text = await response.text();
        expect(detached).toBe(true);
        if (name === "read_file") expect(text).toBe(events(name));
        else {
          expect(text).not.toContain("consult_panel");
          expect(text).toContain('"code":"fusion_invalid_tool_calls"');
          expect(controller.signal.aborted).toBe(true);
        }
      }
    });
  }
});
