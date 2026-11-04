export const COMPANION_SETTINGS_VERSION = 1;
export const COMPANION_SETTINGS_SECTIONS = ["theme", "localization", "directory_index"] as const;
export type CompanionSettingsSection = (typeof COMPANION_SETTINGS_SECTIONS)[number];

export interface CompanionSectionMarker {
  version: number;
  marker: string;
  user_scope: string | null;
}

export interface CompanionSettingsMetadata {
  version: number;
  backend_identity: string;
  theme: CompanionSectionMarker;
  localization: CompanionSectionMarker;
  directory_index: CompanionSectionMarker;
}

export interface CompanionSettingsGrantBinding {
  version: number;
  companion_id: string;
  challenge: string;
  origin: string;
  sections: CompanionSettingsSection[];
  switch_user: boolean;
}

export interface CompanionSettingsGrant extends CompanionSettingsMetadata {
  grant: string;
  expires_in_seconds: number;
}

export interface CompanionSettingsStatus {
  version: number;
  companion_id: string;
  authoritative_origin: string | null;
  authority_generation: number;
  status: "defaults_active" | "synchronized" | "authority_conflict" | "delivery_failed";
  challenge: string | null;
  message: string | null;
  results?: Partial<Record<CompanionSettingsSection, "defaults_active" | "synchronized" | "delivery_failed">>;
  sections: Partial<
    Record<
      CompanionSettingsSection,
      CompanionSectionMarker & {
        origin: string;
        backend_identity: string;
        result: "synchronized" | "delivery_failed";
      }
    >
  >;
}
