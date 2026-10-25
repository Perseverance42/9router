import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("Fusion tool-choice preservation", () => {
  it("preserves none across Claude and OpenAI translation", () => {
    const body = { messages: [{ role: "user", content: "Answer only" }], tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }], tool_choice: "none" };
    const claude = translateRequest("openai", "claude", "model", structuredClone(body), false);
    expect(claude.tool_choice.type).toBe("none");
    const openai = translateRequest("claude", "openai", "model", structuredClone(claude), false);
    expect(openai.tool_choice).toBe("none");
  });
});
