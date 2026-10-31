+++
title = "Supported File Formats"
+++

This page lists the file types Sambee can process, open or edit in its browser-based UI.

## Viewers and Editors

| Category | Extensions | What to expect |
|---|---|---|
| Common browser image formats | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.svg`, `.avif` | Open in the image viewer with zoom, pan, and related controls. |
| Converted image formats | `.tif`, `.tiff`, `.heic`, `.heif`, `.bmp`, `.dib`, `.ico`, `.cur`, `.pcx`, `.tga`, `.ppm`, `.pgm`, `.pbm`, `.pnm`, `.xbm`, `.xpm`, `.psd`, `.psb`, `.eps`, `.ai`, `.jp2`, `.j2k`, `.jpt`, `.j2c`, `.jpc`, `.jxl`, `.exr`, `.hdr`, `.fits`, `.fit`, `.fts`, `.svs`, `.ndpi`, `.scn`, `.mrxs`, `.vms`, `.vmu`, `.bif`, `.img`, `.mat` | Sambee converts the file into a browser-ready image before opening it in the image viewer. |
| PDF | `.pdf` | Open in the PDF viewer with page navigation, search, zoom, and download support. |
| Markdown | `.md`, `.markdown` | Open in a rendered Markdown view with an optional edit path. |
| Text and code with syntax highlighting | `.js`, `.mjs`, `.jsx`, `.ts`, `.tsx`, `.py`, `.java`, `.rb`, `.php`, `.go`, `.rs`, `.c`, `.h`, `.cpp`, `.cc`, `.cxx`, `.hpp`, `.cs`, `.html`, `.htm`, `.css`, `.scss`, `.sass`, `.json`, `.xml`, `.yaml`, `.yml`, `.toml`, `.ini`, `.sql`, `.sh`, `.bash`, `.ps1` | Open in the CodeMirror-based source editor with syntax highlighting. |
| Text and code without syntax highlighting | `.txt`, `.conf`, `.log`, `.env`, `.bat`, `.cmd` | Open in the CodeMirror-based source editor as plain text. |

### Format-Specific Notes

Some converted image formats have specific behavior that is useful to know ahead of time.

- CMYK images are converted to browser-safe sRGB.
- Multi-page TIFF files open with the first page rather than every page in the source file.
- PSD and PSB files show the flattened composite view, not interactive layer editing.
- EPS and AI files are rendered into a high-quality raster image for viewing in the browser.
- HDR formats such as EXR and Radiance HDR are tone-mapped for ordinary browser display.
- Whole-slide formats such as SVS, NDPI, SCN, MRXS, VMS, VMU, and BIF open as an overview or first practical level rather than as a full microscopy workstation.
- FITS and similar scientific-image files use visibility scaling so the content is inspectable in the browser.

## Archive Formats

Sambee can browse and extract `.zip` archives.

| Archive format | Supported compression methods | Notes |
|---|---|---|
| ZIP | Stored, Deflate, BZIP2 | ZIP64 archives are supported. Entries that use other compression methods can't be opened or extracted. |

## When a File Type Is Not Supported or You Need the Original

If a file type is not supported by Sambee's viewers, or if you need the original editing experience, use one of the following:

- Download the file.
- Open it in a desktop app through Companion.

For the broader workflow explanation, see [View Images & Read Documents](../../view-and-edit-files/view-images-and-read-documents/).
