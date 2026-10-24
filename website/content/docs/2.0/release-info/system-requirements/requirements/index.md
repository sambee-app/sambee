+++
title = "System Requirements"
+++

## Frontend

### Web Browsers

Sambee's frontend supports the latest versions of desktop and mobile browsers, including:

- Google Chrome (and derivates)
- Mozilla Firefox
- Apple Safari

Web Workers must be available. If a browser lacks this or another required modern capability, Sambee shows a browser compatibility message instead of loading the app. This checks a few key capabilities, not every feature Sambee uses. Browser or security policies that prevent a worker from starting can still cause a feature-specific error after the app loads.

To preview this message on the development server, open `http://localhost:3000/browse/smb/demo?simulateUnsupportedBrowser`. Remove the query parameter to load the app normally. This flag has no effect in production builds.

### HTTPS

**Accessing Sambee over HTTPS is very much recommended.** Typically, a reverse proxy such as Caddy is used for that purpose. See the [reverse proxy docs](https://sambee.net/docs/admin-guide/network-and-reverse-proxy/put-sambee-behind-a-reverse-proxy/) for more information, and [this blog post by Helge Klein](https://helgeklein.com/blog/automatic-https-certificates-for-services-on-internal-home-network-without-opening-firewall-port/) for a detailed configuration guide.

Companion pairing and operations are only available over HTTPS (or `http://localhost`, for local development).

## Sambee Companion

Sambee Companion is currently available for Windows 11 on x64 and ARM64.
