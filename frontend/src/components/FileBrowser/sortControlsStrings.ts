import type { ParseKeys } from "i18next";
import { translate } from "../../i18n";
import type { SortField } from "../../pages/FileBrowser/types";

const SORT_FIELD_KEYS: Record<SortField, ParseKeys> = {
  name: "fileBrowser.chrome.sort.fields.name",
  size: "fileBrowser.chrome.sort.fields.size",
  modified: "fileBrowser.chrome.sort.fields.modified",
  type: "fileBrowser.chrome.sort.fields.type",
};

export const SORT_CONTROLS_STRINGS = {
  fieldLabel(field: SortField) {
    return translate(SORT_FIELD_KEYS[field]);
  },
  get ARIA_LABEL() {
    return translate("fileBrowser.chrome.sort.ariaLabel");
  },
  get ASCENDING() {
    return translate("fileBrowser.chrome.sort.direction.ascending");
  },
  get DESCENDING() {
    return translate("fileBrowser.chrome.sort.direction.descending");
  },
};
