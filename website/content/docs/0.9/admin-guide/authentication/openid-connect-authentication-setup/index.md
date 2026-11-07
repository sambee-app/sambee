+++
title = "OpenID Connect Authentication Setup"
+++

OpenID Connect (OIDC) is Sambee's preferred authentication method.

## Preparation

### Copy OIDC Callback URI

Open **Settings** > **Administration** > **Authentication** and select an OIDC authentication mode. Select **Configure OIDC** and copy the OIDC callback URI from the dialog that opens. You need the URI in the next step. It has the following format:

```text
https://files.example.com/api/auth/oidc/callback
```

## Configure the OpenID Connect Identity Provider (IdP)

### Provider Properties

In your identity provider, create a new OpenID Connect IdP with the following properties:

- Confidential web client
- Authorization code flow
- PKCE with `S256`
- `client_secret_basic` token endpoint authentication
- `RS256`-signed ID tokens
- Sambee's callback URI (see above)
- The scopes `openid`, `profile`, `email`, and `offline_access`
   - Add `groups` only when using group admission or group-based role mappings
- Authorization-code and refresh-token grants

Configure token lifetimes:

- Refresh token:
   - A shorter lifetime requires users to sign in again sooner.
   - A longer lifetime increases the impact period if the token is compromised.
   - Maximum useful length: slightly longer than Sambee's interactive sign-in interval (default: 30 days).
- Access token and ID token:
   - Lifetimes should be short, e.g., 1 hour.

### Verify the Username Claim

Sambee needs to match OIDC provider usernames to its own usernames. Many OIDC providers return a username in the field `preferred_username` when the `profile` scope is enabled. To ensure that username claim is suitable, verify the following with your OIDC provider:

- How to enable returning the username claim (typically through the `profile` scope).
- The field name of the username claim (typically `preferred_username`).
- The username claim is present for every person who can sign in, stable for that person, and unique across all provider users.

### Authelia Example

The relevant Authelia client entry can look like this:

```yaml
identity_providers:
  oidc:
    lifespans:
      custom:
        sambee:
          # Maximum useful length: Sambee's interactive sign-in interval + 1 day
          refresh_token: "31d"
    clients:
      - client_id: sambee
        client_name: Sambee
        client_secret: "$pbkdf2-sha512$replace-with-a-hashed-random-secret"
        redirect_uris:
          - https://files.example.com/api/auth/oidc/callback
        grant_types:
          - authorization_code
          - refresh_token
        response_types:
          - code
        lifespan: sambee
        scopes:
          - openid
          - profile
          - email
          - offline_access
          # Add groups when using group admission or group-based role mappings.
          - groups
```

Notes:

- See Authelia's instructions for generating a [hashed client secret](https://www.authelia.com/integration/openid-connect/frequently-asked-questions/#how-do-i-generate-a-client-identifier-or-client-secret).
- Use your own values for the following fields: `redirect_uris`.
- The `profile` scope makes Authelia's `preferred_username` claim available from the username used to sign in, which is exactly what Sambee expects in its default OIDC settings (see below).
- See the [Authelia documentation](https://www.authelia.com/configuration/identity-providers/openid-connect/clients/) more details and default values.

## Configure Sambee

Open **Settings** > **Administration** > **Authentication**.

### 1. Choose the Sign-In Mode

Select one of these values in **Authentication mode**:

- **OIDC or password**
- **OIDC only**

The **Access** panel shows whether OIDC is configured and healthy. Select **Configure OIDC** to enter or change the provider settings.

### 2. Enter Provider Details

In the setup dialog, complete these fields in the **Provider** section:

| Sambee field | Value to enter |
|---|---|
| **Provider name** | A recognizable name for the provider, such as `Authelia` or `Microsoft Entra ID`. |
| **Issuer URL** | The provider's HTTPS issuer URL. For Authelia, this is normally the externally reachable URL of the Authelia portal, such as `https://auth.example.com`. <br />Open `https://auth.example.com/.well-known/openid-configuration` and enter the exact value of its `issuer` field. |
| **Client ID** | The client ID configured in the OIDC IdP. |
| **Client secret** | The matching client secret as plain text (unhashed).<br />On later changes, leave this blank to retain the stored secret. <br />The visibility button only reveals the value currently typed in the browser; Sambee never returns the stored secret. |
| **Scopes** | A comma-separated list. Include `openid`, `offline_access`, and every scope required to return the claims configured below, such as `profile` and `email`. Add `groups` when using group admission or group-based role mappings. |

### 3. Configure Session Policy

Set **Interactive sign-in interval (days)** to control how long a verified IdP sign-in can be renewed in the background. The default is 30 days.

During this interval, Sambee refreshes its short-lived API token in the background. At the interval deadline, Sambee requires a fresh interactive IdP sign-in.

### 4. Configure Access

Complete these fields in the **Access** section:

| Sambee field | Value to enter |
|---|---|
| **Admission** | **All authenticated users** is the default. Select **Only selected groups** to require membership in named groups before Sambee evaluates the person's role. |
| **Admission groups** | When **Admission** is **Only selected groups**, enter the exact identity-provider groups that may sign in, separated by commas. |

### 5. Configure Role Assignment

Choose how Sambee assigns roles after an identity passes the admission policy:

| Role assignment | Behavior |
|---|---|
| **All users are assigned to the same role** | Select **Administrator**, **Editor** (default), or **Viewer**. Every admitted user receives that role unless they have an individual assignment. This is the simplest choice for smaller environments. |
| **Group-based** | Enter exact identity-provider groups for **Administrator**, **Editor**, and **Viewer**. A person without an individual assignment must match a configured group; otherwise Sambee denies access. |

In group-based mode, a group can appear in only one role mapping. When a person matches multiple mappings, Sambee grants the highest role: Administrator, then Editor, then Viewer.

During activation (see below), Sambee gives the administrator completing the test an individual **Administrator** assignment. Individual assignments for linked or pending accounts always take precedence over the configured role assignment.

### 6. Advanced Claims

The default claim names work with most OpenID Connect providers. Expand **Advanced claims** only when the provider returns different claim names.

#### Claims

| Sambee field | Value to enter |
|---|---|
| **Username claim** | The stable, unique claim used to identify a person, commonly `preferred_username`. |
| **Name claim** | Optional claim containing the person's display name, commonly `name`. |
| **Email claim** | Optional claim containing the person's email address, commonly `email`. |
| **Groups claim** | Optional claim containing group membership, commonly `groups`. Required only for selected-group admission or group-based role assignment. |

Sambee records the OIDC issuer and subject for each linked account. By default, Sambee also treats the configured IdP as authoritative for usernames: when an admitted IdP user has the same username as a local account, Sambee links that identity to the local account. This also updates an existing link when an IdP migration changes the issuer or subject. Keep **Automatically link OIDC identities to local accounts by username** enabled unless you need to resolve username matches manually.

### 7. Connect and Test

Select **Connect and test** in the setup dialog. Sambee redirects you to the provider and returns to the dialog for review. This verifies that:

- Signing in via the specified OIDC configuration succeeds.
- Sambee can read and evaluate the resulting OIDC user identity.
- The tested identity passes the selected admission rule, so the current administrator can keep administrator access after activation.

Review the resulting identity before activation:

- **Username**, **Email**, and **Groups** show the claims Sambee received.
- **Admission** and **Matching admission group** show whether the tested identity passes the admission rule.

OIDC activation remains unavailable unless the tested OIDC identity passes the admission rule to prevent the local admin making the changes from locking themselves out.

### 8. Review and Activate

Select **Activate configuration** when the review is complete. The administrator who started the setup is linked to the tested provider identity automatically.

When OIDC is active, users sign in normally after an IdP migration or subject reset. With automatic username linking enabled, Sambee updates their stored OIDC link during their next admitted sign-in and signs out existing Sambee sessions for that account. Until then, their existing OIDC link and IdP-managed full name and email remain read-only in User Management.

After activation, see [OpenID Connect Authentication Operations](../openid-connect-authentication-operations/) for session, account-mapping, auditing, and request-limit administration.
