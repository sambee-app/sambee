+++
title = "Browser-to-Companion Trust Model"
+++

## Shared Settings Delivery

Successful pairing makes the paired browser origin the authority for theme, localization, and directory-index resource policy. Pairing an origin again makes that origin the authority and moves it to the end of pairing order.

When the authority is unpaired, Companion gives authority to the most recently paired remaining origin. The authority becomes `null` only when no paired origin remains. Other status requests or failed pairing attempts do not change authority.

On startup, Companion repairs an authority that is `null` or names an origin that is no longer paired. It uses the same most-recently-paired fallback rule. Existing pairings and the last valid settings remain available.

Browser tabs check the Companion status every 30 seconds. A tab with an authority conflict stays active in its retry loop without requesting a settings grant. It resumes settings delivery when its origin becomes the authority again.

The version-1 protocol uses typed `theme`, `localization`, and `directory_index` sections. Companion stores the authority in the OS keychain and reports its origin and delivery status in the Preferences panel.
