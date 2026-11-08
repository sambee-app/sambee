+++
title = "Set Up Cloudflare Pages Publishing"
+++

Use this page to set up and maintain the website deployment workflow that publishes built website assets to Cloudflare Pages.

## Overview

The repository uses a split deployment model:

- Hugo builds the site into `website/public/`.
- Built assets are published from there to Cloudflare Pages.
- Source images and generated WebP derivatives remain in Git LFS.

The workflow builds on pull requests and pushes to `main`. The deploy job runs only on `main`.

## Prepare Cloudflare

Complete these Cloudflare steps first, then add the collected values to GitHub in the next section.

1. Create a Cloudflare Pages project to receive the built HTML from `website/public/`:
   - Go to **Workers & Pages** > **Create application**
   - Select **Looking to deploy Pages? Get started** > **Drag and drop your files - Get started**
   - Project name: `sambee-net` (to be stored in `CLOUDFLARE_PAGES_PROJECT`)
   - Select **Create project**
1. Go to the Pages project properties and set up a custom domain.
1. In **My Profile** > **API Tokens**, create a separate Cloudflare API token for the Pages deployment step:
   - Name: `GitHub Actions - deploy Pages - sambee.net`
   - Permissions: Account, Cloudflare Pages, edit
1. Save that Pages API token for `CLOUDFLARE_API_TOKEN`
1. Extract the Cloudflare account ID for the account that owns the Pages project from the URL: `https://dash.cloudflare.com/ACCOUNT_ID/home/overview`

## Add GitHub Secrets

After Cloudflare is ready, open the GitHub repository settings, go to **Secrets and variables** > **Actions**, and add these repository secrets:

- `CLOUDFLARE_API_TOKEN` for the Cloudflare API token used by the Pages deploy step.
- `CLOUDFLARE_ACCOUNT_ID` for the Cloudflare account that owns the Pages project.
- `CLOUDFLARE_PAGES_PROJECT` for the Cloudflare Pages project name passed to `wrangler pages deploy`.

## CI Deploy

The deploy job publishes `website/public` to Cloudflare Pages from the `main` branch.

The build job runs `npm run build:deploy` with `HUGO_BASEURL`. It validates docs,
renders pages and the route manifest, generates HTTP rules, indexes Pagefind, and
checks homepage links and docs output. All website tests must pass. Pull requests,
including forks, build and validate without Cloudflare secrets. They do not deploy
a preview. Main deploys the exact artifact that passed the checks. Publish HTML,
`docs-routes.json`, and `_redirects` together, never as separate updates.

The production smoke job checks the homepage and assets only. Docs HTTP acceptance
is manual after deployment and is not a pre-deployment gate.

## Manual Cloudflare Checks

Use fresh clients and the manifest and rules from the deployment. Record the
deployment URL, date, checked paths, status, and `Location` headers. Request each
source without following redirects, then request its target separately:

```bash
curl --silent --show-error --dump-header - --output /dev/null https://sambee.net/docs/
curl --silent --show-error --dump-header - --output /dev/null https://sambee.net/docs/release-info/news-and-changes/whats-new/
```

Do not use `--location` for the source request. Select actual paths from the
deployment manifest rather than assuming that the entry destination is an article.

- Check `/docs` and `/docs/`: Each returns one HTTP 302 to the current entry page.
- Check all known version roots: Each returns HTTP 302 within that explicit version.
- Check current articles and landings: Each returns HTTP 200, current content, a self-canonical tag, and no `noindex`.
- Check explicit current, archived, preview, and inherited pages: Each returns HTTP 200, requested-version content, `noindex,follow`, no canonical tag, and no browser forwarding. Include restored 0.7 book and section landings.
- Check the managed shortcut and a historical alias: Each reaches its final HTTP 200 page in one hop with the generated status.
- Check unknown versions and paths: Each returns HTTP 404, not a wildcard rewrite.
- Check slash and slashless redirect sources, query strings, and actual cache headers.
- Check a deployed entry redirect in a browser with a fragment. Confirm that the intended fragment remains after navigation.
- Check Cloudflare dashboard and Bulk Redirect rules for overrides of the generated policy.

Hugo and local artifact checks do not prove Cloudflare status codes or matching.
Do not report live acceptance as complete until these results are available.

## Rollback and Cache Recovery

If live checks find a defect, open **Workers & Pages**, select the Pages project,
open **Deployments**, and select the last known-good production deployment. Use
its **Rollback** action and confirm the rollback. Recheck the source and target
responses with a fresh client. This restores pages, manifest, and rules together.
The workflow deletes its short-lived build artifact; do not depend on that artifact
as the rollback method.

Old HTTP 301 responses can remain in a browser cache after deployment or rollback.
The server cannot clear them. Clear the affected site's browser data or use a fresh
browser profile, then retry the URL. Check actual redirect cache headers: HTTP 302
does not guarantee that every intermediary cache is disabled. External Cloudflare
rules can run before Pages rules and must be removed or corrected separately.

## Repository Preconditions

Before deployment can publish correct media:

- Source images live under `website/assets/images/`.
- Generated WebP derivatives are committed in sibling `generated/` directories.
- Downloadable files live under `website/static/files/`.
- `npm run images:validate` passes.
- The site build produces `website/public/images/` and `website/public/files/`.

For local verification:

```bash
cd website
git lfs pull
npm ci
npm run build
```

## Current Asset Behavior

The generated site still uses site-relative asset paths such as `/images/...` and `/files/...`.

That means this workflow deploys the website to Cloudflare Pages, but it does not rewrite asset URLs to a separate CDN hostname.
