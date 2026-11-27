# Remove Obsolete Text Viewer References

This change is separate from [Delete Files from Viewers](VIEWER_DELETE_PLAN.md). It is not related to file deletion.

The [viewer registry](../frontend/src/utils/FileTypeRegistry.ts) already loads [`TextEditor`](../frontend/src/components/Viewer/TextEditor.tsx) for text files. The [picker label](../frontend/src/i18n/resources.ts) already says **Text Editor**. The [viewer architecture guide](../website/content/docs/3.0/developer-guide/frontend-architecture/viewer-architecture-and-preview-contracts/index.md) already says **Text Editor**. There is no separate Text Viewer component to remove.

- Use **Text Editor** in the test descriptions that still say "text viewer": the [viewer support tests](../frontend/src/utils/__tests__/viewer-support.test.ts), the [picker tests](../frontend/src/components/FileBrowser/__tests__/BrowserViewerPicker.test.tsx), and the [file-list shortcut tests](../frontend/src/pages/__tests__/FileBrowser-interactions-listing.test.tsx).
- Rename the `text-viewer-content` test hook in the [Text Editor](../frontend/src/components/Viewer/TextEditor.tsx) and update its [browser test consumer](../frontend/e2e/markdown-viewer.spec.ts) in the same change.
- Preserve `viewer=text`, legacy URL mode normalization, saved preferences, settings, localization keys, and recovery-draft keys that the editor still uses. Keep compatibility tests and historical versioned docs. Do not rename shared viewer infrastructure solely because the Text Editor uses it.

## Verification

- Verify that text still opens directly in the editor, that existing text URLs still work, and that the picker still displays **Text Editor**. Run the browser test that uses the renamed selector.
