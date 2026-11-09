+++
title = "What's New"
+++

## Directory Navigation

- Full index verification is not run on a fixed schedule (15 minutes) anymore. Instead, it's now treated as a safety net, with a default interval of 24 hours while change monitoring is healthy and 30 minutes when it is not. Linux Companion network and FUSE drives use the degraded interval because native monitoring cannot report remote changes.
- Directory listings of folders with thousands of subfolders were slow and caused index re-scans.
- Moving up from a subfolder to a folder with thousands of subfolders waited for the server instead of using data cached in the frontend.

## Unencrypted HTTP Support

- The previous fix for `crypto.randomUUID` errors over unencrypted HTTP connections to Sambee were incomplete. A test now ensures that this function is not introduced again.

## ZIP Archives

- When extracting files from a subfolder of a ZIP archive, the subfolder was created in the target, too.

## Dependency Security

- Updated all dependencies with known issues or vulnerabilities to fixed versions.
