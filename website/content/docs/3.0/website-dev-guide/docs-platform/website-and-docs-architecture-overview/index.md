+++
title = "Website and Docs Architecture Overview"
+++

## What Lives in `website/`

The public site lives under `website/`. The main directories and configuration files are:

```text
website/
  config/_default/
  content/
    docs/
    filestash-alternative/
  data/
    docs-nav/
    docs-versions.toml
    filestash_alternative.yaml
    homepage.yaml
    managed-redirects.toml
  scripts/
  tests/
  themes/sambee/
  assets/
  static/
```

In practice:

- `config/_default/` holds site parameters (`params.toml`), menus, and Hugo module mounts.
- `content/` holds authored website pages (including standalone legal pages and comparison page bundles) and docs pages.
- `content/docs/` holds the published versioned docs books.
- `data/` holds structured YAML content for the homepage and comparison pages (`homepage.yaml`, `filestash_alternative.yaml`), `docs-versions.toml`, `docs-nav/<version>.toml`, and `managed-redirects.toml`.
- `scripts/` holds build helpers, docs validation, docs materialization, homepage and marketing CTA validation, media generation, and docs editor automation.
- `tests/` holds Python `unittest` suites for docs routing, docs validation, managed redirects, docs reports, and built marketing pages.
- `themes/sambee/` holds the Hugo layouts, partials, CSS, and JavaScript for the public site.
- `assets/` and `static/` hold source media, generated WebP and social-card derivatives, and static files.

## Site Page Families

`sambee.net` separates templates and stylesheets into three page families that share brand tokens, global header and footer chrome, and `type-*` typography utilities without cloning layouts across page types:

- **Homepage (`/`)**: Uses `layouts/home.html`, `partials/home/*`, `assets/css/homepage.css`, and `data/homepage.yaml` on the boxed `.ledger-shell` / `.home-section` rails. These section partials are exclusive to `/`.
- **Comparison and marketing pages (`/<slug>/`)**: Use a page bundle at `content/<slug>/index.md` (`layout = "comparison"`, `data_key = "<key>"`) backed by structured data in `data/<key>.yaml`, rendered through `layouts/_default/comparison.html`, `partials/marketing/*`, and `assets/css/marketing.css` using open full-bleed `.marketing-band` surfaces and centered `.marketing-frame` containers. Comparison pages emit `FAQPage` JSON-LD through the `{{ block "head" . }}` slot in `layouts/_default/baseof.html`, expose `data-pagefind-body` under `page_kind:site`, surface in the footer via `[[footer.comparisons]]` in `config/_default/params.toml`, and mark CTAs and subnav jump links with `data-marketing-link` for build-time validation.
- **Documentation and standalone prose pages (`/docs/...`, `/imprint/`, `/privacy-policy/`)**: Versioned docs use `layouts/docs/*` and `assets/css/docs.css`; single-column legal and reference pages outside `/docs/` use `layouts/_default/standalone.html` and `assets/css/standalone.css`.

Shared link and media helpers live in `partials/components/` (including `link-href.html`, `button-kind-class.html`, `responsive-image.html`, and `theme-aware-image.html`), and shared layout and typography utilities live in `assets/css/shared.css`.

## How Docs Routing Works

Docs content is versioned in the content tree:

```text
website/content/docs/<version>/<book>/<section>/<page>/index.md
```

The current docs version also publishes stable unversioned routes:

- `/docs/<book>/`
- `/docs/<book>/<section>/`
- `/docs/<book>/<section>/<page>/`

Archived or explicit versioned routes remain available at:

- `/docs/<version>/`
- `/docs/<version>/<book>/...`

The routing rules, inheritance markers, and stable-current behavior are covered in more detail in [Docs Content Model, Navigation, and Inheritance](../docs-content-model-navigation-and-inheritance/).

## Build and Preview Pipeline

The website build runs an ordered validation and asset pipeline rather than a plain Hugo render.

Run a production-style build from `website/`:

```bash
cd website
npm run build
```

That command runs:

1. Theme CSS generation (`scripts/themeGenerator.js`).
1. Docs navigation and content validation (`scripts/validate-docs-content.py`).
1. Inherited-doc route materialization (`scripts/materialize-inherited-docs.py`).
1. Hugo production site build (`hugo --minify`).
1. Manifest-based HTTP redirect generation and validation (`scripts/generate-managed-redirects.py`).
1. Pagefind search indexing (`npx pagefind`).
1. Homepage and marketing CTA validation (`scripts/validate-homepage-ctas.py`) plus docs output validation (`scripts/validate-docs-output.py`).

`build:deploy` and `build:search` run the same pipeline. `HUGO_BASEURL` sets the base URL. Deploy HTML, `docs-routes.json`, and `_redirects` from a single build.

Run the website Python test suite from the repository root:

```bash
python3 -m unittest discover -s website/tests
```

For local development, run:

```bash
./scripts/start-website
```

Or run the website development workflow directly:

```bash
cd website
npm run dev
```

Use the **Website: Start Dev Server** VS Code task for local checks. The development pipeline writes to `website/public-dev/`, separate from production output in `website/public/`. The authoring loop updates inherited anchors and WebP assets automatically. Use `npm run dev:with-search` when you need continuous Pagefind index updates during editing.
