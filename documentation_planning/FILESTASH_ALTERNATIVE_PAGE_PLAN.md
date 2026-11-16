# Filestash Alternative Marketing Page Plan

## Purpose

This document defines the competitive research, positioning strategy, website architecture, and full page copy for a standalone **Filestash Alternative** marketing page at `https://sambee.net/filestash-alternative/` (outside `/docs/`).

The goal is to win self-hosters, NAS owners, system administrators, and teams who evaluate Filestash for SMB file servers or workstation workflows. The page focuses on bold, structural differences in licensing, security architecture, storage depth, file-management ergonomics, and desktop app editing—never on minor UI bugs.

---

## 1. Competitive Research Summary

### 1.1 What Filestash Is

Filestash ([`mickael-kerjean/filestash`](https://github.com/mickael-kerjean/filestash), [`filestash.app`](https://www.filestash.app/)) is a Go-based universal web file portal built around a plugin architecture.

- **Core pitch**: "A Dropbox-like file manager that speaks every storage protocol."
- **Supported backends (25+)**: S3, MinIO, Backblaze B2, Wasabi, Storj, Azure Blob, Google Cloud Storage, Dropbox, Google Drive, FTP, FTPS, SFTP, WebDAV, NFS, SMB, Git/GitHub/GitLab/Gitea, LDAP, MySQL, CardDAV, CalDAV, IPFS, and local server paths.
- **Extra capabilities**: Protocol gateways (re-exposing storage over SFTP, WebDAV, S3, FTP, or MCP), public share links (mountable as WebDAV drives), workflows, and Collabora/OnlyOffice browser editing via WOPI.
- **License and pricing model** (verified from `https://www.filestash.app/pricing/`):
  - **Hobby (Self-Hosted)**: Free under **AGPLv3**. Includes basic protocol plugins, `htpasswd` / passthrough / anonymous login, and the `/admin` web console.
  - **Self-Served / Pro**: Starts at **$50/month** (3 seats included, single node). Unlocks commercial licensing, **SSO (OIDC, SAML, LDAP) + RBAC**, proxy auth, database auth, antivirus hooks, and audit logs.
  - **Enterprise**: Starts at **$290/month** (unlimited users; custom payment plans from $750/month). Unlocks white-labeling/custom branding, fine-grained RBAC, **environment-variable configuration**, high availability, S3/Azure/GCS enterprise features, and priority support.

### 1.2 Where Filestash Genuinely Wins (Keep Our Claims Honest)

Credible technical marketing acknowledges what the competitor does well:

1. **Multi-cloud and legacy protocol breadth**: If a team needs one browser UI for S3 buckets, FTP servers, Dropbox, Google Drive, and Git repositories, Filestash supports them and Sambee does not.
2. **Outbound protocol gateways**: Filestash can expose backend storage outward as SFTP, WebDAV, S3, or MCP endpoints.
3. **Anonymous external share links**: Filestash lets users generate public links for external recipients who do not have accounts on the storage server.
4. **Long-running open-source presence & sensible file-serving defaults**: Active commits since 2017, a non-root main app image, SVG disabled by default, and a default-deny CSP on raw file responses.

### 1.3 Six Structural Weaknesses of Filestash for SMB & Workstation Users

Every point below comes from Filestash's architecture, license model, `docker-compose.yml`, and long-standing design choices—not transient bugs:

1. **The "SSO & Security Tax" (AGPLv3 Open-Core vs. MIT)**
   - Self-hosters and teams routinely run Keycloak, Authentik, Authelia, Pocket ID, Okta, or OneLogin. Filestash puts **OIDC, SAML, LDAP, MFA, RBAC, proxy auth, audit logs, intrusion detection (self-hosted), early security patches, branding, and environment-variable config** behind recurring commercial subscriptions ($600 to $3,480+ per year).
   - Sambee uses the **permissive MIT license**. Every feature—OIDC single sign-on, identity-provider group-to-role mapping (`Administrator`, `Editor`, `Viewer`), passwordless OIDC-only mode, security audit exports, and immediate security updates—is **free forever for unlimited users**.

2. **Security Architecture, Credential Hygiene, and Supply-Chain Integrity**
   - **Session & credential exposure**: In Filestash (`server/pkg/session/handler_auth_direct.go`), the user's backend SMB password sits inside a 1-week stateless AES-GCM cookie/bearer blob. Individual sessions cannot be revoked without rotating `general.secret_key` (which invalidates all users and shares at once), and `general.secret_key`, SMTP passwords, and pre-saved connection secrets live in plaintext in `config.json`. Worse, Filestash's WOPI integration (`server/plugin/plg_editor_wopi/handler.go`) reuses that session blob as `access_token` in `/api/wopi/files/...?access_token=...` query strings, exposing credentials to Collabora and reverse-proxy access logs.
   - **Proxy spoofing & brute-force surface**: Filestash trusts the client-supplied `X-Forwarded-For` / `X-Real-Ip` header unconditionally (`server/pkg/middleware/http.go`) without a trusted-proxy CIDR check, and applies a single global rate limiter across all callers rather than per-IP or per-username lockouts.
   - **Container & supply-chain gaps**: Filestash's default [`docker/docker-compose.yml`](https://github.com/mickael-kerjean/filestash/blob/master/docker/docker-compose.yml) pulls floating `machines/filestash:latest` with `CANARY=true`, runs Collabora as `user: root` while `curl`-fetching an external GitHub Gist CSS file at container startup, and has no public CI security workflows, no Cosign image signatures, no SBOM/provenance bundles, and no `SECURITY.md`.
   - **Sambee's defense-in-depth security**:
     - **Revocable server sessions & zero URL tokens**: Browser sessions hold only a short-lived in-memory API token and an `HttpOnly` cookie; IdP refresh tokens are encrypted on the server; users and admins can inspect and **revoke individual browser sessions** immediately; Companion handoffs pass single-use tokens in **JSON request bodies** (never query strings); and container logs redact cookies and credentials.
     - **Hardened proxy trust & auth rate limits**: Uvicorn runs with `--no-proxy-headers` by default; `X-Forwarded-For` is honored *only* from administrator-configured **Trusted Reverse Proxy CIDRs**; and login endpoints enforce granular **per-IP and case-folded per-username rate limits**.
     - **Verifiable supply chain & hardened container**: Digest-pinned base images (`@sha256:...`), hash-locked Python dependencies (`--require-hashes`), **`pip` and `ensurepip` removed** from the production image, non-root UID `1000`, weekly + pre-release **Trivy** container scans, automated `pip-audit` / `npm audit` / `cargo audit` checks, commit-SHA-pinned GitHub Actions, **Cosign-signed images** with **SBOM and provenance bundles**, and cryptographically signed Companion installers/updates.
     - **Sandboxed media, archives & desktop bridge**: `HTML`, `XHTML`, and `SVG` files (including inside `.zip` archives) never execute active content in the viewer; `imagemagick-policy.xml` blocks `HTTP`/`HTTPS`/`URL` delegates and `@*` path reads while enforcing strict memory/pixel/time bounds over `stdin`/`stdout`; and Companion binds strictly to `127.0.0.1` with **exact-origin numeric-code pairing** and timestamped per-method/per-URL **HMAC request signatures**.

3. **Thin SMB Plugin vs. First-Class SMB2/SMB3 + Local Drives**
   - Filestash routes all 25+ backends through one 8-method interface (`Ls, Stat, Cat, Mkdir, Rm, Mv, Save, Touch`). Its SMB plugin (`server/plugin/plg_backend_samba/`, built on `go-smb2`) is thin by design:
     - **NTLM or Guest authentication only**: No Kerberos support ([`mickael-kerjean/filestash#862`](https://github.com/mickael-kerjean/filestash/issues/862) was closed without implementation).
     - **No SMB transport security controls**: No admin-configurable SMB signing or SMB3 encryption policy.
     - **No live filesystem watching**: No SMB2/SMB3 `CHANGE_NOTIFY` integration to keep open browser views or folder caches fresh when another client modifies a share.
     - **No cross-share moves**: `Mv` returns `ErrNotImplemented` across different shares.
     - **Live network crawl search by default**: Filestash's default `plg_search_stateless` walks the remote directory tree over the network on search unless an admin configures and maintains a separate crawler plugin (`plg_search_sqlitefts`).
     - **No local client drives**: The browser only sees server-mounted paths, never the user's own laptop or workstation drives.
   - Sambee treats **SMB shares and local drives** as equal, deeply engineered backends:
     - **Kerberos + NTLM** (including a strict **Kerberos-required** mode that blocks NTLM fallback), mandatory **SMB signing**, and optional **SMB3 transport encryption**.
     - **Real-time SMB2/SMB3 `CHANGE_NOTIFY`** over WebSockets plus an event-driven **SQLite directory index** (`Ctrl+K` jumps to any directory across tens of thousands of folders in milliseconds).
     - **Local workstation drives** via the optional **Sambee Companion** app, allowing direct browsing and transfers between local disks and remote SMB shares.

4. **Single-Pane "Dropbox Portal" vs. Commander-Class File Manager**
   - Filestash copies consumer cloud portals: single-pane browsing, drag-and-drop moves, non-configurable shortcuts ([`mickael-kerjean/filestash#990`](https://github.com/mickael-kerjean/filestash/issues/990)), and missing explicit Copy/Move UI controls that hurt desktop efficiency and break touch workflows ([`mickael-kerjean/filestash#525`](https://github.com/mickael-kerjean/filestash/issues/525), [`mickael-kerjean/filestash#801`](https://github.com/mickael-kerjean/filestash/issues/801)).
   - Sambee is built to replace **Windows File Explorer and Total Commander**:
     - **Dual-pane mode (`Ctrl+B`)** and single-pane mode, with instant pane-sync shortcuts (`Ctrl+Left` / `Ctrl+Right`).
     - **Full Copy and Move workflows** across SMB connections, local drives, and ZIP archives, with overwrite-all, replace-if-newer, and safe folder merging.
     - **Zero-extract streaming ZIP archives**: Open `.zip` files like ordinary folders instantaneously; view files inside archives or stream-extract across backends without unpacking to temporary disk first.
     - **Keyboard-first desktop controls + dedicated mobile UI**: Mouse `Shift`-range selection and full shortcuts on desktop; long-press multi-selection, per-row touch menus, bottom action bar, and native OS share-sheet integration on phones and tablets.

5. **Heavy Collabora/WOPI Sidecars vs. Native Desktop Apps + Rich Built-In Viewers**
   - Filestash's default [`docker/docker-compose.yml`](https://github.com/mickael-kerjean/filestash/blob/master/docker/docker-compose.yml) runs a second heavy container (`collabora/code`) to force Office editing into a browser iframe. In practice, WOPI + Collabora consumes gigabytes of RAM, breaks frequently behind HTTPS reverse proxies and CSP rules ([`mickael-kerjean/filestash#807`](https://github.com/mickael-kerjean/filestash/issues/807)), compromises complex Word/Excel formatting, and does nothing for Adobe Photoshop, Illustrator, CAD, or specialized desktop apps.
   - Sambee runs as **one lightweight container** and combines fast browser tools with real desktop editing:
     - **In-browser viewing & editing**: Fast swipeable image viewer with on-the-fly conversion for **PSD, PSB, AI, EPS, HEIC, JXL, AVIF, TIFF, EXR, HDR, FITS, and whole-slide formats**; high-fidelity **PDF viewer** (text search, CMYK/ICC color profiles, password-protected PDFs, safe compatibility normalization); **CodeMirror** code editor with syntax highlighting and regex search/replace; and **Markdown viewer/editor** with **WYSIWYG table editing** and multi-page PDF print layout.
     - **Native desktop app editing (`Ctrl+Enter`)** via Sambee Companion: Open `.docx`, `.xlsx`, `.psd`, or any file in the real installed desktop app (Word, Excel, LibreOffice, Photoshop), protected by **server-side edit locks**, **conflict detection**, and **unsaved-session crash recovery**, with one-step upload back to the original SMB share.

6. **Operational Clarity and Built-In System Health**
   - Filestash relies on an `/admin` web wizard with sparse config-file/env documentation ([`mickael-kerjean/filestash#745`](https://github.com/mickael-kerjean/filestash/issues/745)) and gates environment-variable configuration behind its Enterprise plan.
   - Sambee deploys from a clean single-service `docker-compose.yml` (`ghcr.io/sambee-app/sambee:stable`), applies UI settings automatically with no forgotten "Save" buttons, redacts secrets in logs, and ships **live System Health Monitoring** (host RAM, cache-excluded container cgroup memory, normalized CPU load, Intel/AMD/Raspberry Pi CPU thermal limits, and non-intrusive SMB/local free-space checks).

---

## 2. Target Audience, Search Intent, and Positioning

### 2.1 Primary Buyer Personas

1. **The Frustrated Self-Hoster / Homelabber**
   - Runs TrueNAS, Synology, Unraid, Proxmox, or Linux Samba shares alongside Authentik, Authelia, or Keycloak.
   - Tried Filestash (or File Browser / Nextcloud), hit the OIDC paywall, disliked Collabora RAM bloat, or wanted a faster dual-pane interface that works cleanly on both desktop and phone.
2. **The SMB / Small-to-Midsize IT Administrator**
   - Runs Windows File Servers or Samba with Active Directory / Kerberos and an OIDC identity provider.
   - Wants employees to browse shares from any device and edit Office or creative files in real desktop apps without VPN + mapped-drive fragility—and without migrating terabytes into Nextcloud or SharePoint.
3. **Creative, Engineering, and Knowledge Workers**
   - Work with mixed folders full of PDFs, Markdown notes, code, high-res photos (`HEIC`, `TIFF`, `JXL`), and Adobe assets (`PSD`, `AI`, `EPS`).
   - Need instant visual previews in the browser and one-shortcut (`Ctrl+Enter`) round-trip editing in native desktop software.

### 2.2 Core Positioning Thesis

> **Depth beats breadth.**
> Filestash is a universal protocol adapter built to expose 25 cloud APIs through a Dropbox-style portal.
> **Sambee is a dedicated file workspace built to make SMB shares and local drives faster than your desktop file manager—with native app editing and free OIDC single sign-on under the MIT license.**

### 2.3 Target Search Queries (SEO)

- Primary: `filestash alternative`, `open source filestash alternative`, `self-hosted filestash alternative`
- Secondary: `filestash vs sambee`, `filestash oidc free alternative`, `self-hosted smb web client`, `browser file manager for smb shares`, `web file manager dual pane smb`

---

## 3. Design System & Website Integration Architecture (`sambee.net`)

### 3.1 Three Distinct Page Families: Recognizably Related, Never Cloned

The homepage (`https://sambee.net/`) must remain visually unique. Visitors moving from `/` to `/filestash-alternative/` (or landing directly from search) should immediately recognize Sambee's architectural brand identity without seeing a recycled homepage layout.

`sambee.net` therefore separates its templates into three clear page families:

| Page Family | Templates & Styles | Visual Posture & Role |
|---|---|---|
| **1. Flagship Homepage** (`/` — Unique) | `layouts/home.html`, `partials/home/*`, `assets/css/homepage.css` | **Panoramic brand showcase**: Full-width `4.5rem` (`text-7xl`) billboard hero, 3-card problem row, full-bleed UI preview, 3×2 benefit cards with decorative trails, 10-group feature catalog, 6-card format grid. Exclusive to `/`. |
| **2. Tech Marketing & Comparison Pages** (`/filestash-alternative/`, future alternatives & solution pages) | `layouts/_default/comparison.html`, `partials/marketing/*`, `assets/css/marketing.css` | **Editorial technical dossier**: Asymmetric `7:5` split hero with an Executive Scorecard panel, sticky section jump bar, upfront 2-column Honest Fit split, sticky-header comparison matrix, `4:8` editorial deep-dive chapters broken by an architecture diagram band, `5:7` terminal test-drive split, and `<details>` accordion FAQ. |
| **3. Documentation & Legal Pages** (`/docs/...`, `/imprint/`, `/privacy-policy/`) | `layouts/docs/*` + `docs.css`; `layouts/_default/standalone.html` + `standalone.css` | **Reference reading shells**: Three-column versioned docs reader (`1320px`) and single-column legal prose shell. |

**Shared Brand DNA ("Recognizably Sambee"):**
- **Surfaces & rules**: Warm architectural paper (`#fbf9f4` `page`, `#f5f3ee` `low`, `#f0eee9` `mid`, `#eae8e3` `high`) and warm obsidian dark mode (`#1b1c19` `page`, `#24231f` `low`, `#2b2925` `mid`) framed inside the `1131px` `.ledger-shell` side rails (`1px` `rule-soft` internal hairlines, `2px` `rule-strong` section boundaries, `0px` sharp corners everywhere).
- **Typography trio**: `Newsreader` (display headings), `Work Sans` (body prose), and `Space Grotesk` (uppercase tracked eyebrows, telemetry badges, indices, and buttons), applying **strictly one `type-*` semantic utility per text element** (`website/content/docs/0.7/website-dev-guide/site-systems/typography-usage-and-boundaries/index.md`).
- **Shared UI primitives**: `.btn` variants (`buttons.css`), Material Symbols icons, `partials/components/button-kind-class.html`, `partials/components/responsive-image.html`, and a shared `partials/components/link-href.html`.

**Deliberate Structural Differences from the Homepage:**
- Zero reuse of `partials/home/*` section templates (`hero.html`, `problem-value.html`, `benefits.html`, `features.html`, `deployment.html` stay untouched and exclusive to `/`).
- **Asymmetric `7:5` hero** with a compact editorial `Newsreader` scale (`2.5rem` mobile → `3.35rem` desktop, roman `type-copy` lead) paired beside a structured **Executive Scorecard** instead of a giant single-column `4.5rem` billboard + italic subhead.
- **Sticky sub-header wayfinding bar** and **2-column / `4:8` editorial splits** instead of repeating the homepage's 3-column card grids.

---

### 3.2 Web Design Best Practices Applied

1. **3-Second Above-the-Fold Clarity (F-Pattern Asymmetric Hero)**
   High-intent search visitors (`"filestash alternative"`) want immediate confirmation of fit and proof. The left `7` columns state the core contrast and primary action; the right `5` columns (`surface-low`) render a 5-row **Executive Scorecard** (`License`, `SSO & Roles`, `SMB Security`, `Supply Chain`, `Container Footprint`) that technical buyers can scan in three seconds without scrolling.
2. **Non-Linear Wayfinding (Sticky Dossier Subnav)**
   Different evaluators care about different sections (CISOs jump to Security, sysadmins to Matrix or Test Drive, team leads to Fit). A slim `surface-mid` anchor bar sticks directly beneath the global header (`top: var(--header-height); z-index: 20`), scrolls horizontally with hidden scrollbars on small screens, and pairs with `scroll-margin-top: calc(var(--header-height) + var(--marketing-subnav-height) + 1rem)` on every section target so headings are never clipped.
3. **Trust-First Qualification Before Deep Claims**
   Placing the **2-Column "Honest Fit" Split** (`Switch to Sambee if...` vs. `Keep Filestash if...`) directly above the Comparison Matrix disarms skepticism early. Telling S3/FTP/Dropbox users upfront to stay with Filestash makes every SMB, security, and desktop-editing claim below immediately credible.
4. **Accessible, Mobile-Native Comparison Matrix UX**
   - **Visual hierarchy**: Category group rows (`surface-mid`, `type-label-eyebrow-strong`) break the 15 rows into five digestible blocks (`Licensing & Identity`, `Security & Supply Chain`, `SMB & Local Storage`, `File Management & Editing`, `Operations & Cloud Breadth`). The Sambee column uses a subtle `surface-low` tint and a `2px` top primary-gold rule so the eye tracks Sambee effortlessly.
   - **WCAG 1.4.1 dual coding (never color alone)**: Every cell pairs a distinct Material Symbol (`check_circle`, `lock`, `remove`) with an explicit bold verdict phrase (`Free for unlimited users`, `Paid plans only`, `Not supported`) plus concise technical context.
   - **Zero horizontal pinch-zooming on mobile**: On `md+` (`>= 768px`), the matrix renders as a semantic table with a sticky header row beneath the subnav. Below `md`, CSS grid/block rules stack each capability into a clean 2-row comparison card (`Capability` header → labeled `SAMBEE` row vs. `FILESTASH` row) so `360px` phones have zero horizontal overflow.
5. **Reading Ergonomics & Visual Cadence (`60–70ch` Measure + Mid-Page Visual Break)**
   Instead of six cramped equal-height cards, the six deep-dive pillars render as **`4:8` Editorial Split Chapters**: left rail with `01 //`–`06 //` index, `Newsreader` heading, and a `surface-mid` **`ui-current-primary-inset` takeaway callout**; right column with `max-w-[65ch]` `Work Sans` copy and structured bullet points. Halfway through (between Chapters `03` and `04`), a full-width **Visual Proof & Architecture Contrast Band** breaks text fatigue with a dual-pane screenshot and a 1-container vs. 2-container SVG diagram.
6. **Low-Friction Conversion & Progressive-Disclosure FAQ**
   - **Test-drive terminal split (`5:7` grid)**: Pairs three zero-risk assurances (`No migration`, `Runs beside Filestash on port 8000`, `Direct SMB2/SMB3 access`) and dual CTAs beside a labeled `docker-compose.yml` code panel with one-click copy.
   - **Native `<details>/<summary>` accordion FAQ**: Uses semantic HTML5 disclosure elements (first item `open` by default) for zero-JS keyboard accessibility, screen-reader `aria-expanded` support, `44×44px` minimum tap targets, and `prefers-reduced-motion: reduce` compliance.

---

### 3.3 Hugo File Map & Exact Technical Integration Contracts

| Concern | Planned Path | Integration Contract |
|---|---|---|
| Public URL | `https://sambee.net/filestash-alternative/` | Top-level page bundle outside `content/docs/`; unaffected by `validate-docs-content.py` and `validate-docs-output.py`. |
| Content bundle | `../website/content/filestash-alternative/index.md` | TOML front matter: `title` (**without** `\| Sambee`), `description`, `layout = "comparison"`, `data_key = "filestash_alternative"`. |
| Page data | `../website/data/filestash_alternative.yaml` | Holds all structured page content; future competitor pages (`filebrowser_alternative.yaml`, etc.) reuse the exact same schema. |
| Generic layout | `../website/themes/sambee/layouts/_default/comparison.html` | Resolves `$pageData := index hugo.Data .Params.data_key`, emits `FAQPage` JSON-LD via `{{ define "head" }}`, and renders `<div class="marketing-shell" data-pagefind-body>`. |
| Marketing partials | `../website/themes/sambee/layouts/partials/marketing/` | `hero-split.html`, `subnav.html`, `fit-split.html`, `matrix.html`, `chapter-list.html`, `visual-proof.html`, `test-drive.html`, `faq.html`. |
| Shared link helper | `../website/themes/sambee/layouts/partials/components/link-href.html` | Promoted from `partials/home/link-href.html` (which delegates to it) so both homepage and marketing pages resolve structured `target: { type: docs, book, section, page }` links via `docs/page-url.html`. |
| Marketing styles | `../website/themes/sambee/assets/css/marketing.css` | Imported in `main.css` after `homepage.css`. Owns `.marketing-shell`, `.marketing-section`, split grids, responsive matrix, and accordion FAQ styles without touching `homepage.css`. |
| `<head>` extension | `../website/themes/sambee/layouts/_default/baseof.html` | Add optional `{{ block "head" . }}{{ end }}` inside `<head>` so marketing templates can emit safe `dict ... \| jsonify` JSON-LD without polluting `<body>`. |
| Footer discovery | `../website/themes/sambee/layouts/partials/essentials/footer.html` & `footer.css` | Keep `.site-footer-legal` (`aria-label="Legal links"`) strictly for `Imprint` and `Privacy Policy`; add a separate `<nav class="site-footer-compare" aria-label="Comparisons">` fed from `params.toml` (`[[footer.comparisons]]`). |
| CTA & output checks | `../website/scripts/validate-homepage-ctas.py` & `../website/tests/` | Extend link validation to verify `data-marketing-link` anchors/routes in `/filestash-alternative/index.html`, and add Python built-output tests in `website/tests/`. |

**Critical Codebase Contracts to Preserve During Implementation:**
1. **No duplicate `| Sambee` in `<title>`**: `partials/essentials/head.html:49` automatically formats non-home titles as `printf "%s | %s" $resolvedPage.Title site.Title`. Set front-matter `title = "Filestash Alternative for SMB Shares & Local Drives"` so `<title>`, `og:title`, and `twitter:title` render `Filestash Alternative for SMB Shares & Local Drives | Sambee` once.
2. **Flush footer border & Pagefind indexing**: `baseof.html:50` applies `site-main--home` (`pb-0`) only when `.IsHome` is `true`. In `marketing.css`, define `.site-main:has(.marketing-shell) { @apply pb-0; }` (matching `.site-main:has(.standalone-shell)` in `standalone.css`) and collapse adjacent `.marketing-section` `2px` borders so the final section meets `.site-footer` cleanly with zero `pb-12` gap. Putting `data-pagefind-body` on `.marketing-shell` indexes the page under `page_kind:site`.
3. **Code-block highlighting & copy button**: `assets/css/code.css` and `COPY_BUTTON_SELECTOR` in `assets/js/main.js:5` require a `.content` ancestor around `.highlight` / `pre`. In `partials/marketing/test-drive.html`, render the YAML string with `{{ transform.Highlight $section.code "yaml" }}` inside `<div class="content marketing-code-surface">` so syntax colors, dark-mode borders, and the copy button work out of the box.
4. **Git LFS + WebP validation gate**: `.github/workflows/website-deploy.yml` runs `npm run images:validate` (`scripts/validate-webp-assets.py`) before `hugo` and tracks `website/assets/images/**` via Git LFS (`.gitattributes`). Launch Phase 1 using existing theme-aware assets (`images/home/sambee-screenshot.png`, `sambee-screenshot-dark.png`, `companion-screenshot.png`) plus an inline theme-aware SVG architecture diagram; when adding custom screenshots later, commit pre-generated `_*w.webp` files from `python3 scripts/generate-webp.py`.

---

## 4. Full Section-by-Section Wireframe & Copy Proposal

*(All proposed copy uses clear, direct, active Simplified Technical English while keeping bold marketing punch.)*

---

### Band 0: Asymmetric `7:5` Split Hero (`partials/marketing/hero-split.html`)

**Left Column (`7 cols`, `surface-page`):**
- **Eyebrow**: `COMPARE // FILESTASH ALTERNATIVE`
- **H1 (`Newsreader` 800, editorial scale)**: `Stop using a cloud adapter to manage your SMB shares.`
- **Lead (`Work Sans` roman `type-copy`, `max-w-[60ch]`)**: `Filestash connects to 25 protocols at surface depth—and locks OIDC single sign-on, audit logs, and early security patches behind monthly subscriptions. Sambee is purpose-built for SMB shares and local drives, with defense-in-depth security, dual-pane navigation, native desktop app editing, and free SSO under the MIT license.`
- **Actions**:
  - **Primary CTA (`kind: primary`)**: `Deploy with Docker` → `target: { type: docs, book: admin-guide, section: installation-and-deployment, page: deploy-sambee-with-docker }`
  - **Secondary CTA (`kind: outline`)**: `Jump to Comparison Matrix ↓` → `target: { type: anchor, id: comparison }`

**Right Column (`5 cols`, `surface-low`, left `1px` `rule-soft` divider on `lg+` — Executive Scorecard):**
- **Panel Header**: `AT A GLANCE // SAMBEE ADVANTAGE` (`type-label-eyebrow-strong`)
- **5 Telemetry Rows** (each separated by `1px` `rule-soft`):
  1. `LICENSE & COST` → **MIT Open Source — $0 forever, unlimited users** *(vs. AGPLv3 + $50–$290/mo tiers)*
  2. `IDENTITY & ACCESS` → **Free OIDC SSO + IdP group roles** *(vs. paywalled SSO & RBAC)*
  3. `SMB SECURITY` → **Kerberos + signing + SMB3 encryption** *(vs. NTLM/Guest only)*
  4. `SUPPLY CHAIN` → **Cosign-signed, SBOM + weekly Trivy scans** *(vs. unsigned `:latest` Compose)*
  5. `EDITING & FOOTPRINT` → **Native desktop apps in 1 container** *(vs. heavy Collabora WOPI sidecar)*

---

### Band 1: Sticky Dossier Sub-Navigation (`partials/marketing/subnav.html`)

- **Surface**: `surface-mid`, sticky below `.nav-header`, `2px` bottom `rule-strong`
- **Anchor Items (`type-label-sm`)**:
  - `01 // Honest Fit` (`#fit`)
  - `02 // Matrix` (`#comparison`)
  - `03 // Security & Depth` (`#pillars`)
  - `04 // Architecture` (`#architecture`)
  - `05 // 5-Min Test Drive` (`#test-drive`)
  - `06 // FAQ` (`#faq`)

---

### Band 2 (`#fit`): Upfront "Honest Fit" 2-Column Decision Ledger (`partials/marketing/fit-split.html`)

- **Eyebrow**: `01 // HONEST FIT`
- **H2**: `Choose the Right Tool for Your Infrastructure`
- **Intro**: `Filestash and Sambee solve different architectural problems. Here is the honest breakdown before you read a single feature row.`

#### Left Card (`surface-page`, `2px` top primary-gold accent rule): `Switch to Sambee if you want...`
- Purpose-built speed and security for **Windows File Servers, TrueNAS, Synology, Unraid, Samba, and local PC drives**.
- **Defense-in-depth security** (Kerberos, SMB3 encryption, revocable sessions, Cosign + SBOM verification) with **zero enterprise paywalls**.
- **Dual-pane file management (`Ctrl+B`)**, `Ctrl+K` millisecond folder jumps, streaming ZIP folders, and dedicated mobile touch controls.
- **Native desktop editing** in Word, Excel, Photoshop, or LibreOffice without running a separate Collabora/WOPI server.
- **Free OIDC single sign-on**, group-based roles, and **MIT licensing** with zero per-seat fees.

#### Right Card (`surface-low`, neutral `rule-soft` framing): `Keep Filestash if you need...`
- One browser portal for **S3, Backblaze B2, MinIO, FTP/SFTP, Dropbox, Google Drive, or Git**.
- Outbound protocol gateways that re-expose backend storage as **SFTP, WebDAV, S3, or MCP servers**.
- Public, anonymous share links for external guests who do not have accounts on your network.

---

### Band 3 (`#comparison`): Grouped Comparison Matrix (`partials/marketing/matrix.html`)

- **Eyebrow**: `02 // ARCHITECTURE, SECURITY & LICENSING`
- **H2**: `Sambee vs. Filestash at a Glance`
- **Intro**: `How a dedicated SMB and local-drive workspace compares to a general-purpose multi-protocol portal.`
- **Responsive UX**: Sticky 3-column header on `md+` (`Capability` | `Sambee` tinted `surface-low` with top gold bar | `Filestash`); stacked per-capability cards on `< md`; every cell dual-coded with icon + bold status phrase + detail.

| Capability | Sambee | Filestash (Self-Hosted) |
|---|---|---|
| ***Group 1: Licensing & Identity*** | | |
| **Open-Source License** | `[check_circle]` **MIT** — permissive, 100% open source | `[info]` **AGPLv3** — open-core + commercial tiers |
| **OIDC Single Sign-On (Keycloak, Authentik, Authelia, Okta)** | `[check_circle]` **Free for unlimited users** | `[lock]` **Paid plans only** ($50–$290+/mo) |
| **Role Assignment from IdP Groups** | `[check_circle]` **Included free** (`Administrator`, `Editor`, `Viewer`) | `[lock]` **Paid RBAC tiers only** |
| ***Group 2: Security & Supply Chain*** | | |
| **Security Updates & Audit Trail** | `[check_circle]` **Immediate patches + JSONL auth audit trail for all** | `[lock]` **Early Security Patches & Audit Journal paywalled** |
| **SMB Authentication & Wire Security** | `[check_circle]` **Kerberos + NTLM** (with **Kerberos-only** mode), mandatory signing, **SMB3 encryption** | `[remove]` **NTLM / Guest only** (no Kerberos; no signing/encryption controls) |
| **Session & Credential Hygiene** | `[check_circle]` **Short-lived RAM tokens + revocable `HttpOnly` sessions**; zero URL tokens; log redaction | `[remove]` **1-week stateless cookie holding SMB password**; no per-session revoke; token in WOPI URLs |
| **Reverse-Proxy & Brute-Force Protection** | `[check_circle]` **Trusted Proxy CIDR allowlist** + per-IP & per-username rate limits | `[remove]` **Trusts any `X-Forwarded-For` header**; single global rate limiter |
| **Container & Supply-Chain Integrity** | `[check_circle]` **Cosign-signed, SBOM + provenance**, `--require-hashes`, `pip` removed, weekly **Trivy** scans | `[remove]` **Floating `:latest` + `CANARY=true`**; root Collabora startup `curl`; no public CI/SBOM/signing |
| ***Group 3: SMB & Local Storage Depth*** | | |
| **Live SMB Folder Refresh** | `[check_circle]` **Real-time** via SMB2/SMB3 `CHANGE_NOTIFY` + WebSockets | `[remove]` **Not supported** |
| **Directory Search & Navigation** | `[check_circle]` **Instant SQLite-indexed Quick Bar (`Ctrl+K`)** + history | `[info]` **Live recursive network walk** by default (crawler plugin optional) |
| **Local Workstation Drives** | `[check_circle]` **Yes** — origin-paired Companion (`127.0.0.1` HMAC API) | `[remove]` **No** — server-mounted paths only |
| ***Group 4: File Management, Viewing & Editing*** | | |
| **File Browser Layout** | `[check_circle]` **Dual-pane (`Ctrl+B`)** and single-pane commander UI | `[info]` **Single-pane** web portal only |
| **Copy & Move Across Locations** | `[check_circle]` **Toolbar, shortcuts & touch multi-select** across SMB and local drives | `[remove]` **Drag-and-drop oriented**; no cross-share SMB move |
| **ZIP Archive Handling** | `[check_circle]` **Instant virtual folders** — browse, preview & stream-extract | `[info]` **Basic plugin support** |
| **Graphics, Image & PDF Viewers** | `[check_circle]` **Hardened on-the-fly conversion** (`PSD`, `AI`, `EPS`, `HEIC`, `JXL`, `TIFF`, `EXR`, CMYK/encrypted `PDF`) | `[info]` **Standard browser/image transcoding** |
| **Markdown Editing** | `[check_circle]` **Rendered viewer + WYSIWYG table editing** + PDF print | `[info]` **Plain/basic editor plugin** |
| **Office & Creative App Editing** | `[check_circle]` **Open in native desktop Word, Excel, Photoshop, LibreOffice** (`Ctrl+Enter`) with locks & recovery | `[info]` **Browser Office only** via separate heavy `collabora/code` WOPI container |
| ***Group 5: Operations & Protocol Breadth*** | | |
| **Deployment Footprint & Health** | `[check_circle]` **1 lightweight container** + built-in **System Health Monitoring** | `[info]` **2 containers** in default Compose (`filestash` + `collabora/code`) |
| **S3, FTP, Dropbox, Google Drive & Gateways** | `[remove]` **Not supported** (focused exclusively on SMB & local drives) | `[check_circle]` **25+ cloud/file protocols + SFTP/WebDAV/MCP gateways** |

---

### Band 4 (`#pillars`, Part A): Deep-Dive Editorial Chapters `01`–`03` (`4:8` Split Rows)

*(Each chapter uses a `4`-column left summary rail with a `ui-current-primary-inset` callout box and an `8`-column right detail list capped at `65ch`.)*

#### Chapter `01 // LICENSING & IDENTITY`
- **Title**: `Zero "SSO Tax." Permissive MIT Open Source.`
- **Left Rail Callout**: `MIT License • $0 OIDC • Unlimited seats`
- **Lead**: `Identity should never sit behind a monthly paywall. Filestash restricts OpenID Connect (OIDC), RBAC, proxy authentication, custom branding, and environment-variable configuration to commercial subscriptions.`
- **Points**:
  - **Free OIDC for every provider**: Connect Keycloak, Authentik, Authelia, Okta, OneLogin, or any standard OIDC provider at `$0`.
  - **Group-driven role mapping**: Assign `Administrator`, `Editor`, and `Viewer` roles automatically from identity-provider groups.
  - **Safe staged rollout**: Run OIDC alongside local passwords during setup, then switch to passwordless **OIDC-only** sign-in when verified.
  - **Multi-layer theming included**: Customize personal and site-wide UI themes with the built-in RGBA theme editor.

#### Chapter `02 // SECURITY & SUPPLY CHAIN`
- **Title**: `Defense-in-Depth Security—Never an Enterprise Upsell.`
- **Left Rail Callout**: `Kerberos + SMB3 encryption • Revocable sessions • Cosign + SBOM`
- **Lead**: `A browser file gateway sits directly in front of your most sensitive storage. While Filestash gates Early Security Patches and Audit Journals behind paid plans—and stores user SMB passwords inside stateless cookies reused in WOPI URLs—Sambee builds enterprise-grade security into every release.`
- **Points**:
  - **Strong SMB wire security**: Enforce **Kerberos-only** authentication (blocking NTLM fallback), require **SMB message signing** on every connection, and enable **SMB3 transport encryption** across untrusted networks.
  - **Revocable sessions & zero URL token leaks**: Browsers hold only short-lived in-memory API tokens and `HttpOnly` cookies; users and admins can revoke individual sessions immediately; Companion exchanges one-time tokens in JSON bodies (never query strings); and logs automatically redact secrets.
  - **Anti-spoofing & brute-force limits**: Sambee ignores `X-Forwarded-For` unless the request originates from your configured **Trusted Reverse Proxy CIDRs**, and enforces per-IP and case-folded per-username rate limits.
  - **Verifiable software supply chain**: Digest-pinned base images, `--require-hashes` lockfiles, removed `pip` runtime tooling, non-root execution, weekly **Trivy** + multi-ecosystem dependency audits, **Cosign image signatures**, and published **SBOM + provenance bundles**.
  - **Sandboxed viewers & desktop pairing**: Active `HTML`/`SVG` content never executes in the viewer, ImageMagick runs with network delegates disabled and strict memory/pixel caps, and Companion requires **dual numeric-code approval of the exact browser origin** plus per-request **HMAC signatures** over `127.0.0.1`.

#### Chapter `03 // STORAGE DEPTH`
- **Title**: `First-Class SMB2/SMB3 Meets Your Local Drives.`
- **Left Rail Callout**: `Real-time CHANGE_NOTIFY • Millisecond SQLite jump • Local PC disks`
- **Lead**: `When a portal funnels 25 backends through one minimal interface, every protocol gets reduced to basic list, read, and write calls. Sambee focuses exclusively on SMB shares and local drives so both feel instantaneous.`
- **Points**:
  - **Event-driven directory freshness**: Sambee subscribes to **SMB2/SMB3 `CHANGE_NOTIFY`** events so open browser tabs and directory caches update in real time without wasteful polling.
  - **Millisecond directory jumps (`Ctrl+K`)**: Jump straight to any folder across tens of thousands of directories, backed by a resilient **SQLite directory index** and personal history.
  - **Local workstation drives in the same tab**: Pair the optional **Sambee Companion** app on Windows, macOS, or Linux to browse local disks, resolve `.lnk` shortcuts and symlinks, and transfer folders directly between your PC and your NAS.

---

### Band 5 (`#architecture`): Mid-Page Visual Proof & Architecture Contrast Band (`partials/marketing/visual-proof.html`)

*(Breaks reading rhythm halfway through the chapters with visual evidence on `surface-low`.)*

- **Eyebrow**: `04 // ARCHITECTURAL CONTRAST`
- **H2**: `One Hardened Container vs. Heavy Browser Office Stacks`
- **Visual 1 — Inline Theme-Aware SVG Architecture Comparison (`2-column diagram`)**:
  - **Sambee Stack**: `Browser` → `Sambee (1 Non-Root Container, Cosign Verified)` → `SMB2/SMB3 Share (Kerberos + Signing + Encryption + CHANGE_NOTIFY)` + optional `127.0.0.1 Origin-Paired Companion → Native Word / Excel / Photoshop`.
  - **Typical Filestash Stack**: `Browser` → `Filestash (:latest)` + `Collabora WOPI Container (root startup curl, multi-GB RAM, query-string session tokens)` → `NTLM-only SMB Plugin` + `$50–$290/mo SSO & Security Paywall`.
- **Visual 2 — Theme-Aware Workspace Preview**:
  - Reuses `components/responsive-image.html` (light + dark variants) with a concise caption bar highlighting dual-pane navigation, the `Ctrl+K` Quick Bar, and top-bar System Health status.

---

### Band 6 (`#pillars`, Part B): Deep-Dive Editorial Chapters `04`–`06` (`4:8` Split Rows)

#### Chapter `04 // ERGONOMICS`
- **Title**: `A Commander Workspace on Desktop. A Native Feel on Mobile.`
- **Left Rail Callout**: `Ctrl+B dual-pane • Zero-extract ZIPs • Native mobile share`
- **Lead**: `Consumer "Dropbox-like" portals break down during serious file management. Sambee gives keyboard power users and mobile touch users controls built for each device.`
- **Points**:
  - **Dual-pane mode (`Ctrl+B`)**: View two folders side by side, sync pane locations (`Ctrl+Left` / `Ctrl+Right`), and copy or move batches across SMB shares and local drives with **overwrite** or **replace-if-newer** conflict handling.
  - **Instant streaming ZIP folders**: Step inside `.zip` archives like ordinary folders, preview files inside archives immediately, or stream-extract directly across shares without temporary disk bloat.
  - **Purpose-built mobile UX**: Long-press or tap for multi-selection, run transfers from a thumb-friendly bottom bar, swipe rapidly through images and PDFs, and share files through your phone's **native OS share sheet**.

#### Chapter `05 // VIEWERS & EDITING`
- **Title**: `Fast Browser Viewers. Real Desktop Apps When You Need Them.`
- **Left Rail Callout**: `PSD/AI/HEIC/PDF previews • Ctrl+Enter native apps • Edit locks`
- **Lead**: `Running a multi-gigabyte Collabora server just to edit a Word file wastes RAM, breaks behind reverse proxies, and still cannot open Photoshop, Illustrator, or specialized desktop formats.`
- **Points**:
  - **Broad in-browser previews & editors**: Inspect photos and pro graphics (**PSD, AI, EPS, TIFF, HEIC, JPEG XL, AVIF, EXR, HDR**), search encrypted or CMYK **PDFs**, edit code in **CodeMirror**, and edit **Markdown** with live **WYSIWYG table editing**.
  - **Native desktop editing (`Ctrl+Enter`)**: Open `.docx`, `.xlsx`, `.psd`, or any file in **Microsoft Word, Excel, LibreOffice, Adobe Photoshop**, or any installed desktop app via Sambee Companion.
  - **Protected round-trip saving**: Sambee acquires a server-side **edit lock**, detects concurrent server edits before upload, recovers unsaved work after interruptions, and writes saved changes straight back to the share.

#### Chapter `06 // OPERATIONS`
- **Title**: `Built for the Admin Maintaining the Server at 2 AM.`
- **Left Rail Callout**: `Auto-saved settings • Live cgroup & thermal health • Clean logs`
- **Lead**: `Sambee stays lightweight on small home servers and predictable in enterprise environments.`
- **Points**:
  - **Single-container simplicity**: Deploy `ghcr.io/sambee-app/sambee:stable` with one `/app/data` volume and zero external database or WOPI dependencies.
  - **Zero Save-button friction**: UI configuration changes apply automatically with clear visual feedback, and authentication audit trails export cleanly as JSON Lines (`sambee-audit.jsonl`).
  - **Built-in System Health Monitoring**: Inspect host RAM, cache-excluded container cgroup memory, normalized CPU load, hardware CPU package temperatures (Intel, AMD, Raspberry Pi), and free storage space across SMB shares and local drives right from the top bar.

---

### Band 7 (`#test-drive`): `5:7` Terminal Test-Drive Split (`partials/marketing/test-drive.html`)

- **Surface**: `surface-low`
- **Left Column (`5 cols` — Pitch, Assurances & Dual CTAs)**:
  - **Eyebrow**: `05 // ZERO MIGRATION`
  - **H2**: `Test Sambee Beside Filestash in 5 Minutes`
  - **Body**: `Sambee works directly with the files and folders already on your SMB server. Keep Filestash running on port 8334, start Sambee on port 8000, connect the same share, and compare them side by side.`
  - **3 Assurance Bullets**:
    - `No file import, syncing, or proprietary storage format`
    - `Honors your existing Windows or Linux/POSIX share permissions`
    - `Remove the container anytime with zero changes left on your share`
  - **Actions**:
    - **Primary CTA (`kind: primary`)**: `Read the Docker Deployment Guide` → `target: { type: docs, book: admin-guide, section: installation-and-deployment, page: deploy-sambee-with-docker }`
    - **Secondary CTA (`kind: outline`)**: `Explore Sambee on GitHub` → `href: "https://github.com/sambee-app/sambee"`
- **Right Column (`7 cols` — Highlighted Code Panel inside `.content`)**:
  - **Header Strip (`surface-mid`, `type-label-sm`)**: `docker-compose.yml`
  - **Code (`transform.Highlight $code "yaml"` inside `.content` for theme colors + copy button)**:
    ```yaml
    services:
      sambee:
        image: ghcr.io/sambee-app/sambee:stable
        restart: unless-stopped
        volumes:
          - ./data:/app/data
        ports:
          - 8000:8000
    ```

---

### Band 8 (`#faq`): Interactive `<details>` Accordion FAQ (`partials/marketing/faq.html` + `FAQPage` JSON-LD)

- **Eyebrow**: `06 // TECHNICAL FAQ`
- **H2**: `Common Questions from Filestash Evaluators`
- **Interaction**: Native `<details class="marketing-faq-item">` + `<summary>` rows (`first` item `open` by default; `+`/`−` indicator; `44px+` touch target).

1. **Is OIDC single sign-on really free in Sambee?**
   Yes. Sambee is licensed under the MIT license with no paid tiers or seat limits. OIDC authentication, group-based role assignment (`Administrator`, `Editor`, `Viewer`), and all SMB security features are completely free for personal and commercial deployments.

2. **Do I have to migrate or import my files from Filestash?**
   No. Sambee connects directly to your existing Windows File Server, NAS, or Samba shares over SMB2/SMB3. Your folder hierarchy, filenames, and POSIX/Windows permissions remain untouched. You can run Sambee and Filestash against the same share at the same time during evaluation.

3. **How do users edit Office documents if Sambee does not bundle Collabora or OnlyOffice?**
   On desktop computers, users pair the optional **Sambee Companion** app and press `Ctrl+Enter` (or right-click **Open in companion app**) to open `.docx`, `.xlsx`, `.pptx`, `.psd`, or any other file in their real installed desktop applications. Sambee locks the file on the SMB share, checks for conflicts, and uploads saved edits straight back to the source folder. For Markdown, code, and plain text, Sambee includes fast built-in browser editors.

4. **Do phones and tablets need the Companion app?**
   No. Mobile phones, tablets, and browser-only workstations connect directly to Sambee over HTTPS with zero client installation. Companion is optional and used only on desktop machines that want local-drive browsing or native desktop app launching.

5. **How does Sambee's security architecture compare to Filestash?**
   Sambee never puts security behind a commercial tier. Every deployment gets OIDC single sign-on, Kerberos-capable SMB authentication, mandatory SMB message signing, optional SMB3 encryption, revocable server-side sessions without credentials stored in cookies or URLs, explicit Trusted Reverse Proxy CIDR checks, per-IP and per-username brute-force limits, Cosign-signed container images with published SBOM and provenance bundles, and weekly Trivy + dependency vulnerability scans.

6. **Why doesn't Sambee support S3, FTP, or Google Drive?**
   Focus. Multi-protocol portals limit every storage backend to a lowest-common-denominator feature set. By focusing on **SMB2/SMB3 shares and local drives**, Sambee delivers Kerberos authentication, SMB3 encryption, real-time `CHANGE_NOTIFY` updates, instant SQLite folder search, cross-backend streaming ZIP operations, and native desktop save-back workflows.

---

## 5. Visual & Media Plan

To keep initial launch fast while honoring `sambee.net`'s Git LFS + WebP pipeline (`../website/scripts/generate-webp.py` and `../website/scripts/validate-webp-assets.py`):

1. **Inline Theme-Aware Architecture Contrast SVG (Phase 1 Launch Asset — Zero LFS Overhead)**:
   - Crisp geometric ledger diagram using CSS custom properties (`var(--color-clr-surface-page)`, `var(--color-clr-rule-strong)`, `var(--color-clr-primary)`, plus `.dark` tokens) so light and dark mode switch instantaneously with zero network requests.
2. **Workspace UI Preview (Phase 1 Reuse → Phase 3 Custom Capture)**:
   - Phase 1 reuses existing `images/home/sambee-screenshot.png` and `images/home/sambee-screenshot-dark.png` via `partials/components/responsive-image.html` (all WebP derivatives already committed in Git LFS).
   - Optional Phase 3 upgrade: capture a dedicated dual-pane SMB + `.zip`/local-drive screenshot with the `Ctrl+K` Quick Bar open (`images/marketing/dual-pane-quickbar.png` + `-dark.png`), run `npm run images:generate`, and commit the source PNGs and `generated/*w.webp` files via Git LFS.

---

## 6. Phased Implementation Plan

1. **Phase 1 — Shared Primitives & Tech Marketing Layout System**
   - Promote `partials/home/link-href.html` to `partials/components/link-href.html` (keeping `partials/home/link-href.html` as a 1-line wrapper so `home.html` and `homepage.css` remain untouched).
   - Add optional `{{ block "head" . }}{{ end }}` to `layouts/_default/baseof.html`.
   - Create `layouts/_default/comparison.html` (`data_key`-driven, emitting `FAQPage` JSON-LD via `dict ... | jsonify` in `{{ define "head" }}` and wrapping sections in `<div class="marketing-shell" data-pagefind-body>`).
   - Create `partials/marketing/{hero-split,subnav,fit-split,matrix,chapter-list,visual-proof,test-drive,faq}.html` adhering strictly to the single-`type-*`-utility rule and wrapping highlighted YAML in `.content` for `code.css` + `main.js` copy-button support.
   - Add `assets/css/marketing.css` (including `.site-main:has(.marketing-shell) { @apply pb-0; }`, `2px` section-border collapsing, sticky subnav offsets, mobile-stacked comparison cards below `md`, `4:8` editorial chapters, and `<details>` FAQ styles) and import it in `assets/css/main.css`.
2. **Phase 2 — Filestash Page Data, Content Bundle & Footer Navigation**
   - Create `website/data/filestash_alternative.yaml` with structured `target` CTA links and all copy from Section 4.
   - Create `website/content/filestash-alternative/index.md` (`title = "Filestash Alternative for SMB Shares & Local Drives"` without `| Sambee`, `description`, `layout = "comparison"`, `data_key = "filestash_alternative"`).
   - Configure `[[footer.comparisons]]` in `config/_default/params.toml` and render a dedicated `<nav class="site-footer-compare" aria-label="Comparisons">` in `partials/essentials/footer.html` + `assets/css/footer.css` (separate from `aria-label="Legal links"`).
3. **Phase 3 — Automated CTA & Built-Output Validation**
   - Extend CTA validation (`scripts/validate-homepage-ctas.py` or a generalized site CTA check wired into `scripts/build-website.py`) to verify `/filestash-alternative/index.html` links and in-page `#comparison` / subnav anchors.
   - Add built-output tests in `website/tests/` verifying `/filestash-alternative/index.html` `<title>` (no duplicate `| Sambee`), canonical tag, `sitemap.xml` entry, `data-pagefind-body`, valid `FAQPage` JSON-LD, and highlighted YAML copy container.
   - Run `cd website && npm run images:validate && npm run build` and `python3 -m unittest discover -s website/tests` to verify production output end-to-end.
