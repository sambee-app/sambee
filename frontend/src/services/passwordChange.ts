export const PASSWORD_CHANGE_PATH = "/change-password";
export const PASSWORD_CHANGED_MARKER = "sambee_password_changed";

let required = false;
const listeners = new Set<() => void>();

export function setPasswordChangeRequired(value: boolean): void {
  if (required === value) return;
  required = value;
  for (const listener of listeners) listener();
}

export function isPasswordChangeRequired(): boolean {
  return required;
}

export function subscribePasswordChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
