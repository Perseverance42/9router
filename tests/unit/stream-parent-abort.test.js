import { describe, it, expect, vi } from "vitest";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

describe("request parent cancellation", () => {
  it("immediately propagates an already aborted parent", () => {
    const parent = new AbortController();
    parent.abort();
    expect(createStreamController({ externalSignal: parent.signal }).signal.aborted).toBe(true);
  });

  it("aborts an active upstream without the disconnect grace period", () => {
    const parent = new AbortController();
    const child = createStreamController({ externalSignal: parent.signal });
    parent.abort();
    expect(child.signal.aborted).toBe(true);
  });

  it("removes the parent listener after completion", () => {
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const child = createStreamController({ externalSignal: parent.signal });
    child.handleComplete();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    parent.abort();
    expect(child.signal.aborted).toBe(false);
  });
});
