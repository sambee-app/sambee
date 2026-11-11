+++
title = "What's New"
+++

## Directory Navigation

- Full index verification is not run on a fixed schedule (15 minutes) anymore. Instead, it's now treated as a safety net, with a default interval of 24 hours while change monitoring is healthy and 30 minutes when it is not. Linux Companion network and FUSE drives use the degraded interval because native monitoring cannot report remote changes.
- Directory listings of folders with many subfolders and/or files were slow and caused index re-scans.
- Moving up from a subfolder to a folder with thousands of subfolders waited for the server instead of using data cached in the frontend.

## Image Viewer

- Improved the speed and smoothness of image display and animation when browsing between images in the viewer.
- Keyboard shortcuts now include <kbd>Home</kbd> and <kbd>End</kbd> to move to the first and last image in a folder, respectively.
- New settings category **Administration** > **Image Viewer**:
   - **Image conversion threshold**: this was moved from the config file to the settings UI and the default was changed from 512 KB to 5 MB.
   - **Image conversion preference**: choose between conversion speed (default) and target image size.
   - ImageMagick settings were moved here from **System**.
- New settings category **Personal** > **Image Viewer**:
   - **Transition**: choose the animation between images in desktop mode (default: no animation).

## PDF Viewer

- New settings category **Administration** > **PDF Viewer**:
   - PDF settings were moved here from **System**.

## Unencrypted HTTP Support

- The previous fix for `crypto.randomUUID` errors over unencrypted HTTP connections to Sambee were incomplete. A test now ensures that this function is not introduced again.

## ZIP Archives

- When extracting files from a subfolder of a ZIP archive, the subfolder was created in the target, too.

## Security

- Updated all dependencies with known issues or vulnerabilities to fixed versions.

## Logging

- Docker container logs are now redacted so that session cookies and other credentials don't get logged.
- Docker container log messages from Uvicorn (http layer) and spnego (authentication) are now filtered so that messages are only logged once per completed operation. Log messages are formatted to fit on one line.
