const missingFeatures: string[] = [];

if (typeof (globalThis as { Iterator?: { from?: unknown } }).Iterator?.from !== "function") {
  missingFeatures.push("Iterator helpers");
}
if (!("withResolvers" in Promise) || typeof Promise.withResolvers !== "function") {
  missingFeatures.push("Promise.withResolvers");
}
if (!("toReversed" in Array.prototype) || typeof Array.prototype.toReversed !== "function") {
  missingFeatures.push("Array.prototype.toReversed");
}
if (typeof globalThis.Worker !== "function") {
  missingFeatures.push("Web Workers");
}

const simulateUnsupportedBrowser = import.meta.env.DEV && new URLSearchParams(window.location.search).has("simulateUnsupportedBrowser");
if (simulateUnsupportedBrowser) {
  missingFeatures.push("simulated missing capability (development only)");
}

if (missingFeatures.length > 0) {
  document.getElementById("root")?.classList.add("browser-compatibility-unsupported");
  const reason = document.getElementById("browser-compatibility-reason");
  if (reason) {
    reason.textContent = `Missing browser capabilities: ${missingFeatures.join(", ")}.`;
  }
} else {
  document.getElementById("root")?.replaceChildren();
  void import("./index");
}
