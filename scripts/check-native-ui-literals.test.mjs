import assert from "node:assert/strict";
import { test } from "node:test";
import { findNativeUiLiterals } from "./check-native-ui-literals.mjs";

test("finds direct literal text in native UI calls", () => {
  const source = `
    builder.title("Title").tooltip(r#"Tip"#);
    app.dialog().message("Message");
    MenuItem::new(app, "Open", true, None);
    MenuItem::with_id(app, format!("id,{}", number), "Quit", true, None);
  `;
  assert.deepEqual(findNativeUiLiterals(source), [2, 2, 3, 4, 5]);
});

test("accepts translated text, IDs, comments, and justified exceptions", () => {
  const source = `
    // builder.title("Comment");
    /* nested /* .tooltip("Comment") */ comment */
    let example = r#"builder.title("Not code")"#;
    MenuItem::with_id(app, "id", locale.text("trayQuit"), true, None);
    builder.title(locale.text("title"));
    // localization-lint-ignore: The product name is not translated.
    builder.tooltip("Sambee Companion");
  `;
  assert.deepEqual(findNativeUiLiterals(source), []);
});

test("rejects literal window titles and tray tooltips set after creation", () => {
  const source = `
    window.set_title("Settings");
    tray.set_tooltip(Some(r#"Companion status"#));
    tray.set_tooltip("Companion status");
    window.set_title(locale.text("preferencesTitle"));
    tray.set_tooltip(Some(locale.text("trayTooltip")));
  `;
  assert.deepEqual(findNativeUiLiterals(source), [2, 3, 4]);
});

test("does not accept an empty exception", () => {
  assert.deepEqual(findNativeUiLiterals('// localization-lint-ignore:\nbuilder.title("Title");'), [2]);
});
