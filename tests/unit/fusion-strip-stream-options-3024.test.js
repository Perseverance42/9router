import { describe, it, expect, vi } from "vitest";
import { handleFusionChat } from "../../open-sse/services/combo.js";

describe("Fusion non-streaming stages (#3024)", () => {
  it("strips stream_options while collecting initial and panel completions", async () => {
    const handleSingleModel = vi.fn(async (body, _model, execution) => {
      expect(body.stream).toBe(false);
      expect(body.stream_options).toBeUndefined();
      if (execution.stage === "initial") return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: {
        name: "consult_panel", arguments: JSON.stringify({ panel_ids: ["panel_1"], brief: "Question" }),
      } }] } }] }));
      return new Response(JSON.stringify({ error: { message: "test ends at panel failure" } }), { status: 503 });
    });
    const result = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } },
      models: ["p/a"], handleSingleModel, log: { warn() {} },
    });
    expect(result.status).toBe(502);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});
