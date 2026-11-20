use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::server::localization::LocalizationState;

pub const UI_LANGUAGES: &[&str] = &["en", "zh-Hans", "nl", "fr", "de", "it", "ko", "ja", "pl", "pt", "es", "sv"];
const CATALOGS: &[(&str, &str)] = include!(concat!(env!("OUT_DIR"), "/catalogs.rs"));
type Messages = BTreeMap<String, String>;

#[derive(Deserialize)]
struct Catalog {
    native: Messages,
}

fn english() -> &'static Messages {
    static ENGLISH: OnceLock<Messages> = OnceLock::new();
    ENGLISH.get_or_init(|| serde_json::from_str(include_str!("../../src/i18n/native.en.json")).expect("Valid English native catalog"))
}

fn catalogs() -> &'static BTreeMap<&'static str, Messages> {
    static TRANSLATIONS: OnceLock<BTreeMap<&str, Messages>> = OnceLock::new();
    TRANSLATIONS.get_or_init(|| {
        CATALOGS
            .iter()
            .filter_map(|(language, json)| match serde_json::from_str::<Catalog>(json) {
                Ok(catalog) => Some((*language, catalog.native)),
                Err(error) => {
                    log::error!("Could not load Companion native catalog {language}: {error}");
                    None
                }
            })
            .collect()
    })
}

pub fn has_catalog(language: &str) -> bool {
    matches!(language, "en" | "en-XA" | "browser") || catalogs().contains_key(language)
}

pub struct NativeLocale {
    messages: Option<&'static Messages>,
}

impl NativeLocale {
    pub fn from_app(app: &AppHandle) -> Self {
        let current = app.try_state::<Arc<LocalizationState>>().and_then(|state| state.get_current());
        Self {
            messages: current.and_then(|state| catalogs().get(state.language.as_str())),
        }
    }

    pub fn text(&self, key: &'static str) -> &'static str {
        self.messages
            .and_then(|messages| messages.get(key))
            .or_else(|| english().get(key))
            .map(String::as_str)
            .expect("Native message key exists in English")
    }

    pub fn format(&self, key: &'static str, values: &[(&str, &str)]) -> String {
        // Only interpolate the catalog. Filenames can contain literal braces.
        let mut output = String::new();
        let mut rest = self.text(key);
        while let Some((head, tail)) = rest.split_once("{{") {
            let Some((name, remaining)) = tail.split_once("}}") else { break };
            output.push_str(head);
            output.push_str(
                values
                    .iter()
                    .find(|(placeholder, _)| *placeholder == name.trim())
                    .map_or(name, |(_, value)| *value),
            );
            rest = remaining;
        }
        output.push_str(rest);
        output
    }

    pub fn is_title(key: &str, title: &str) -> bool {
        english().get(key).is_some_and(|message| message == title)
            || catalogs()
                .values()
                .any(|messages| messages.get(key).is_some_and(|message| message == title))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(debug_assertions)]
    #[test]
    fn bundled_catalogs_have_native_translations() {
        let messages = catalogs().get("de").expect("Bundled German pilot");
        let locale = NativeLocale { messages: Some(messages) };
        assert_ne!(locale.text("trayQuit"), english()["trayQuit"]);
    }

    #[test]
    fn interpolates_only_the_message_not_the_filename() {
        let locale = NativeLocale { messages: None };
        assert_eq!(
            locale.format("uploading", &[("filename", "draft-{{percent}}.txt"), ("percent", "40%")]),
            "Uploading (40%): draft-{{percent}}.txt"
        );
    }
}
