export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const view = new DataView(bytes.buffer);
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
