+++
title = "Docs Runtime and Route Resolution"
+++

This page covers the implementation-facing side of docs routing.

Use it when you need to answer questions such as:

- which files own docs route resolution
- how stable current routes differ from explicit versioned routes
- how inherited pages become routable
- how version switching and docs search stay version-aware

## Runtime Map

Editors usually work in content and nav files. Web developers also need to know which files own version metadata, build-time validation, and runtime route resolution.

### Content and Navigation Sources

These files define what the docs tree is supposed to be:

- `website/data/docs-versions.toml`: canonical docs version metadata
- `website/data/docs-nav/<version>.toml`: ordered books, sections, and pages

If the docs UI order looks wrong, or a page exists on disk but not in navigation, these are the first files to check.

### Build and Tooling Scripts

These scripts keep the docs tree valid and routable:

- `website/scripts/validate-docs-content.py`: validates docs structure, markers, and nav integrity
- `website/scripts/materialize-inherited-docs.py`: generates transient routable anchors for inherited docs and stable current routes
- `website/scripts/docs-editor.py`: CLI for creating, deleting, and renaming docs versions, books, sections, and pages safely
- `website/scripts/build-website.py`: one ordered production, preview, and development build pipeline
- `website/scripts/generate-managed-redirects.py`: generates and validates the complete Cloudflare HTTP rule file
- `website/scripts/validate-docs-output.py`: checks built HTML, sitemap, and Pagefind inclusion against the manifest

In practice:

- use the validator when you need to confirm content-tree and nav consistency
- use materialization when testing inheritance or stable-current route behavior
- use the docs editor for structural changes instead of hand-editing multiple files

### Runtime Template Layer

These files turn the requested docs URL into the page the user actually sees:

- `website/themes/sambee/layouts/partials/docs/context.html`: derives docs path context from the requested route
- `website/themes/sambee/layouts/partials/docs/page-path.html`: builds docs content paths with stable-current routing support
- `website/themes/sambee/layouts/partials/docs/page-url.html`: resolves navigable docs URLs
- `website/themes/sambee/layouts/partials/docs/source-page.html`: resolves the explicit versioned source page behind stable current routes
- `website/themes/sambee/layouts/partials/docs/effective-page.html`: resolves the authored page that supplies body content and metadata
- `website/themes/sambee/layouts/partials/docs/render-data.html`: prepares shared docs render data, including redirect and indexing state
- `website/themes/sambee/layouts/partials/docs/article-shell.html`: renders the shared docs article shell
- `website/themes/sambee/layouts/partials/docs/redirect-target.html`: resolves docs entry redirects
- `website/themes/sambee/layouts/partials/docs/nav-tree.html`: resolves navigation targets and displayed titles
- `website/themes/sambee/layouts/partials/docs/version-target-url.html`: resolves cross-version switch targets
- `website/themes/sambee/layouts/partials/search-modal.html`: applies docs-version-aware search behavior
- `website/themes/sambee/layouts/docs/list.html` and `website/themes/sambee/layouts/docs/single.html`: route docs list and page rendering through the shared shell

### Theme Assets

These assets shape the visible docs experience once the route and content have been resolved:

- `website/themes/sambee/assets/css/`: shared theme CSS, including docs UI and typography

## Requested Route Versus Effective Page

The docs runtime keeps requested-path context separate from effective-content resolution.

### Requested Route Context

`website/themes/sambee/layouts/partials/docs/context.html` derives path context from the requested route and returns values including:

- `isDocs`
- `version`
- `book`
- `section`
- `page`
- `kind`
- `currentVersion`
- `isExplicitVersion`
- `isCurrentRoute`
- `isCurrentVersion`
- convenience booleans: `isDocsRoot`, `isVersion`, `isBook`, `isSection`, and `isPage`

Interpretation rules that matter when changing templates:

- stable current routes such as `/docs/website-dev-guide/...` still resolve to the current version even though the version slug is omitted
- explicit current, archived, and preview routes render full content at the requested version's URL
- navigation on explicit pages stays within that explicit version; navigation on current unversioned pages stays unversioned
- the version switcher selects unversioned URLs when switching to current

### Effective Content Resolution

`website/themes/sambee/layouts/partials/docs/effective-page.html` then resolves the authored content source and returns values including:

- `page`: the authored page that should supply title, description, TOC, and body content
- `requestedPage`: the Hugo page for the requested route
- `requestedVersion`: the version derived from the route
- `resolvedVersion`: the version that supplied the effective content
- `isInherited`: whether the route resolved through inheritance

Templates should render article content and metadata from `page`, while navigation state, breadcrumbs, and version-switcher state stay tied to the requested route context.

## Why Materialization Exists

Hugo needs a concrete page object at the requested path. Raw marker files alone are not enough.

The build therefore materializes transient route anchors under `.generated/content/docs` so Hugo can route inherited pages and stable current routes without publishing broken `/inherit/` or `/_inherit/` URLs.

From Hugo's perspective, `inherit.md` and `_inherit.md` are ordinary content files. If the site consumed them directly, Hugo would try to publish the wrong public URLs.

Example:

- `content/docs/1.1/end-user/getting-started/install/inherit.md` would naturally publish at `/docs/1.1/end-user/getting-started/install/inherit/`
- `content/docs/1.1/_inherit.md` would naturally publish at `/docs/1.1/_inherit/`

Those are invalid for this docs model. The canonical public URLs must stay attached to the folder path itself:

- `/docs/1.1/end-user/getting-started/install/`
- `/docs/1.1/`

That creates a routing gap:

- raw marker files must not become public pages
- Hugo still needs a real page or section node at the requested folder path so templates can run and the resolver can supply inherited content

The moving pieces are:

- `website/hugo.toml` ignores raw marker files as direct public pages
- `website/scripts/materialize-inherited-docs.py` generates transient anchors at the canonical folder paths
- `website/config/_default/module.toml` mounts `.generated/content` into Hugo's content tree
- `website/themes/sambee/layouts/partials/docs/effective-page.html` resolves the real authored page that should supply the body, title, description, and TOC

During the build, `materialize-inherited-docs.py` does this work:

1. deletes stale generated docs anchors under `website/.generated/content/docs/`
2. scans `website/content/docs/` for `inherit.md` and `_inherit.md`
3. generates transient `index.md` or `_index.md` anchors at the matching canonical folder paths under `website/.generated/content/docs/`
4. generates transient anchors for the declared current version at stable routes under `website/.generated/content/docs/<book>/...`
5. marks inherited-route anchors with `inherit = true`
6. marks stable current-route anchors with `current_route = true` and `source_docs_path = "/docs/<current>/..."`

Operational notes:

- `website/.generated/` is build output and is ignored by Git
- Hugo mounts `.generated/content` into the site content tree during the build
- Hugo is configured to ignore raw `inherit.md` and `_inherit.md` files

Without this script, the project would be stuck with two bad options:

- keep raw marker files visible to Hugo and accept broken `/inherit/` and `/_inherit/` URLs
- ignore marker files and lose the routable page nodes needed to render inherited docs at canonical folder URLs

## Version Switcher Fallback Order

When a reader switches from one docs version to another, the target lookup order is:

1. the same page path
2. the same section landing path
3. the same book landing path
4. the target version landing path

## Search Behavior

Docs search is intentionally version-aware.

- Pagefind indexes stable current docs URLs, not the explicit current copy
- current docs search results therefore keep stable unversioned URLs
- explicit versioned docs pages are excluded from the current-version search index
- on non-docs pages, the UI defaults docs search filters to the `current` version from `website/data/docs-versions.toml`
- versions with `searchable = false` are excluded from docs search indexing
- searchable archived and preview versions are indexed at their explicit URLs

## Route Manifest and HTTP Rules

Hugo writes `docs-routes.json` as a separate home output format. It is not a docs
article or search result. Schema version 1 includes current metadata, versions in
declaration order, docs routes, non-docs page routes, and docs entry redirects.
Each docs route records its URL space, requested version, source version, kind,
indexing state, and search state. Only entry routes have redirect fallback assets.
The manifest uses the same route and inheritance partials as page rendering.

After Hugo, `redirects:generate` combines entry redirects, recorded migrations,
managed shortcuts, and `website/platform-redirects.txt`. That last file can contain
non-docs platform rules only. There is no hand-maintained release redirect file.
The generator validates all rules before it replaces the selected destination's
`_redirects` file. It resolves migration chains, rejects page overrides, loops,
missing targets, cross-version moves, and ambiguous overlaps, and checks the
Cloudflare limits: 2,000 static rules, 100 dynamic rules, and 1,000 characters per
rule. Static rules precede dynamic rules.

### Migration Decisions

`website/data/docs-migrations.json` records logical locations and explicit scopes:

```json
{
	"schemaVersion": 1,
	"migrations": [
		{
			"source": "guide/section/old-page/",
			"target": "guide/section/new-page/",
			"scopes": ["2.0", "unversioned"]
		}
	]
}
```

Locations do not contain `/docs/` or a version prefix. An explicit scope applies
only to that version. `unversioned` applies to current URLs only while the source
is not an existing page. Use a `null` target for a reviewed gone decision. No
redirect is generated for that scope. An explicit alias must never override a page.

The docs editor records aliases for page moves and page, section, and book renames,
including inherited descendants. Branch changes record only previously routable
locations, not structural folders. Preview shows aliases; apply saves the registry
in the same rollback transaction as content and navigation. Version creation carries
applicable aliases, omits reused source paths, and refuses missing replacement targets.
Markdown links and managed shortcut targets still require explicit updates.

Every build compares current routes with the immediately preceding declared version.
Each removed unversioned location needs a current unversioned replacement or a gone
decision. Missing decisions stop the build. Replacement chains must end at an existing
current page, never at its archived copy. Current changes advance one declared version
at a time. To preview a change to an existing version, run:

```bash
python3 scripts/docs-editor.py version set-current 3.0
```

Add `--apply` before `version` after checking the preview. Version creation with
`--set-current` performs the same transition check. Do not change committed metadata
to test transitions; use temporary fixtures.

## Local Development and Production Checks

`build`, `build:search`, and `build:deploy` use the same steps: theme generation,
docs validation, materialization, Hugo, redirect generation, Pagefind, homepage CTA
validation, and docs output validation. `HUGO_BASEURL` controls the base URL.
`dev:prepare` uses that pipeline with the development environment and `public-dev`.
Use the **Website: Start Dev Server** VS Code task for the authoring loop at
`http://localhost:1313`. Check article and landing content, explicit navigation,
the current-version switch target, and fragment navigation.

The Hugo server does not apply `_redirects`. Entry pages forward automatically only
when `hugo.Environment` is `development`, preserving query strings and fragments.
Historical aliases and managed shortcuts return 404 locally. Production and preview
entry pages contain an accessible fallback link, but no meta refresh or automatic
JavaScript forwarding. Fragments do not reach the HTTP server.

The small standard-library test fixture uses pinned Hugo and the real route partials.
It checks manifest and generated-route agreement across consecutive current changes.
The complete deployment build checks HTML metadata, sitemap, and search inclusion.
Neither check proves Cloudflare matching or live status codes. Use the
[manual Cloudflare checks and rollback procedure](../../setup-and-operations/set-up-cloudflare-pages-publishing/)
after deployment.

## Commands for Runtime Changes

The most relevant commands when you are changing docs runtime behavior are:

- `npm run docs:validate`: validate docs content, nav data, markers, and inheritance rules
- The validator checks for:
	- both `index.md` and `inherit.md` in the same page folder
	- both `_index.md` and `_inherit.md` in the same version, book, or section folder
	- missing required page markers in page folders
	- missing required `_index.md` or `_inherit.md` in version or book folders
	- invalid non-empty inheritance marker files
	- inheritance chains that never resolve to real content
	- nav entries that point to missing version, book, section, or page paths
	- duplicate nav slugs in books, sections, or pages
	- legacy identity metadata such as `doc_id` and `product_version`
	- disallowed docs front matter such as `aliases`
- `npm run docs:materialize-inherited`: regenerate transient inherited-route and stable current-route anchors
- `npm run build:deploy`: run the complete validated build with the base URL from `HUGO_BASEURL`
- `npm run build` and `npm run build:search`: aliases for the same complete pipeline
- `python3 -m unittest discover -s website/tests`: run all website tests from the repository root; pinned Hugo is required
