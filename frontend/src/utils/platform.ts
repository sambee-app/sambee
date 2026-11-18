interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: {
    platform?: string;
  };
}

const APPLE_PLATFORM_PATTERN = /^(mac|iphone|ipad|ipod|ios)/i;

/**
 * Detects whether the current browser reports an Apple platform.
 * Prefers `navigator.userAgentData?.platform` and falls back to `navigator.platform`.
 */
export function detectApplePlatform(nav?: NavigatorWithUserAgentData | null): boolean {
  const targetNavigator = nav === undefined ? (typeof navigator === "undefined" ? null : (navigator as NavigatorWithUserAgentData)) : nav;
  if (!targetNavigator) {
    return false;
  }

  const platform = targetNavigator.userAgentData?.platform || targetNavigator.platform || "";
  return APPLE_PLATFORM_PATTERN.test(platform);
}

const detectedApplePlatform = detectApplePlatform();
let applePlatformOverride: boolean | null = null;

/**
 * Returns whether the user is on an Apple platform (macOS/iOS/iPadOS).
 * Evaluated once at startup unless overridden in tests.
 */
export function isApplePlatform(): boolean {
  return applePlatformOverride ?? detectedApplePlatform;
}

/**
 * Overrides Apple platform detection in tests. Pass `null` to restore startup detection.
 */
export function setApplePlatformForTesting(override: boolean | null): void {
  applePlatformOverride = override;
}
