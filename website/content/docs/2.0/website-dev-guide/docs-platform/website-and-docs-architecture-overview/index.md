+++
title = "Website and Docs Architecture Overview"
+++

## What Lives In `website/`

The public site lives under `website/`. The important areas are:

```text
website/
  content/
    docs/
  data/
    docs-nav/
    docs-versions.toml
  scripts/
  themes/sambee/
  assets/
  static/
```

In practice:

- `content/` holds the authored website pages and docs pages.
- `content/docs/` holds the published versioned docs books.
- `data/docs-versions.toml` declares the canonical docs version order and the current version.
- `data/docs-nav/<version>.toml` declares book, section, and page ordering for one version.
- `scripts/` holds build helpers, docs validation, docs materialization, and docs editor automation.
- `themes/sambee/` holds the Hugo layouts, partials, CSS, and JS for the public site.
- `assets/` and `static/` hold source media, generated media, and static files.

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

The website build is more than a plain Hugo render.

The normal production-style build is:

```bash
cd website
npm run build
```

That command runs:

1. theme generation
2. docs validation
3. inherited-doc materialization
4. Hugo site build
5. manifest-based HTTP redirect generation and validation
6. Pagefind search indexing
7. homepage CTA and docs output validation

`build:deploy` and `build:search` use the same complete pipeline. `HUGO_BASEURL`
sets the base URL. The manifest and `_redirects` must be deployed from one build.

For local development, use:

```bash
./scripts/start-website
```

Or run the website dev workflow directly:

```bash
cd website
npm run dev
```

Use the **Website: Start Dev Server** VS Code task for local checks. The development
pipeline writes to `website/public-dev/`, separate from production output in
`website/public/`. The authoring loop updates inherited anchors and WebP assets.
Use `dev:with-search` for continuous search-index updates.
