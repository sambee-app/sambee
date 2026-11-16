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

## 3. Website Architecture & Integration Plan (`sambee.net`)

### 3.1 Route and File Locations

The page lives outside `/docs/` so it never participates in versioned documentation navigation or inheritance:

| Concern | Planned Path | Notes |
|---|---|---|
| Public URL | `https://sambee.net/filestash-alternative/` | High-intent, exact-match SEO slug |
| Content entry | `../website/content/filestash-alternative/index.md` | Front matter (`title`, `description`, `layout = "filestash-alternative"`) |
| Structured page data | `../website/data/filestash_alternative.yaml` | Keeps hero, comparison rows, battlegrounds, code block, and FAQs maintainable |
| Page template | `../website/themes/sambee/layouts/_default/filestash-alternative.html` | Composes ledger sections matching `../website/themes/sambee/layouts/home.html` |
| Styles | `../website/themes/sambee/assets/css/comparison.css` (imported in `main.css`) | Reuses `.home-section`, `.ledger-shell`, and shared `type-*` utilities; adds responsive comparison-matrix styles |
| Internal discovery | `../website/themes/sambee/layouts/partials/essentials/footer.html` | Add a clean footer link (`Filestash Alternative`) while keeping the top navbar minimal |
| CTA validation | `../website/scripts/validate-homepage-ctas.py` (or `validate-marketing-ctas.py`) | Extend link validation so broken docs/internal links on marketing pages fail the build |

### 3.2 Why Custom Ledger Layout Beats `standalone.html`

- `../website/themes/sambee/layouts/_default/standalone.html` renders a single narrow prose column designed for legal pages (`/imprint/`, `/privacy-policy/`).
- High-converting competitor pages need visual rhythm: full-width ledger dividers, 3-column value cards, a sticky-header comparison matrix, side-by-side "Stay with Filestash / Switch to Sambee" decision cards, and an interactive/copyable Docker Compose block.
- Using a data-driven Hugo template on top of the existing `ledger-shell` and `type-*` typography system preserves visual consistency with `https://sambee.net/` while keeping `validate-docs-content.py`, `sitemap.xml`, `head.html` Open Graph metadata, and Pagefind search working out of the box.

### 3.3 Metadata & Structured Data

- **HTML `<title>`**: `Filestash Alternative for SMB Shares & Local Drives | Sambee`
- **`<meta name="description">`**: `Need a self-hosted Filestash alternative? Sambee delivers fast dual-pane SMB2/SMB3 and local drive management, native desktop app editing, and free OIDC SSO under the MIT license.`
- **JSON-LD `FAQPage` schema**: Emit structured FAQ metadata in the page template for rich search-engine results on pricing, OIDC, migration, and Office editing questions.

---

## 4. Full Section-by-Section Wireframe & Copy Proposal

*(All proposed copy uses clear, direct, active Simplified Technical English while keeping bold marketing punch.)*

---

### Section 1: Hero (`ledger-shell`)

- **Eyebrow**: `SAMBEE VS. FILESTASH // SELF-HOSTED FILE WORKSPACE`
- **H1**: `Stop using a cloud adapter to manage your SMB shares.`
- **Subtitle**: `Filestash connects to 25 protocols at surface depth—and locks OIDC single sign-on, audit logs, and early security patches behind monthly subscriptions. Sambee is purpose-built for SMB shares and local drives, with defense-in-depth security, dual-pane navigation, native desktop app editing, and free SSO under the MIT license.`
- **Primary CTA**: `Deploy with Docker` → `/docs/admin-guide/installation-and-deployment/deploy-sambee-with-docker/`
- **Secondary CTA**: `Compare Feature by Feature ↓` → `#comparison`
- **Technical Proof Bar**:
  - `MIT License`
  - `$0 OIDC Single Sign-On`
  - `SMB2 / SMB3 + Kerberos + Encryption`
  - `Cosign + SBOM Verified`
  - `Single Docker Container`

---

### Section 2: Three Structural Advantages (3-Column Ledger Cards)

#### Card 1
- **Eyebrow**: `No Security Tax`
- **Icon**: `verified_user`
- **Title**: `Enterprise identity & security at $0`
- **Body**: `Filestash charges $50 to $290+ per month for OIDC, RBAC, audit logs, and early security patches. Sambee includes OIDC single sign-on, revocable sessions, Cosign-signed images, and unlimited users for free under the MIT license.`

#### Card 2
- **Eyebrow**: `Purpose-Built Depth`
- **Icon**: `dns`
- **Title**: `True SMB2/SMB3 + local drives`
- **Body**: `Filestash treats SMB as one of 25 generic plugins—NTLM only, with live network crawls for search. Sambee delivers Kerberos, SMB3 encryption, real-time CHANGE_NOTIFY updates, millisecond folder jump, and local PC drive access.`

#### Card 3
- **Eyebrow**: `Real Desktop Apps`
- **Icon**: `laptop_windows`
- **Title**: `Edit in Word or Photoshop—no WOPI container`
- **Body**: `Filestash ships a heavy Collabora container that struggles behind reverse proxies and cannot open creative files. Sambee runs in one container and opens files in your installed desktop apps, saving changes right back to your share.`

---

### Section 3: Side-by-Side Comparison Matrix (`#comparison`)

- **Eyebrow**: `Architecture, Security & Licensing`
- **H2**: `Sambee vs. Filestash at a Glance`
- **Intro**: `A factual look at how a security-first SMB and local-drive workspace compares to a general-purpose multi-protocol portal.`

| Category | Sambee | Filestash (Self-Hosted) |
|---|---|---|
| ***Licensing & Identity*** | | |
| **Open-Source License** | **MIT** (permissive, 100% open source) | **AGPLv3** open-core + paid commercial tiers |
| **OIDC Single Sign-On (Keycloak, Authentik, Authelia, Okta)** | **Free for unlimited users** | **Paid plans only** ($50–$290+/mo) |
| **Role Assignment from IdP Groups** | **Included free** (`Administrator`, `Editor`, `Viewer`) | **Paid RBAC tiers only** |
| ***Security & Supply Chain*** | | |
| **Security Updates & Audit Trail** | **Immediate patches + JSONL auth audit trail for all users** | **Early Security Patches & Audit Journal gated to paid plans** |
| **SMB Authentication & Wire Security** | **Kerberos + NTLM** (with **Kerberos-only** option), mandatory signing, **SMB3 encryption** | **NTLM / Guest only** (no Kerberos; no signing/encryption controls) |
| **Session & Credential Hygiene** | **Short-lived in-memory tokens + revocable `HttpOnly` sessions**; zero tokens in URLs; log redaction | **1-week stateless cookie carrying SMB password**; no per-session revocation; token passed in WOPI URLs |
| **Reverse-Proxy & Brute-Force Protection** | **Explicit Trusted Proxy CIDR allowlist** + per-IP & per-username rate limits | Trusts any `X-Forwarded-For` header; single shared global rate limiter |
| **Container & Supply-Chain Integrity** | **Cosign-signed images, SBOM + provenance**, `--require-hashes`, `pip` removed, weekly **Trivy** scans | Floating `:latest` + `CANARY=true` in default Compose; root Collabora startup `curl`; no public CI/SBOM/signing |
| ***SMB & Local Storage Depth*** | | |
| **Live SMB Folder Refresh** | **Real-time** via SMB2/SMB3 `CHANGE_NOTIFY` + WebSockets | **Not supported** |
| **Directory Search & Navigation** | **Instant SQLite-indexed Quick Bar (`Ctrl+K`)** + history | Live recursive network walk by default (crawler requires extra plugin) |
| **Local Workstation Drives** | **Yes** (origin-paired Companion with HMAC-signed `127.0.0.1` API) | **No** (server-mounted paths only) |
| ***File Management, Viewing & Editing*** | | |
| **File Browser Layout** | **Dual-pane (`Ctrl+B`)** and single-pane commander workspace | Single-pane web portal only |
| **Copy & Move Across Locations** | **Toolbar, keyboard shortcuts & touch multi-select** across SMB and local drives | Drag-and-drop oriented; no cross-share SMB move |
| **ZIP Archive Handling** | **Instant virtual folders** (browse, preview & stream-extract without full unpack) | Basic plugin support |
| **Graphics, Image & PDF Viewers** | **Hardened on-the-fly conversion** (`PSD`, `AI`, `EPS`, `HEIC`, `JXL`, `TIFF`, `EXR`, CMYK/encrypted `PDF`) | Standard browser/image transcoding |
| **Markdown Editing** | **Rendered viewer + WYSIWYG table editing** + multi-page PDF print | Plain/basic editor plugin |
| **Office & Creative App Editing** | **Open in native desktop Word, Excel, Photoshop, LibreOffice** (`Ctrl+Enter`) with locks & conflict recovery | Browser Office only via separate heavy `collabora/code` WOPI container |
| ***Operations & Protocol Breadth*** | | |
| **Deployment Footprint & Health** | **1 lightweight container** + built-in live **System Health Monitoring** | 2 containers in default Compose (`filestash` + `collabora/code`) |
| **S3, FTP, Dropbox, Google Drive & Gateways** | **Not supported** (focused on SMB & local drives) | **25+ cloud/file protocols + SFTP/WebDAV/MCP gateways** |

---

### Section 4: Six Deep-Dive Battlegrounds (Ledger Feature Grid)

*(Six items `01` through `06` match the 3×2 / 2×3 card rhythm of `website/data/homepage.yaml`.)*

#### `01 // LICENSING & IDENTITY` — Zero "SSO Tax." Permissive MIT Open Source.
Identity should never sit behind a monthly paywall. Filestash restricts OpenID Connect (OIDC), RBAC, proxy authentication, custom branding, and environment-variable configuration to commercial subscriptions.

Sambee ships every feature under the **MIT license**:
- Connect **Keycloak, Authentik, Authelia, Okta, OneLogin**, or any standard OIDC provider at **$0**.
- Map identity-provider groups directly to **Administrator, Editor, and Viewer** roles.
- Roll out OIDC safely alongside local passwords, then switch to passwordless **OIDC-only** sign-in when ready.
- Customize personal and site-wide UI themes with the built-in RGBA theme editor.

#### `02 // SECURITY & SUPPLY CHAIN` — Defense-in-Depth Security—Never an Enterprise Upsell
A self-hosted file gateway sits right in front of your most sensitive storage. While Filestash gates **Early Security Patches**, **Enhanced Security**, and **Audit Journals** behind paid plans—and stores user SMB passwords inside stateless cookies reused in WOPI URLs—Sambee builds enterprise-grade security into every release:
- **Strong SMB wire security**: Enforce **Kerberos-only** authentication (blocking NTLM fallback), require **SMB message signing** on every connection, and enable **SMB3 transport encryption** across untrusted networks.
- **Revocable sessions & zero URL token leaks**: Browsers hold only short-lived in-memory API tokens and `HttpOnly` cookies; users and admins can revoke individual sessions instantly; Companion exchanges one-time tokens in JSON bodies (never query strings); and logs automatically redact secrets.
- **Anti-spoofing & brute-force controls**: Sambee ignores `X-Forwarded-For` unless the request comes from your configured **Trusted Reverse Proxy CIDRs**, and enforces per-IP and case-folded per-username authentication rate limits.
- **Verifiable software supply chain**: Every production image uses digest-pinned base images, `--require-hashes` lockfiles, removed `pip` runtime tooling, non-root execution, weekly **Trivy** + multi-ecosystem dependency audits, **Cosign signatures**, and published **SBOM + provenance bundles**.
- **Hardened viewers & desktop trust**: Active `HTML`/`SVG` content never executes in the viewer, ImageMagick runs with network delegates disabled and strict memory/pixel caps, and Sambee Companion requires **dual numeric-code approval of the exact browser origin** plus per-request **HMAC signatures** over `127.0.0.1`.

#### `03 // STORAGE DEPTH` — First-Class SMB2/SMB3 and Local Drives
When a tool supports 25 backends through one minimal interface, every protocol gets reduced to basic `list`, `read`, and `write` calls. Sambee focuses exclusively on **SMB shares** and **local drives** so both feel instantaneous and reliable:
- **Event-driven freshness**: Sambee subscribes to **SMB2/SMB3 `CHANGE_NOTIFY`** events. When a coworker or script adds, renames, or edits files on the server, open browser tabs and directory caches update without wasteful polling.
- **Millisecond directory jumps**: Press `Ctrl+K` to jump straight to any folder on huge shares, backed by a resilient **SQLite directory index** and personal navigation history.
- **Local drives in the same tab**: Install the optional **Sambee Companion** app on Windows, macOS, or Linux to access local disks, resolve Windows `.lnk` shortcuts and symlinks, and transfer folders directly between your PC and your NAS.

#### `04 // ERGONOMICS` — A Commander Workspace on Desktop. A Native Feel on Mobile.
Consumer "Dropbox-like" web portals fall apart during real file management. Sambee gives power users and mobile users tools designed for each screen:
- **Dual-pane mode (`Ctrl+B`)**: View two directories side by side, match pane locations (`Ctrl+Left` / `Ctrl+Right`), and copy or move batches across SMB shares and local drives with **overwrite** or **replace-if-newer** conflict rules.
- **Instant streaming ZIP folders**: Step inside `.zip` archives as if they were normal directories. Preview images, PDFs, or text inside an archive immediately, or stream-extract files directly to another share without temporary disk bloat.
- **Built for phones and tablets**: Long-press or tap to select multiple items, run actions from a thumb-friendly bottom bar, swipe rapidly through photo sets or PDF pages, and send files to any mobile app through your phone's **native share sheet**.

#### `05 // VIEWERS & EDITING` — Skip Collabora Headaches. Use Your Real Apps.
Running a multi-gigabyte Collabora/WOPI server just to fix a typo in a Word document wastes RAM, breaks behind reverse proxies, and still cannot open Photoshop, Illustrator, or specialized desktop files.

Sambee solves viewing and editing cleanly:
- **Instant in-browser viewers**: Browse large photo folders, inspect professional graphics (**PSD, AI, EPS, TIFF, HEIC, JPEG XL, AVIF, EXR, HDR**), search inside encrypted or CMYK **PDFs**, edit code in **CodeMirror**, and edit **Markdown** with live **WYSIWYG table editing**.
- **Native desktop app editing (`Ctrl+Enter`)**: Open any file directly in **Microsoft Word, Excel, PowerPoint, LibreOffice, Adobe Photoshop**, or any app installed on your computer via Sambee Companion.
- **Protected round-trip saving**: Sambee places an **edit lock** on the SMB file, watches your session, detects server-side conflicts before upload, recovers unsaved work after interruptions, and writes your saved changes straight back to the share.

#### `06 // OPERATIONS` — One Lightweight Container with Built-In Health Monitoring
Sambee respects the person maintaining the server:
- **Single container**: Deploy `ghcr.io/sambee-app/sambee:stable` with one persistent `/app/data` volume and zero sidecar databases or WOPI servers.
- **Frictionless administration**: Settings apply automatically without easy-to-forget Save buttons, and authentication/OIDC audit events export cleanly as JSON Lines (`sambee-audit.jsonl`).
- **Live System Health in the UI**: Monitor host RAM, cache-excluded container cgroup memory, normalized CPU load, hardware CPU package temperatures (Intel, AMD, Raspberry Pi), and free space across connected SMB shares and local drives directly from Sambee's top bar.

---

### Section 5: Radical Honesty Decision Block (2-Column Split)

- **Eyebrow**: `Clear Fit`
- **H2**: `Choose the Right Tool for Your Infrastructure`

#### Column A: `Keep Filestash if you need...`
- One browser portal for **S3, Backblaze B2, MinIO, FTP/SFTP, Dropbox, Google Drive, or Git**.
- Protocol gateways that re-expose backend storage as **SFTP, WebDAV, S3, or MCP servers**.
- Public, anonymous share links for external clients who do not have user accounts on your network.

#### Column B: `Switch to Sambee if you want...`
- Purpose-built speed and security for **Windows File Servers, TrueNAS, Synology, Unraid, Samba, and local PC drives**.
- **Dual-pane file management**, `Ctrl+K` instant folder navigation, streaming ZIP archives, and polished mobile controls.
- **Native desktop editing** in Word, Excel, Photoshop, or LibreOffice without operating a Collabora/WOPI stack.
- **Free OIDC single sign-on**, group-based roles, and **MIT licensing** with zero per-seat fees.

---

### Section 6: Zero-Risk 5-Minute Side-by-Side Test Drive

- **Eyebrow**: `Zero Migration`
- **H2**: `Test Sambee Beside Filestash in 5 Minutes`
- **Body**: `Sambee works directly with the files and folders already on your SMB server. It creates no proprietary file store, moves no data, and changes nothing on your share. Keep Filestash running on port 8334, start Sambee on port 8000, connect the same SMB share, and feel the difference immediately.`

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

- **Primary CTA**: `Read the Docker Deployment Guide` → `/docs/admin-guide/installation-and-deployment/deploy-sambee-with-docker/`
- **Secondary CTA**: `Explore Sambee on GitHub` → `https://github.com/sambee-app/sambee`

---

### Section 7: Technical FAQ (`FAQPage` Schema)

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

To make the page visually decisive and aligned with `sambee.net`'s responsive WebP workflow (`../website/scripts/generate-webp.py`):

1. **Hero / Feature Proof Screenshot** (Light + Dark WebP sets):
   - Capture Sambee in **dual-pane mode** showing an SMB share on the left and either an open `.zip` archive or local drive on the right, with the `Ctrl+K` Quick Bar overlay open.
2. **Architecture Contrast Diagram** (Inline theme-aware SVG):
   - Left: **Sambee** — `Browser` → `1 Lightweight Sambee Container` → `SMB2/SMB3 Share (Kerberos + Encryption + CHANGE_NOTIFY)` + optional `Companion → Native Word / Photoshop`.
   - Right: **Typical Filestash Stack** — `Browser` → `Filestash Container` + `Heavy Collabora WOPI Container` → `NTLM-only SMB Plugin` + `$50–$290/mo SSO Paywall`.
3. **3-Step Native Desktop Editing Callout**:
   - Reuse or pair alongside `../website/assets/images/home/companion-screenshot.png` to show the **Done Editing — Hold to Upload** workflow and conflict protection.

---

## 6. Phased Implementation Plan

1. **Phase 1 — Data & Layout Scaffolding**
   - Create `website/data/filestash_alternative.yaml` with the structured copy from Section 4.
   - Create `website/themes/sambee/layouts/_default/filestash-alternative.html` reusing homepage partials where identical (`hero`, `problem-value`, `benefits`, `deployment`) plus two reusable partials (`comparison/matrix.html` and `comparison/decision-split.html`) so future competitor pages (for example, `filebrowser-alternative` or `nextcloud-smb-alternative`) can be launched from YAML alone.
   - Add `website/themes/sambee/assets/css/comparison.css` and import it in `website/themes/sambee/assets/css/main.css`.
2. **Phase 2 — Content Route, SEO Schema & Footer Link**
   - Create `website/content/filestash-alternative/index.md` referencing the layout, SEO title, and meta description.
   - Emit `FAQPage` JSON-LD in the page template.
   - Add a `Filestash Alternative` link to `website/themes/sambee/layouts/partials/essentials/footer.html` (configured via `params.toml` or menu).
3. **Phase 3 — Visual Assets & Build Validation**
   - Generate light/dark screenshots if new captures are added and run `website/scripts/generate-webp.py`.
   - Extend CTA link checking so all `/filestash-alternative/` CTAs are verified against built docs routes during `npm run build`.
   - Run `cd website && npm run build` and `pytest` in `website/tests/` to verify HTML output, Pagefind indexing, redirects, and zero broken links.
