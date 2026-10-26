import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("Fusion tool-choice preservation", () => {
  it("preserves stop sequences and disabled parallel tool use on Claude targets", () => {
    const body = { messages: [{ role: "user", content: "Question" }], stop: ["END"], parallel_tool_calls: false,
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] };
    const claude = translateRequest("openai", "claude", "model", body, false);
    expect(claude.stop_sequences).toEqual(["END"]);
    expect(claude.tool_choice.disable_parallel_tool_use).toBe(true);
  });
  it("preserves none across Claude and OpenAI translation", () => {
    const body = { messages: [{ role: "user", content: "Answer only" }], tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }], tool_choice: "none" };
    const claude = translateRequest("openai", "claude", "model", structuredClone(body), false);
    expect(claude.tool_choice.type).toBe("none");
    const openai = translateRequest("claude", "openai", "model", structuredClone(claude), false);
    expect(openai.tool_choice).toBe("none");
  });
});
