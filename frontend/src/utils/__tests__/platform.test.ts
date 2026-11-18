import { afterEach, describe, expect, it } from "vitest";
import { detectApplePlatform, isApplePlatform, setApplePlatformForTesting } from "../platform";

describe("platform", () => {
  afterEach(() => {
    setApplePlatformForTesting(null);
  });

  it("prefers navigator.userAgentData.platform and falls back to navigator.platform", () => {
    expect(detectApplePlatform({ userAgentData: { platform: "macOS" }, platform: "Win32" } as never)).toBe(true);
    expect(detectApplePlatform({ userAgentData: { platform: "Windows" }, platform: "MacIntel" } as never)).toBe(false);
    expect(detectApplePlatform({ platform: "MacIntel" } as never)).toBe(true);
    expect(detectApplePlatform({ platform: "iPhone" } as never)).toBe(true);
    expect(detectApplePlatform({ platform: "Linux x86_64" } as never)).toBe(false);
    expect(detectApplePlatform(null)).toBe(false);
  });

  it("allows overriding Apple platform detection for tests", () => {
    setApplePlatformForTesting(true);
    expect(isApplePlatform()).toBe(true);
    setApplePlatformForTesting(false);
    expect(isApplePlatform()).toBe(false);
  });
});
