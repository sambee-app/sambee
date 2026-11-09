import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "./randomUuid";

describe("randomUuid", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [0x00, "00000000-0000-4000-8000-000000000000"],
    [0xff, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
  ])("sets UUID v4 version and variant bits for byte value %i", (value, expected) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(value));
    vi.stubGlobal("crypto", { getRandomValues });

    expect(randomUuid()).toBe(expected);
    expect(getRandomValues).toHaveBeenCalledExactlyOnceWith(expect.any(Uint8Array));
  });

  it("uses secure random bytes even when the secure-context UUID method is present", () => {
    const nativeUuid = vi.fn(() => {
      throw new Error("The secure-context UUID method must not be used");
    });
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(0), randomUUID: nativeUuid });

    expect(randomUuid()).toBe("00000000-0000-4000-8000-000000000000");
    expect(nativeUuid).not.toHaveBeenCalled();
  });
});
