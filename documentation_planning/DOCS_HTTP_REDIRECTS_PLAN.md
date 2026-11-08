# Docs HTTP Redirects Plan

## Status and Scope

Status: agreed direction; implementation not started.

Date: 2026-11-08.

This plan moves production docs redirects from the browser to Cloudflare Pages.
It also corrects existing redirect defects and removes manual redirect updates
from normal release work. The agreed target uses versioned canonical URLs for
every docs version. Version-less URLs become temporary redirects to the current
version. Creating this plan does not change website behavior.

## Existing Contract and Target Policy

The existing public URL contract is defined in
[Docs Content Model, Navigation, and Inheritance](../website/content/docs/0.7/website-dev-guide/docs-platform/docs-content-model-navigation-and-inheritance/index.md).
The runtime is described in
[Docs Runtime and Route Resolution](../website/content/docs/0.7/website-dev-guide/docs-platform/docs-runtime-and-route-resolution/index.md).

The existing contract makes current-version canonical URLs unversioned. This
plan intentionally changes that policy. Update the published contract when the
new behavior is implemented, not while this plan is still pending.

The implementation must follow these rules:

- Docs identity comes from the content path, not page front matter.
- Every version has explicit versioned canonical URLs, including current and preview versions.
- Version-less URLs remain supported entry links and redirect to the current version.
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

## Redirect Policy

In this table, `current` means the slug declared in docs version metadata.

| Source | Destination or response | Status |
| --- | --- | --- |
| `/docs/` | Current version's first routable location, using its versioned URL | 302 |
| Any known `/docs/<version>/` root | First routable location within that same version | 302 |
| Existing version-less `/docs/<book>/...` location | Corresponding canonical route in the current version | 302 |
| Canonical current, archived, or preview route | Render the requested version, including inherited content | 200 |
| Recorded renamed route within any explicit version | Final replacement within that same version | 301 |
| Release-dependent version-less historical alias | Current version's final versioned replacement | 302 |
| Unknown version or unknown path | No generated redirect | 404 |

Permanent redirects are appropriate only for recorded permanent moves within an
explicit version. Use 302 for version-less links because their targets change
with the current version. Do not redirect canonical current-version pages to
version-less URLs. Their versioned URLs must return 200 both before and after
that version becomes archived.

For example, while 2.0 is current:

```text
/docs/user-guide/...      -> 302 to /docs/2.0/user-guide/...
/docs/2.0/user-guide/...  -> 200, serves 2.0 content
/docs/1.0/user-guide/...  -> 200, serves 1.0 content
```

Generate slash and slashless forms for actual redirect sources where needed.
Both forms must reach the final destination directly. Do not generate redirect
pairs for canonical versioned pages; keep normal platform slash handling.

Do not redirect between different explicit versions. For example, a rename in
1.0 does not justify sending an existing 0.7 page to a 1.0 or current-version page.

Keep the existing managed-shortcut policy separate from docs version policy.
Managed shortcuts can intentionally target a different location and retain their
existing HTTP 302 behavior.

## Build Design

### Versioned Page Rendering

Serve each article, book landing, and section landing at its versioned canonical
URL. Remove the current-version redirect branch that sends these pages to
version-less URLs. Keep version-root entry redirects separate from page rendering.

Remove stable-current article anchor generation and the content-source handling
used only by those anchors. Retain inherited-route materialization and effective
content resolution; inheritance still requires them.

Navigation, breadcrumbs, version switching, canonical tags, sitemaps, and search
results must use versioned canonical URLs. Keep existing searchable-version
selection rules; making current-version URLs explicit must not exclude them from
search. Version-less aliases must not be indexed as duplicate articles.

If alias fallback pages are needed, render only a link to the final versioned
target. Do not generate a second article copy. Local development can use automatic
browser forwarding for these aliases because Hugo does not apply `_redirects`.

### Hugo Route Manifest

Add a machine-readable Hugo output with:

- A schema version and the current docs version.
- Known versions in declaration order.
- Routable docs locations and their requested-version identity.
- Versioned canonical routes that must remain HTTP 200.
- Intended version-less and version-root redirects, with source, target, and reason.

Reuse the existing context, page URL, first-routable URL, and redirect-target
partials after updating their URL policy. Do not copy the inheritance resolver
into Python or parse generated HTML to discover redirects.

The manifest must distinguish canonical versioned pages from version roots and
version-less aliases. Only defined entry or alias routes can have redirect
fallback assets. No historical alias may override a canonical page, even if its
destination exists.

Use a separate output format rather than a docs article. The manifest must not
become a docs navigation item or a search result.

### One Redirect Generator

Extend the existing `redirects:generate` build command to combine:

- Hugo's intended docs redirects.
- Recorded historical docs migrations.
- Existing managed shortcuts.
- Any retained non-docs platform rules.

Generate one deterministic `_redirects` file in the selected build destination.
Do not keep a second hand-maintained list of release-specific docs HTTP rules.
The normal build, search build, development preparation, and deployment must use
the same generator after Hugo has produced the matching manifest.

Resolve internal redirect chains to their final canonical destination. Validate
the complete rule set before replacing the output file. A failed generation must
stop the build, with a message that identifies the offending source and target.

Cloudflare currently permits 2,000 static rules, 100 dynamic rules, and 1,000
characters per rule. Check these limits automatically. Put static rules before
dynamic rules and reject ambiguous overlaps. Do not introduce a broad version
wildcard to avoid a limit failure. Report the count and require a reviewed
alternative if the rule set outgrows the platform limits.

Reference: [Cloudflare Pages Redirects](https://developers.cloudflare.com/pages/configuration/redirects/).

### Initial Static Rule Budget

The current 2.0 tree contains 98 articles and 14 book or section landing pages.
With slash and slashless forms for redirect sources, the core budget is:

| Purpose | Static rules |
| --- | --- |
| Version-less aliases for 98 current-version articles | 196 |
| Version-less aliases for 14 current-version landing pages | 28 |
| Six version roots, including the new 3.0 preview root | 12 |
| `/docs` and `/docs/` | 2 |
| Existing managed shortcut | 1 |
| Total before historical aliases | 239 |

This count assumes a clean materialization and build. Historical aliases add
rules after their version scope and destinations have been audited. The existing
66 static and 27 dynamic legacy rules must not simply be added to this total;
some are obsolete, and others need replacement or expansion.

Changing current metadata changes the version-less alias destinations. It does
not add redirects for every page in each archived version. Adding a new version
normally adds two version-root rules plus any applicable historical aliases.

### Historical Migration Registry

Record logical old and replacement locations, with their applicable versions.
Version scope must reflect actual content changes, not an assumed numeric range.

Extend docs editor page moves and page, section, and book renames to include
registry changes in their existing operation plans. Dry-run output must show the
new aliases. Apply mode must save them with the content and navigation changes.
Use the editor's existing inherited-descendant calculation to identify affected
versions.

For a book or section move, record the previously routable descendant locations.
Do not assume that every descendant keeps the same suffix or that a structural
folder had a landing page.

When creating a later version, carry applicable aliases for routes that follow
the migrated content. Reject or omit aliases whose source is a canonical page
in the new version; never override that page silently. Missing replacement
targets require an explicit decision.

Successive renames must resolve to one final target. Deletion requires an explicit
replacement if a redirect is wanted. Do not guess destinations from page titles,
similar slugs, or the first page of another version.

## Implementation Steps

1. **Audit existing rules.** Classify each docs rule as an entry redirect, version-less alias, historical move, or obsolete override. Record applicable versions and confirm destinations. Remove fixed 0.7-to-current rules. Repair the configuration redirect and other missing targets.
2. **Stage versioned rendering and the route manifest.** Update URL resolution and canonical page rendering together. Remove stable-current article copies while retaining inherited routes. Update navigation, canonical tags, sitemaps, and search. Check authored pages, inherited pages, structural folders, and navigation entry selection. Do not deploy this step independently of the new redirect rules.
3. **Generate the complete HTTP rules.** Add manifest and migration handling to the existing command. Validate and compare the full replacement output before deployment. Do not leave conflicting legacy wildcards in place during migration.
4. **Automate migration records.** Update the docs editor and version-creation operations. Test dry-run, apply, inherited descendants, repeated renames, and source-path reuse.
5. **Add build and CI gates.** Run redirect validation for normal and deployment builds. Add redirect and docs editor tests to CI; the current website CI runs only validator and report tests.
6. **Prepare production and development fallbacks.** Remove automatic meta refresh and JavaScript for production routes. Keep an accessible fallback link for alias and entry routes using the same resolved target. Keep automatic browser redirects only for local development, where Hugo does not apply `_redirects`. Remove all old current-version-to-version-less forwarding before enabling the reverse direction.
7. **Deploy and verify the complete change.** Validate a complete build in a Cloudflare preview deployment first. Then deploy versioned canonical pages, matching HTTP rules, and safe fallback pages together. Check final production responses and confirm that deployment reads the generated rules. Never combine the new redirect direction with the old current-version redirect pages.
8. **Update published documentation.** Replace the old current-version canonical URL contract and document HTTP status choices, the manifest, migration records, and validation commands in the website developer guide. Publish these changes with the new behavior. Follow the docs-update skill and edit the earliest applicable source, normally 0.7 for this shared docs-system change.

## Validation and Acceptance Criteria

Implementation is complete only when all applicable checks pass:

- [ ] `/docs` and `/docs/` reach the current entry destination through one HTTP redirect, with no production redirect-text flash.
- [ ] Version-root redirects select the first actual routable location in that version's navigation.
- [ ] Version-less article and landing-page URLs reach final current-version canonical URLs through one HTTP 302.
- [ ] Existing explicit current, archived, and preview pages return HTTP 200 without changing the requested version.
- [ ] The restored 0.7 routes remain accessible, including authored book and section landings.
- [ ] Inherited pages keep their requested-version URL rather than redirecting to the content source version.
- [ ] Tests change current metadata from 1.0 to 2.0 to 3.0 and prove that version-less alias targets update while existing versioned pages remain HTTP 200, without redirect maintenance.
- [ ] Navigation, breadcrumbs, version switching, canonical tags, sitemaps, and search results use versioned canonical URLs.
- [ ] The current searchable version is indexed at versioned URLs; aliases are not indexed as duplicate articles.
- [ ] Stable-current article copies and their content-source indirection are removed; inherited-route support remains valid.
- [ ] Structural-only folders are not treated as canonical landing pages by generation.
- [ ] Historical aliases apply only to affected versions and never override canonical pages.
- [ ] Unknown versions and paths are not matched by general version-rewrite rules.
- [ ] Every internal target resolves to a final canonical route; missing targets, loops, and conflicts stop the build.
- [ ] Generated rules are deterministic and satisfy Cloudflare limits.
- [ ] Rename and move operations record aliases in dry-run and apply modes, including inherited descendants.
- [ ] Version creation carries only applicable aliases and detects source-path reuse or missing replacements.
- [ ] Managed-shortcut behavior and its existing tests remain valid.
- [ ] CI includes generator, migration, docs editor, and Hugo manifest integration tests.
- [ ] A clean website build produces a matching manifest and `_redirects` file.
- [ ] Deployment smoke tests check redirects without automatically following them, then check final targets separately.
- [ ] Slash handling and query-string behavior are checked against Cloudflare's actual responses, not only a local rule simulator.
- [ ] Fragment handling is verified in an allowed browser test environment; fragments do not reach the HTTP server.
- [ ] Production has no automatic browser redirect for these routes; local development retains a working fallback.
- [ ] No build or deployment combines version-less-to-current HTTP redirects with old current-version-to-version-less browser forwarding.
- [ ] Published routing and authoring documentation matches the implemented behavior.

Use focused temporary fixtures for release-transition and rename tests. Do not
change committed version metadata merely to run a test. Use both unit tests for
rule validation and Hugo build tests for route-manifest agreement.

## Deployment Risks and Recovery

- Previously cached HTTP 301 responses can remain in browsers. Deployment cannot clear them. Use fresh clients for acceptance checks and provide cache-clearing guidance when a user encounters a stale redirect.
- A cached external current-version-to-version-less redirect can loop with the new direction. Audit external rules and test old entry URLs before rollout; deployment cannot clear browser-cached redirects.
- Temporary status codes do not prove that every cache is disabled. Inspect actual redirect response headers and verify release transitions with the deployed cache policy.
- External Cloudflare redirect rules can run before Pages rules. Check the account configuration for conflicting dashboard or Bulk Redirect rules during rollout.
- Keep the last known-good build artifact for rollback. Deploy the manifest and HTTP rules from the same build; do not deploy either independently.
- A generator or validation failure must prevent deployment. Do not publish a partial rule file. Verify the complete new rendering and redirect policy in a preview deployment before production rollout.

## Non-Goals

- Replacing the existing docs inheritance or navigation ordering model. The canonical URL policy does change as specified above.
- Redirecting all missing pages to a landing page.
- Removing archived or preview routes based on visibility or search settings.
- Adding Pages Functions or a Worker without a demonstrated need.
- Updating application frontend behavior or managed-shortcut policy.
