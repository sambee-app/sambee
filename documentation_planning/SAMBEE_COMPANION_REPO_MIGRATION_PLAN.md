# Sambee Companion Repository Migration Checklist

Move the existing release repository from `helgeklein/sambee-companion` to
`sambee-app/sambee-companion`. Keep release assets and the public feed URLs intact.

## Before Transfer

- [ ] Save the current release list and `docs/feeds`; pause in-progress and new
      Companion build, promotion, cleanup, and index-refresh runs.

## After Transfer

- [ ] Transfer the existing repository to `sambee-app`.
- [ ] Create a new PAT with "sambee-app" as owner.
      - Repo permissions on the migrated `sambee-companion`:
         - Read access to metadata
         - Read and Write access to code
- [ ] Verify GitHub Pages publishes `main` `/docs` with the custom domain
      `release-feeds.sambee.net` and HTTPS. Change its DNS CNAME from
      `helgeklein.github.io` to `sambee-app.github.io`; confirm the existing
      public feed URLs still serve correctly.
- [ ] Edit the URLs in the 4 JSON files here: https://github.com/helgeklein/sambee-companion/tree/main/docs/feeds,
      replacing `helgeklein` with `sambee-app`.
      - [ ] Verify that the new download URLs work.
- [ ] In `sambee-app/sambee`, change the Companion owner in the build, promote,
      cleanup, and promotion-index workflows, plus both hard-coded references
      in the Docker publication workflow.
- [ ] Update owner-specific backend test fixtures and current/inherited release
      documentation; follow the `docs-update` skill and refresh derived artifacts.

## Verify and Resume

- [ ] Run focused release-script and workflow tests; check current code and docs
      for remaining live `helgeklein/sambee-companion` references.
- [ ] Check public feed JSON and asset downloads, an installed Companion update
      check, Sambee download links, and old repository/release redirects.
- [ ] Verify a release, refresh the promotion index, and repeat an idempotent
      `test` promotion using a tag or release ID (old-owner URLs are rejected).
      Check the feed commit and hosted result.
- [ ] Only after all feed asset URLs use the new owner, inspect cleanup's
      classification and allow cleanup. Resume automation and monitor the first
      runs; test a new build and coordinated Docker release at the next version.

If a gate fails, keep automation paused and restore feed publication or access
before retrying. Do not replace signed assets or reuse a release version.
