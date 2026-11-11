+++
title = "View Images and Read Documents"
+++

Sambee can display many types of files directly in the browser.

## Images

Preview Photoshop designs, HEIC photos, and other [supported formats](../../reference/supported-file-formats/) without their desktop apps. Some previews show a converted image, for example, a PSD shows its flattened composite and a multi-page TIFF shows its first page.

On SMB connections, Sambee shrinks large images and converts formats the browser cannot render. The administrator chooses between faster conversion and smaller preview files.

Local-drive images come directly from Companion without backend image conversion. Downloaded images are always the unaltered original.

Desktop keyboard and mouse-button navigation keeps the displayed image visible until the requested image is ready. Repeated navigation selects the latest requested target and can skip intermediate images. If loading fails, the current image stays visible; use Retry or select another image. Image-specific actions are unavailable while a replacement loads.

Use Home for the first image and End for the last image. In an archive, End can take time while Sambee loads the remaining directory pages. Another navigation action cancels that jump.

**Settings > Personal > Image viewer > Transition** selects **Carousel** or **No animation** for desktop navigation. Touch swipes and touch navigation buttons keep their existing animation and loading behavior, including on touchscreen laptops. The preference is saved with your account and also applies to local-drive images.

## PDFs

PDF search works in any PDF document that has a text layer.

While the PDF viewer optimizes documents for display in the browser, downloaded files are always the unaltered original.

## Markdown

Markdown files are shown fully rendered for easier reading rather than as raw source code.

Markdown editing is covered separately in [Edit Markdown](../edit-markdown/).

To use an installed app instead of a preview, see [Edit Files in Desktop Apps](../../use-local-drives-and-desktop-apps/edit-files-in-desktop-apps/).

## Full List of Supported File Types

See [Supported File Formats](../../reference/supported-file-formats/) for a complete list of supported file types.
