import { vi } from "vitest";

export async function mockReactI18next() {
  const actual = await vi.importActual<typeof import("react-i18next")>("react-i18next");
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { dir: () => "ltr" },
    }),
  };
}
