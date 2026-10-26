import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("Fusion Responses constraint round trips", () => {
  it("preserves named tool choice, parallelism and analyst schema across the Responses pivot", () => {
    const body = {
      messages: [{ role: "system", content: "Original instructions" }, { role: "user", content: "Question" }],
      tools: [{ type: "function", function: { name: "consult_panel", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "consult_panel" } }, parallel_tool_calls: false,
      response_format: { type: "json_schema", json_schema: { name: "analysis", strict: false, schema: { type: "object" } } },
    };
    const responses = translateRequest("openai", "openai-responses", "model", structuredClone(body), false);
    expect(responses.tool_choice).toEqual({ type: "function", name: "consult_panel" });
    expect(responses.parallel_tool_calls).toBe(false);
    expect(responses.text.format).toEqual({ type: "json_schema", ...body.response_format.json_schema });
    const roundTrip = translateRequest("openai-responses", "openai", "model", responses, false);
    expect(roundTrip.tool_choice).toEqual(body.tool_choice);
    expect(roundTrip.response_format).toEqual(body.response_format);
  });
});
