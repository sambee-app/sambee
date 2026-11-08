+++
title = "Docs Content Model, Navigation, and Inheritance"
+++

Sambee's docs system is intentionally strict. That is a feature, not incidental complexity.

The strict rules keep URLs, page identity, navigation, inheritance, and render-time resolution aligned.

## Core Model

Docs identity is path-derived under `website/content/docs/`.

```text
website/content/docs/<version>/<book>/<section>/<page>/index.md
```

The path itself defines the docs identity:

- version slug: `content/docs/<version>/`
- book slug: `content/docs/<version>/<book>/`
- section slug: `content/docs/<version>/<book>/<section>/`
- page slug: `content/docs/<version>/<book>/<section>/<page>/`

## Public URL Contract

For the docs version marked as current, the canonical public routes are stable and unversioned:

- `/docs/<book>/`
- `/docs/<book>/<section>/`
- `/docs/<book>/<section>/<page>/`

Explicit versioned routes are available for each existing version:

- `/docs/<version>/`
- `/docs/<version>/<book>/`
- `/docs/<version>/<book>/<section>/`
- `/docs/<version>/<book>/<section>/<page>/`

Unversioned current pages and explicit pages both return HTTP 200. The build renders
the current version twice from one content source. When current metadata changes,
unversioned pages serve the new current version. Explicit URLs continue to serve
their requested version, including inherited content.

Only unversioned current pages are indexable, self-canonical, and in the sitemap.
All explicit pages have `noindex,follow` and no canonical tag. Pagefind indexes
unversioned current pages when current is searchable. It indexes other explicit
versions only when their `searchable` setting is true. It never indexes the explicit
current copy. Visibility and search settings do not remove routes.

`/docs` and `/docs/` return HTTP 302 to the current version's first routable location
in navigation order. Known version roots return HTTP 302 within that explicit
version. A book or section landing can be the entry destination. Structural folders
do not have landing routes and are not redirect destinations.

Recorded moves within an explicit version use HTTP 301. Recorded unversioned moves
use HTTP 302, because a later version can reuse their source path. Redirects do not
cross explicit versions or send unversioned routes to explicit pages. Unknown
versions and unknown paths have no generated redirect and return HTTP 404.

See [Docs Runtime and Route Resolution](../docs-runtime-and-route-resolution/)
for the manifest, migration registry, and build checks.

## Filesystem Contract

The docs system allows real authored content and inheritance markers. The allowed combinations are strict.

### Page Folders

A page folder under `website/content/docs/<version>/<book>/<section>/<page>/` must contain exactly one of:

- `index.md`: real page content
- `inherit.md`: empty inheritance marker

Do not keep both files in the same page folder.

### Version Folders

A version folder must contain exactly one of:

- `_index.md`: real landing-page content
- `_inherit.md`: empty inheritance marker

### Book and Section Folders

A book folder or section folder may contain zero or one of:

- `_index.md`: real landing-page content
- `_inherit.md`: empty inheritance marker

If neither file exists, the folder is structural only and has no content or public landing route of its own.

## Marker Files Are Markers Only

Inheritance markers do not carry content or override metadata.

- `inherit.md` and `_inherit.md` must be empty and have no front matter.

If a newer version needs different content, replace the marker with real content.

## Navigation Data Contract

Navigation data lives in `website/data/docs-nav/<version>.toml`.

These files define ordering only.

- `books` orders books
- `[[sections.<book>.items]]` orders sections and gives each section a displayed title
- `[pages.<book>.<section>].items` orders pages inside one section

Example:

```toml
books = [
  "user-guide",
  "admin-guide",
  "developer-guide",
  "website-dev-guide",
]

[[sections.website-dev-guide.items]]
slug = "authoring-and-tooling"
title = "Authoring and Tooling"

[pages.website-dev-guide.authoring-and-tooling]
items = [
  "docs-authoring-workflow",
  "docs-editor-tool",
]
```

Navigation data does not define:

- URLs
- page titles
- page existence
- inheritance behavior

Those come from the content tree and the effective-page resolver.

## Version Order and Current Version

Version metadata lives in `website/data/docs-versions.toml`.

Important rules:

- versions are listed in ascending release order, oldest to newest
- that declaration order is canonical
- inheritance only walks backward through that order
- the `current` key defines the version that publishes at stable unversioned routes

Do not infer chronology from the version slug string itself. Use the declared order.

### Inheritance Resolution

When Hugo renders a docs URL for a version, the system checks the requested version first and then walks backward through earlier versions until it finds real content.

For article pages, the resolution order is:

1. check `index.md` at the requested path
   - if present, use it
   - otherwise, if `inherit.md` exists, move to the previous declared version and check the same path
   - if neither file exists, validation should fail
1. if the backward scan ends without finding real content, validation should fail

Landing-page resolution follows the same pattern with `_index.md` and `_inherit.md`.

Example:

```text
content/docs/0.7/website-dev-guide/docs-platform/website-and-docs-architecture-overview/index.md
content/docs/0.8/website-dev-guide/docs-platform/website-and-docs-architecture-overview/inherit.md
```

In that case, the `0.8` route remains routable, but the content comes from the `0.7` authored page until `0.8` diverges.

## Safe Change Checklist

When changing docs content, navigation, or routing behavior:

- keep the filesystem path aligned with the intended public URL
- update `docs-nav/<version>.toml` when section or page ordering changes
- treat slug changes as URL changes, not cosmetic edits
- keep marker files empty
- preserve the expected file combinations for pages, books, and sections
- run the website build before finishing

## Common Failure Modes

- adding a page without adding the corresponding nav entry
- changing a slug in content but not in nav data
- leaving both `index.md` and `inherit.md` in one page folder
- adding content or front matter to `inherit.md` or `_inherit.md`
- putting published content into a source-material folder and assuming it is live docs
- changing template or script behavior without preserving the same docs path contract
