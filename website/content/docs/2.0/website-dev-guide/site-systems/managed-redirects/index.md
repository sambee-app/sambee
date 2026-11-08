+++
title = "Managed Redirects"
+++

Managed redirects provide stable `sambee.net` URLs for the product while allowing their destinations to change in a website deployment.

## When To Use A Managed Redirect

Use a managed redirect when product code, documentation, or external communication needs a durable public link whose destination may change. Product code should use a URL under `/mr/`, such as:

```text
https://sambee.net/mr/help-oidc-setup
```

Do not use a managed redirect for ordinary website navigation or a link whose destination is already a stable public contract.

## Source Path Contract

The source path is immutable after release. Treat it as a public API:

- Add a new path for each new long-lived product link.
- Do not rename, remove, or reuse a released `/mr/` path.
- Change the destination by updating its `target` value and deploying the website.

Managed redirects use HTTP `302`, not `301`. This avoids a permanent redirect
contract. Actual caching still depends on response headers and the client.

## Add A Redirect

Add an entry to `website/data/managed-redirects.toml`:

```toml
[[redirects]]
id = "help-oidc-setup"
source = "/mr/help-oidc-setup"
target = "/docs/admin-guide/authentication/openid-connect-authentication-setup/"
```

Each entry requires:

- A unique `id` for review and maintenance.
- A unique literal `source` that starts with `/mr/` and has no trailing slash, query, fragment, or wildcard.
- A site-relative internal `target` or an external HTTPS URL without credentials.

Internal targets must be final HTTP 200 routes in the Hugo manifest. Absolute
URLs on the docs site host are rejected; use site-relative paths so links work
in preview deployments. If a target is itself a redirect, the build names its
final destination and stops. Update the registry; targets are not rewritten silently.

The source path is the immutable contract. Only `target` is expected to change after release.

## Build Behavior

`npm run redirects:generate` validates the registry against `docs-routes.json` and
combines managed rules with docs entries, recorded migrations, and non-docs platform
rules in the built `_redirects` artifact. It validates the complete output before
replacing the file. There is no separate static docs redirect list.

The normal website build and deployment workflow runs the generator automatically. To check the generated rules locally after a Hugo build, run:

```bash
cd website
npm run redirects:generate
```

The generator fails the build for malformed entries, duplicate IDs or sources,
missing or non-final internal targets, page overrides, loops, ambiguous rules,
or Cloudflare limit violations. Each shortcut reaches its final page in one hop.
The Hugo development server does not apply these rules; managed sources return
404 locally. Check live status and `Location` headers manually after deployment.

