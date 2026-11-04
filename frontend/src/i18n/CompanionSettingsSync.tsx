import { useEffect } from "react";
import { companionSettingsSync } from "../services/companionSettingsSync";

export function CompanionSettingsSync() {
  useEffect(() => companionSettingsSync.start(), []);
  return null;
}
