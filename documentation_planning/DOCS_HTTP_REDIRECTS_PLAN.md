# Docs HTTP Redirects Plan

## Status and Scope

Status: revised direction (unversioned canonical URLs, two rendered copies); implementation not started.

Date: 2026-11-08.

This plan moves production docs redirects from the browser to Cloudflare Pages.
It also corrects existing redirect defects, removes manual redirect updates from
normal release work, and validates generated routes and rules in CI. The user
will check Cloudflare responses manually after the change is deployed. These
live checks are not automated CI or deployment gates.

The current version keeps unversioned canonical URLs. These are the only docs
URLs that search engines index. Every version, including the current version,
also has explicit versioned URLs that return HTTP 200 for durable links. The
build renders current-version pages twice from one source: once at the
unversioned URL and once at the versioned URL. Creating this plan does not
change website behavior.

## Existing Contract and Target Policy

The existing public URL contract is defined in
[Docs Content Model, Navigation, and Inheritance](../website/content/docs/0.7/website-dev-guide/docs-platform/docs-content-model-navigation-and-inheritance/index.md).
The runtime is described in
[Docs Runtime and Route Resolution](../website/content/docs/0.7/website-dev-guide/docs-platform/docs-runtime-and-route-resolution/index.md).

The existing contract makes current-version canonical URLs unversioned. This
plan keeps that policy. It changes these parts of the contract:

- Explicit current-version URLs return HTTP 200 with the page content. They no longer forward to unversioned URLs in the browser.
- Docs entry redirects use HTTP redirects instead of meta refresh and JavaScript.
- Indexing rules are explicit for each version status.

Update the published contract when the new behavior is implemented, not while
this plan is still pending.

The implementation must follow these rules:

- Docs identity comes from the content path, not page front matter.
- The current version has unversioned canonical URLs. Only these docs URLs are indexed by search engines.
- Every version, including current and preview, has explicit versioned URLs that return HTTP 200.
- When the current metadata changes, unversioned URLs serve the new current version without redirect maintenance.
- Inheritance selects the content source. It does not change the requested version.
- Version declaration order controls inheritance. Do not infer order from slugs.
- Visibility and search settings do not remove routes.
- Valid book and section landing pages remain pages.
- Structural-only folders do not acquire public landing pages through redirect generation.

Version roots remain entry points that forward to the first routable location in
navigation order. That location can be a book, section, or article. Do not assume
that it is always an article or hard-code the current "What's New" path.

## Verified Baseline

Public HTTP checks on 2026-11-08 found:

| Request | Result |
| --- | --- |
| `/docs` | HTTP 308 to `/docs/` |
| `/docs/` | HTTP 200 with meta refresh, JavaScript, and visible redirect text |
| `/docs/release-info/news-and-changes/whats-new/` | HTTP 200, with no further redirect |
| `/docs/0.7/` | HTTP 301 to `/docs/` |
| `/docs/admin-guide/configuration/` | HTTP 301 to `/docs/admin-guide/configuration/configuration-key-reference/` |
| `/docs/admin-guide/configuration/configuration-key-reference/` | HTTP 404 |

The static HTTP rules override existing archived 0.7 routes. Cloudflare applies
redirects even when a matching asset exists. The configuration redirect also has
a missing destination.

The tracked redirect-file history contains no HTTP rule for `/docs/`. The 2.0
publication changed version metadata, not redirect code. An earlier external
Cloudflare rule or browser cache cannot be verified from repository history.

The repository on 2026-11-08 has these properties:

- `website/static/_redirects` has 66 static and 27 dynamic legacy rules, all HTTP 301.
- `redirect-target.html` forwards explicit current-version pages to unversioned URLs in the browser.
- `head.html` sets `noindex,follow` on all explicit-version pages. The sitemap lists only unversioned current routes.
- Materialization already generates unversioned anchors for every current-version page.
- The one managed shortcut targets an absolute, unversioned `https://sambee.net/docs/...` URL.
- The deployment workflow repeats the build steps inline instead of calling an npm script. It skips `validate:homepage-ctas`.
- Only `main` deploys. Pull requests build but do not deploy a preview.
- `verify-production` follows redirects with `curl --location`.
- The deploy job deletes the build artifact after deployment.
- CI runs only `test_validate_docs_content.py` and `test_docs_report.py`. `test_managed_redirects.py` and `test_docs_editor.py` exist but do not run in CI.
- The Hugo development server does not apply `_redirects`.

## Redirect Policy

In this table, `current` means the slug declared in docs version metadata.

| Source | Destination or response | Status |
| --- | --- | --- |
| `/docs`, `/docs/` | Current version's first routable location, using its unversioned URL | 302 |
| Any known `/docs/<version>/` root | First routable location within that same explicit version | 302 |
| Unversioned current route `/docs/<book>/...` | Current-version content, self-canonical, indexable | 200 |
| Explicit current, archived, or preview route | Requested version, including inherited content, `noindex,follow` | 200 |
| Recorded move within an explicit version | Final replacement within that same version | 301 |
| Recorded move of an unversioned route | Final unversioned replacement in the current version | 302 |
| Managed shortcut | Final page, in one hop | 302 |
| Unknown version or unknown path | No generated redirect | 404 |

Permanent redirects are appropriate only for recorded permanent moves within an
explicit version. Use 302 for moves of unversioned routes, because a later
current version can reuse the source path. Explicit versioned URLs must return
200 both before and after their version becomes archived.

For example, while 2.0 is current:

```text
/docs/                    -> 302 to /docs/release-info/... (first routable location)
/docs/user-guide/...      -> 200, serves 2.0 content, indexable
/docs/2.0/user-guide/...  -> 200, serves 2.0 content, noindex
/docs/1.0/user-guide/...  -> 200, serves 1.0 content, noindex
```

After 3.0 becomes current, `/docs/user-guide/...` serves 3.0 content and
`/docs/2.0/user-guide/...` continues to serve 2.0 content.

Generate slash and slashless forms for actual redirect sources where needed.
Both forms must reach the final destination directly. Do not generate redirect
pairs for routes that return HTTP 200; keep normal platform slash handling.

Do not redirect between different explicit versions. For example, a rename in
1.0 does not justify sending an existing 0.7 page to a 1.0 or current-version page.

Do not redirect unversioned routes to explicit-version pages. Search engines must
not pass indexed unversioned URLs on to archived copies.

### Managed Shortcuts

Managed shortcuts keep HTTP 302 and must reach their final page in one hop:

- Internal targets are site-relative paths, for example `/docs/admin-guide/...`. Relative targets also work in preview deployments.
- Absolute HTTPS targets remain allowed only for external hosts. Reject absolute targets that use the docs site host.
- The generator validates each internal target against the route manifest. The target must be a route that returns HTTP 200.
- If the target is a redirect source, stop the build and name the final destination. Update the registry entry; do not rewrite targets silently.
- If the target does not exist, stop the build.
- Change the existing shortcut target to the relative form.

## Indexing Policy

| Route | Robots | Canonical tag | Sitemap | Pagefind |
| --- | --- | --- | --- | --- |
| Unversioned current route | Indexable | Self | Yes | Yes, if the current version is searchable |
| Explicit current route | `noindex,follow` | None | No | No |
| Explicit archived or preview route | `noindex,follow` | None | No | Yes, if its version is searchable |
| Entry redirect fallback page | `noindex,follow` | None | No | No |

Do not combine `noindex` with a canonical tag that points to another URL. The
explicit current copy must not create duplicate Pagefind results. Keep the
existing searchable-version selection rules for other versions.

## Build Design

### Page Rendering

Render each current-version article, book landing, and section landing twice
from the same source:

- At the unversioned URL, through the existing generated stable-current anchors.
- At the explicit versioned URL, with full content and the indexing rules above.

Retain stable-current anchor generation, inherited-route materialization, and
effective content resolution. Remove the explicit-current-version branch in
`redirect-target.html` that forwards pages to unversioned URLs. Keep docs-root
and version-root entry redirects separate from page rendering.

Navigation stays in the requested URL space. Links on unversioned pages use
unversioned URLs. Links on explicit-version pages use URLs of that explicit
version. The version switcher selects the unversioned URL for the current
version. Pagefind results for the current version use unversioned URLs.

Entry routes (`/docs/` and version roots) keep a fallback page with an
accessible link to the resolved target. Production and preview builds have no
meta refresh or JavaScript forwarding. Development builds
(`hugo.Environment == "development"`) also forward entry routes automatically
to the same target, because the Hugo server does not apply `_redirects`.

### Hugo Route Manifest

Add a machine-readable Hugo output with:

- A schema version and the current docs version.
- Known versions in declaration order.
- Unversioned current routes and their source version.
- Explicit versioned routes for every version, with their requested-version identity.
- The indexing state of each route.
- Docs-root and version-root redirects, with source, target, and reason.

Reuse the existing context, page URL, first-routable URL, and redirect-target
partials after updating their URL policy. Do not copy the inheritance resolver
into Python or parse generated HTML to discover routes.

The manifest must distinguish unversioned current routes, explicit versioned
routes, and entry routes. Only entry routes can have redirect fallback assets.
No historical alias may override a route that returns HTTP 200, even if its
destination exists.

Use a separate output format rather than a docs article. The manifest must not
become a docs navigation item or a search result.

### One Redirect Generator

Extend the existing `redirects:generate` build command to combine:

- Docs-root and version-root redirects from the route manifest.
- Recorded historical docs migrations.
- Existing managed shortcuts.
- Any retained non-docs platform rules.

Generate one deterministic `_redirects` file in the selected build destination.
Do not keep a second hand-maintained list of release-specific docs HTTP rules.
All build paths must use the same build script, so the generator always runs
after Hugo has produced the matching manifest. See
[Build Scripts and Local Development](#build-scripts-and-local-development) and
[Deployment Workflow](#deployment-workflow).

Resolve historical redirect chains to their final destination. Validate the
complete rule set before replacing the output file. A failed generation must
stop the build, with a message that identifies the offending source and target.

Cloudflare currently permits 2,000 static rules, 100 dynamic rules, and 1,000
characters per rule. Check these limits automatically. Put static rules before
dynamic rules and reject ambiguous overlaps. Do not introduce a broad version
wildcard to avoid a limit failure. Report the count and require a reviewed
alternative if the rule set outgrows the platform limits.

Reference: [Cloudflare Pages Redirects](https://developers.cloudflare.com/pages/configuration/redirects/).

### Release Transition Check

When the current version changes, an unversioned route of the previous current
version can be missing from the new current version. Search engines can still
have that URL indexed.

Current-version changes follow declaration order, one version at a time. Skipped
versions are outside this plan's scope. No publication-history tracking is needed.

On every build, compare the unversioned routes of the current version with the
explicit routes of the version declared immediately before it. For each missing
route, require one of these decisions in the migration registry:

- **Replacement:** an unversioned route in the current version. The generator creates a 302 redirect.
- **Gone:** the unversioned URL returns 404, and search engines drop it.

A replacement must not be an explicit-version page, including the archived copy
of the removed page. Otherwise, stop the build and list the missing routes. The
operation that changes the current version must show the same result in its
dry-run output. Moves made with the docs editor record replacements
automatically. Only deleted pages need a manual decision.

### Initial Static Rule Budget

Unversioned current routes are pages, not redirect rules. The core budget is:

| Purpose | Static rules |
| --- | --- |
| Six version roots, slash and slashless, including the 3.0 preview root | 12 |
| `/docs` and `/docs/` | 2 |
| Existing managed shortcut | 1 |
| Total before historical aliases | 15 |

Historical aliases add rules after their version scope and destinations have
been audited. The existing 66 static and 27 dynamic legacy rules must not simply
be added to this total; some are obsolete, and others need replacement or
expansion.

Changing current metadata does not change the number of rules. Adding a new
version normally adds two version-root rules plus any applicable historical
aliases.

### Historical Migration Registry

Record logical old and replacement locations, with their applicable versions.
Version scope must reflect actual content changes, not an assumed numeric range.
Unversioned routes are a separate scope. Their aliases apply while the current
version does not have a page at the source path.

Extend docs editor page moves and page, section, and book renames to include
registry changes in their existing operation plans. Dry-run output must show the
new aliases. Apply mode must save them with the content and navigation changes.
Use the editor's existing inherited-descendant calculation to identify affected
versions.

For a book or section move, record the previously routable descendant locations.
Do not assume that every descendant keeps the same suffix or that a structural
folder had a landing page.

When creating a later version, carry applicable aliases for routes that follow
the migrated content. Reject or omit aliases whose source is a page that returns
HTTP 200 in the new version; never override that page silently. Missing replacement
targets require an explicit decision.

Successive renames must resolve to one final target. Deletion requires an explicit
replacement if a redirect is wanted. Do not guess destinations from page titles,
similar slugs, or the first page of another version.

## Build Scripts and Local Development

Every docs page is an HTML file, so the Hugo development server shows all pages.
Only entry routes, managed shortcuts, and historical aliases are redirects.
The generator validates all of them statically against the route manifest.
Cloudflare-specific matching can be verified only on Cloudflare. A local Pages
emulator is therefore not necessary. The user will verify live HTTP behavior
manually after deployment.

- Add a `build:deploy` npm script. It runs the theme build, docs validation, materialization, Hugo with the route manifest, redirect generation, the Pagefind index, and the homepage CTA check. It reads the base URL from `HUGO_BASEURL`.
- Make `build`, `build:search`, and `dev:prepare` use the same steps, so the generator and its validation always run after Hugo.
- Keep `dev:watch` as the authoring loop. Entry routes forward automatically in the development environment. Managed shortcuts and historical aliases return 404 locally.
- Start the local website through the VS Code `Website: Start Dev Server` task. Use the VS Code browser at `http://localhost:1313` to check generated docs pages, navigation, fragment handling, and development entry forwarding. Website browser testing is permitted for this work.
- The website task uses the development environment. It does not prove Cloudflare HTTP behavior or the absence of production browser forwarding. Check production output locally for meta refresh and JavaScript forwarding; the user checks live responses after deployment.
- Do not add a live redirect check script or automatic Cloudflare request checks. Document the manual checks in [Manual Cloudflare Checks](#manual-cloudflare-checks).

## Deployment Workflow

Update `.github/workflows/website-deploy.yml` and `.github/workflows/test.yml`:

- **Build:** replace the inline build steps with `npm run build:deploy`. Pass the base URL through `HUGO_BASEURL`. Generator validation failures stop the workflow for all pull requests, including fork pull requests.
- **Preview deployment:** do not add pull request preview deployment infrastructure for this change. Pull requests continue to build and validate without Cloudflare secrets.
- **Production deployment:** deploy from `main` only after the build and automated checks pass. Deploy the manifest and `_redirects` from the same build. Manual Cloudflare acceptance follows deployment; it is not a pre-deployment gate.
- **Production verification:** remove the docs-specific `curl --location` checks and `VERIFY_PAGE` from `verify-production`. Retain unrelated homepage and asset smoke checks. The user performs [Manual Cloudflare Checks](#manual-cloudflare-checks) after deployment.
- **Tests:** replace the two test-file patterns in `test.yml` with `python3 -m unittest discover -s website/tests`. Install the same pinned Hugo version as the deployment build in the `website-docs` job. Add the small Hugo manifest integration test described below. Missing Hugo must fail the test, not skip it.
- **Rollback:** the deploy job deletes the build artifact. Use Cloudflare Pages deployment rollback, and document the procedure in the website developer guide.

### Fast and Robust CI Tests

Keep the website unit and editor tests on the Python standard library. The
existing 144 tests passed in about 9.4 seconds locally on 2026-11-08; this is a
baseline, not a fixed CI time limit.

Use a small temporary docs site for the Hugo integration test. It must use the
real route partials and manifest template, not a copied route resolver. Cover
authored and inherited pages, landing pages, structural folders, navigation
entry selection, and consecutive current-version changes from 1.0 to 2.0 to 3.0.
Compare the manifest with the generated fixture routes and redirect rules.

Use fixed inputs, isolated output folders, bounded subprocess timeouts, and
failure messages that include the command and its output. Do not start a server
or make network requests in the fixture test. Only pinned Hugo and Python are
required; do not add Go, Node, npm dependencies, Pagefind, or image processing
to this test job.

Keep full-site rendering, production robots and canonical tags, sitemap, and
Pagefind checks in the existing website deployment build. The small fixture
test does not replace these checks. Reuse the built output rather than adding
a second full-site build to the unit test job.

## Implementation Steps

1. **Audit existing rules.** Classify each docs rule as an entry redirect, historical move within an explicit version, historical move of an unversioned route, or obsolete override. Record applicable versions and confirm destinations. Remove fixed 0.7-to-current rules and `:version` wildcards that override existing pages. Repair the configuration redirect and other missing targets.
2. **Render explicit current pages and add the route manifest.** Remove the explicit-current-version browser redirect. Apply the indexing policy to robots tags, canonical tags, the sitemap, and Pagefind. Keep navigation in the requested URL space. Check authored pages, inherited pages, structural folders, and navigation entry selection.
3. **Generate the complete HTTP rules.** Add manifest, migration, managed-shortcut, and release-transition handling to the existing command. Change the managed shortcut target to the relative form. Validate and compare the full replacement output before deployment. Do not leave conflicting legacy wildcards in place.
4. **Automate migration records.** Update the docs editor, version-creation, and current-version-change operations. Test dry-run, apply, inherited descendants, repeated renames, source-path reuse, and removed unversioned routes.
5. **Unify the build scripts.** Add `build:deploy`. Make `build`, `build:search`, and `dev:prepare` use the same build steps and generator. Document local browser checks and the manual post-deployment checklist.
6. **Update the deployment workflow and CI.** Apply the changes in [Deployment Workflow](#deployment-workflow).
7. **Replace browser forwarding.** Remove meta refresh and JavaScript from entry routes in production and preview builds. Keep an accessible fallback link to the same resolved target. Keep automatic forwarding only in the development environment.
8. **Deploy and verify the complete change.** Complete automated and local browser checks first. Deploy explicit current pages, HTTP rules, and fallback pages together from one build. The user then performs the manual Cloudflare checks and records the results. Do not report live acceptance as complete before those results are available.
9. **Update published documentation.** Document the explicit-current-page change, entry redirects, HTTP status choices, the indexing policy, the manifest, migration records, managed-shortcut rules, local development behavior, manual post-deployment checks, and rollback. Publish these changes with the new behavior. Follow the docs-update skill and edit the earliest applicable source, normally 0.7 for this shared docs-system change.

## Validation and Acceptance Criteria

Automated and local validation can be complete before deployment. Final
acceptance also requires the user's manual Cloudflare results. Do not treat
generated assets as proof of live HTTP status codes or platform matching.

### Automated and Local Checks

- [ ] Generated `/docs` and `/docs/` rules target the current entry destination directly.
- [ ] Generated version-root rules select the first actual routable location in that version's navigation.
- [ ] Unversioned current article and landing-page assets contain current-version content.
- [ ] Explicit current, archived, and preview page assets contain the requested version's content without browser forwarding.
- [ ] The restored 0.7 page assets exist, including authored book and section landings.
- [ ] Inherited pages keep their requested-version URL rather than redirecting to the content source version.
- [ ] Fixture tests change current metadata consecutively from 1.0 to 2.0 to 3.0 and prove that unversioned assets contain the new current content while explicit versioned assets remain available, without redirect maintenance.
- [ ] Only unversioned current routes are indexable, self-canonical, and listed in the sitemap. All explicit-version pages have `noindex,follow` and no canonical tag to another URL.
- [ ] Pagefind does not return duplicate results for the explicit current copy. Current-version results use unversioned URLs.
- [ ] Navigation stays in the requested URL space. The version switcher selects unversioned URLs for the current version.
- [ ] Structural-only folders are not treated as canonical landing pages by generation.
- [ ] Historical aliases apply only to affected versions and never override a route that returns HTTP 200.
- [ ] Unknown versions and paths are not matched by general version-rewrite rules.
- [ ] Every internal target resolves to a final page route in the manifest; missing targets, loops, and conflicts stop the build.
- [ ] Each managed shortcut targets a final page route directly. Absolute targets on the docs site host are rejected.
- [ ] The build stops when an unversioned route of the previous current version is missing without a recorded replacement or "gone" decision.
- [ ] No unversioned route redirects to an explicit-version page.
- [ ] Generated rules are deterministic and satisfy Cloudflare limits.
- [ ] Rename and move operations record aliases in dry-run and apply modes, including inherited descendants.
- [ ] Version creation carries only applicable aliases and detects source-path reuse or missing replacements.
- [ ] Existing managed-shortcut tests pass, with new tests for one-hop validation.
- [ ] CI runs all website tests, including generator, migration, docs editor, and Hugo manifest integration tests.
- [ ] The Hugo fixture test uses the pinned deployment Hugo version, runs without asset or search build dependencies, and fails clearly if Hugo is missing or a subprocess times out.
- [ ] All build paths use the same build steps. A clean build produces a matching manifest and `_redirects` file.
- [ ] Fragment navigation and development forwarding are checked in the VS Code browser using the local website task; fragments do not reach the HTTP server.
- [ ] Production and preview builds use no automatic browser forwarding for docs routes. In the development environment, entry routes forward automatically.
- [ ] The Cloudflare Pages rollback procedure is documented.
- [ ] Published routing and authoring documentation matches the implemented behavior.

Use focused temporary fixtures for release-transition and rename tests. Do not
change committed version metadata merely to run a test. Use both unit tests for
rule validation and Hugo build tests for route-manifest agreement.

### Manual Cloudflare Checks

The user performs these checks after deployment, using fresh clients and the
manifest and `_redirects` from that deployment. For each redirect, request the
source without following redirects automatically. Check its status and
`Location` header, then request the target separately. Record the deployment
URL, date, checked paths, and results.

- [ ] `/docs` and `/docs/` each return one HTTP 302 to the current entry destination, with no browser forwarding or redirect-text flash.
- [ ] Known version roots return HTTP 302 to the first routable location within the same explicit version.
- [ ] Unversioned current articles and landing pages return HTTP 200 with current-version content, self-canonical tags, and no `noindex` directive.
- [ ] Explicit current, archived, preview, and inherited pages return HTTP 200 with the requested version's content, `noindex,follow`, no canonical tag, and no browser forwarding. Include restored 0.7 book and section landings.
- [ ] The managed shortcut and a historical move reach their final HTTP 200 pages in one hop, with the status specified in the redirect policy.
- [ ] Unknown versions and paths return HTTP 404 rather than matching a general version-rewrite rule.
- [ ] Slash and slashless redirect sources both reach the final destination directly. Check query-string behavior and redirect cache headers against Cloudflare's actual responses.
- [ ] Browser navigation through a deployed entry redirect preserves the intended fragment behavior.
- [ ] No external Cloudflare dashboard or Bulk Redirect rule overrides the generated routing policy.

## Deployment Risks and Recovery

- Previously cached HTTP 301 responses can remain in browsers. For example, cached 0.7 rules can still send 0.7 URLs to unversioned URLs. Deployment cannot clear them. Use fresh clients for acceptance checks and provide cache-clearing guidance when a user encounters a stale redirect.
- Temporary status codes do not prove that every cache is disabled. Inspect actual redirect response headers and verify release transitions with the deployed cache policy.
- External Cloudflare redirect rules can run before Pages rules. Check the account configuration for conflicting dashboard or Bulk Redirect rules during rollout.
- Use Cloudflare Pages deployment rollback to restore the last known-good deployment. Deploy the manifest and HTTP rules from the same build; do not deploy either independently.
- A generator or automated validation failure must prevent deployment. Do not publish a partial rule file. Complete local rendering and browser checks before deployment. The user verifies Cloudflare behavior manually afterward; use deployment rollback if those checks find a defect.

## Non-Goals

- Replacing the existing docs inheritance or navigation ordering model.
- Supporting skipped current-version releases or adding publication-history tracking.
- Adding automated Cloudflare response tests, a live redirect check script, or pull request preview deployment infrastructure for this change.
- Changing the unversioned canonical URLs of the current version.
- Serving unversioned URLs through Cloudflare rewrites instead of rendered pages. Rewrites would remove the second copy, but they prevent `noindex` on explicit current pages, do not work in the Hugo server, and depend on a Cloudflare-only feature.
- Redirecting all missing pages to a landing page.
- Applying `_redirects` in local development. Generator validation checks the rules; the user's manual post-deployment checks verify Cloudflare behavior.
- Removing archived or preview routes based on visibility or search settings.
- Adding Pages Functions or a Worker without a demonstrated need.
- Updating application frontend behavior.
