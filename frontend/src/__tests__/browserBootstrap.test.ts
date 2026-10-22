import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadApp } = vi.hoisted(() => ({ loadApp: vi.fn() }));
vi.mock("../index", () => {
  loadApp();
  return {};
});

describe("browser capability gate", () => {
  beforeEach(() => {
    vi.resetModules();
    loadApp.mockClear();
    vi.stubGlobal("Iterator", { from: vi.fn() });
    document.body.innerHTML = '<div id="root"><p id="browser-compatibility-reason"></p></div>';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it.each([undefined, null, {}])("blocks app loading when Worker is %s", async (worker) => {
    vi.stubGlobal("Worker", worker);
    await import("../browserBootstrap");
    expect(document.getElementById("root")).toHaveClass("browser-compatibility-unsupported");
    expect(document.getElementById("browser-compatibility-reason")).toHaveTextContent("Missing browser capabilities: Web Workers.");
    expect(loadApp).not.toHaveBeenCalled();
  });

  it("loads the app when the Worker API and other required capabilities are present", async () => {
    vi.stubGlobal("Worker", vi.fn());
    await import("../browserBootstrap");
    await vi.waitFor(() => expect(loadApp).toHaveBeenCalledOnce());
    expect(document.getElementById("root")).not.toHaveClass("browser-compatibility-unsupported");
    expect(document.getElementById("root")).toBeEmptyDOMElement();
  });
});
