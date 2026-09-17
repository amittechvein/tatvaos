# 0004 — TatvaOS as an OpenID Connect provider

**Status:** accepted
**Date:** 2026-09-15, accepted by the CTO 2026-09-15

## Context

Amit's decision, 15 Sept 2026: TatvaOS becomes an identity provider. A
customer's other software — payroll, accounting, HR — signs its users in with
their TatvaOS account instead of keeping passwords of its own. The opposite
direction, "sign in to TatvaOS with Google", is not this record.

The settings form Amit shared — provider, allowed email domain, client ID,
client secret, admin emails, redirect URI — is the relying party's side of
exactly this. Once TatvaOS is a provider, a customer's application shows a
form like that, and the customer fills it with values from a TatvaOS
**Applications** screen.

What exists today, read on 15 Sept:

- Sessions are JWTs signed HS256 with one symmetric key, `Jwt__SigningKey`
  (`apps/api/Shared/Auth/TokenIssuer.cs`). Access tokens live 15 minutes;
  refresh tokens live 14 days and rotate in families, resolved through
  `core.resolve_refresh_token`, a SECURITY DEFINER lookup. **That key cannot
  sign tokens for other software**: every relying party would need the
  secret to verify a token, and anyone holding it could mint a TatvaOS
  session.
- Credentials looked up before a tenant is known already have a pattern.
  Mail API keys are shown once, stored as SHA-256 with a visible prefix, and
  resolved through `mail.resolve_api_key`, a SECURITY DEFINER function,
  because row-level security hides the row until the tenant is set.
- `infra/docker/caddy/Caddyfile` sends the Core host's `/api/*` and `/health*` to
  the API and everything else to the web app. Nothing claims `/.well-known/`.
- `apps/api/Shared/Settings/PlatformSettings.cs` defines
  `sso.google.client_id` and `sso.google.client_secret`, and nothing reads
  them. They are a stub for the other direction; this record neither uses
  nor removes them.
- Caddy writes no access log (checked 13 and 15 Sept) and the web container
  logs no requests (checked 15 Sept).

## What it is

TatvaOS runs the OAuth 2.0 authorization code flow with PKCE and issues
OpenID Connect ID tokens.

1. **Registration.** An organisation admin creates an Application in the
   TatvaOS console: a name, one or more redirect URIs, and whether it is a
   server application (confidential, gets a secret) or a phone or browser
   application (public, no secret). TatvaOS shows a client ID, and for a
   server application a client secret, once.
2. **Sign-in.** The customer's application sends the person to
   `https://core.tatvaos.com/oauth/authorize`. If they are not signed in to
   TatvaOS they sign in there, with two-step verification if they use it. The
   first time, a consent screen asks them to allow the application.
3. **Code for tokens.** TatvaOS redirects back with a one-time code. The
   application's server trades it at the token endpoint, with its secret and
   its PKCE verifier, for an ID token (who the person is), an access token
   (for the userinfo endpoint), and a refresh token only if it asked for
   `offline_access`.
4. **Identity.** The application verifies the ID token's signature against
   TatvaOS's published keys and reads the person's identity from it.

Discovery at `https://core.tatvaos.com/.well-known/openid-configuration`
lists the rest: the key set, and the token, userinfo, revocation (RFC 7009)
and introspection (RFC 7662) endpoints, all under `/api/oauth/`.

## Options

1. **Hand-write the protocol.** Full control, no dependency. The protocol's
   edge cases — redirect URI matching, code replay, PKCE downgrade — are
   exactly where identity providers get breached, and we would be writing
   them for the first time.
2. **OpenIddict inside the API.** An open-source (Apache 2.0) OpenID Connect
   server library for ASP.NET Core. Authorization code with PKCE, reference
   tokens, refresh rotation, revocation, introspection and key rotation are
   built and widely used. It lives in the monolith, uses our Postgres and our
   login. Costs: its storage must be fitted to our tenancy (below), and the
   current major version must support .NET 10 — checked before adoption,
   not assumed.
3. **Keycloak as a sidecar container.** Complete, including SAML. A second
   user store to keep in sync with `core.users`, a JVM on the box that
   already runs LiveKit and egress, and a second login screen that is not
   ours.
4. **Duende IdentityServer.** Mature .NET option, commercially licensed.
   Rejected on licence cost and terms, not on engineering.

## Decision

Option 2, OpenIddict, narrowly scoped.

**Protocol scope, v1.** `response_type=code` only. PKCE with S256 required
for every client, confidential ones included. No implicit, hybrid, password
or device grants; no dynamic client registration; redirect URIs are https,
exact string match, no wildcards. Scopes: `openid`, `profile`, `email`,
`offline_access`.

**Issuer.** One issuer, `https://core.tatvaos.com`, for every organisation.
One Caddy `handle` sends `/.well-known/openid-configuration` to the API; the
authorize page is a web page; everything else sits under `/api/oauth/`.

**Claims.** `sub` is the person's user id — never the email, which changes.
Also `email`, `email_verified`, `name`, and `tid`, the organisation id, so
an application can refuse people from organisations it does not serve.

**Tokens.**

| | Form | Lifetime | Revocable immediately |
|---|---|---|---|
| Authorization code | opaque, stored hashed | 60 seconds, single use | yes |
| ID token | JWT, RS256 | 5 minutes | **no** — see "What revocation cannot do" |
| Access token | opaque reference, stored hashed | 10 minutes | yes, checked on every call |
| Refresh token | opaque reference, stored hashed | 14 days, rotated on every use | yes |

A code redeemed twice revokes every token issued from it. A refresh token
used twice revokes its whole chain, as `core.refresh_tokens` families
already do.

**Signing keys.** A new RSA key pair, never `Jwt__SigningKey`. The private
key lives in a new volume, `oidckeys`, mounted into the API only, file mode
0600, owned by the API user — the `dkimkeys` pattern. **Not in
`infra/docker/.env`**, because `backup.sh` copies that file verbatim, and
not in any backup: a lost signing key is replaced by generating a new one,
and relying parties pick it up from the published key set on their next
fetch. Nothing long-lived is signed, so nothing long-lived breaks. The key
set publishes the current and the next key; rotation every 90 days; a
retired key stays published for one day, longer than any ID token lives.

**Client secrets.** Shown once, stored as SHA-256 with a visible prefix,
looked up through a SECURITY DEFINER resolver — the mail API key pattern,
for the same reason: the token endpoint does not know the tenant until it
has found the client.

**Tenancy — decided by the CTO on 15 Sept: option (b).** OpenIddict looks
up applications and tokens by id before any tenant is known, and our tables
are FORCE ROW LEVEL SECURITY. Two ways through:

- *(a)* OpenIddict's own tables in a new `oidc` schema without RLS,
  reachable only by the API, with every tenant boundary enforced in our
  handlers: at authorize the person's `tenant_id` must equal the
  application's; at token and userinfo the token row carries the tenant. A
  cross-tenant test in CI guards it.
- *(b)* Custom OpenIddict stores. The two lookups that happen before a
  tenant is known — client by id, token by hash — go through SECURITY
  DEFINER resolvers; everything read after that is ordinary RLS.

(a) is less code, and it is the first place where the database would no
longer back up the application on tenancy. (b) keeps "every table under RLS"
true at the price of writing store methods on the protocol path.
**Decided: (b)**, because it is the pattern this codebase already trusts for
API keys and refresh tokens: custom OpenIddict stores, and a cross-tenant
test in CI.

**Only the lookups that must run before a tenant is known go through a
definer**: the client by id at authorize and at the token endpoint, and the
token by hash at userinfo, introspection and revocation. Each resolver takes
the key the caller already holds and returns that one row. A SECURITY
DEFINER function runs as its owner and does not see row-level security, so
routing every read through one would switch RLS off for those reads — the
opposite of the reason (b) was chosen. Every read after the tenant is known
is ordinary RLS.

**Consent.** The screen names the application, says "Added by
<organisation> administrators", shows the host it will return to, and lists
in words what it will receive: "your name, your work email address, and
which organisation you belong to". Continue or Cancel. The answer is
remembered per person, application and scope set, and listed on the
person's account page with a Remove button. An admin can mark an
application "allowed for everyone in the organisation", which skips the
prompt; flipping that switch is written to `core.audit_logs`.

**Revocation.** Deleting an application in the console sets its
`revoked_at` (revoke, not delete — the `mail.api_keys` posture) and, in the
same transaction, revokes every authorization and token it holds. From that
commit: authorize refuses the application, the token endpoint refuses its
secret and its refresh tokens, and userinfo and introspection answer
"inactive" for its access tokens.

**What revocation cannot do — said here and on the delete screen.** An ID
token already delivered is a signed statement the application verified on
its own; nothing can recall it, which is why it lives five minutes. And the
application's own session — the payroll app's cookie — belongs to the
application; TatvaOS cannot reach into it. The delete screen says: "People
already signed in to <app> stay signed in there until <app> signs them
out." OpenID Connect Back-Channel Logout, which lets a provider tell
applications to end sessions, is deferred.

**Suspension.** A suspended person or organisation cannot authorize, and
their refresh tokens stop working at the next use — the same liveness rule
as every credential store here.

**What never appears in a log, a transcript or a report.** Client secrets,
codes, PKCE verifiers, tokens, and the authorize redirect's `Location`
header. The code does travel in the redirect's query string — the protocol
requires it — which is why it is single-use, lives sixty seconds, and is
useless without the verifier.

## Security boundary

Every organisation that connects an application trusts TatvaOS's signing key
with sign-in to that application. A stolen private key lets its holder sign
in as anyone, to any connected application, of any organisation, until the
key is rotated. So:

- the private key exists in exactly one place, the `oidckeys` volume, and is
  never printed, copied to a laptop, pasted, or backed up;
- rotation is a runbook exercised once before the first customer connects,
  not written and trusted;
- ID tokens are short because they cannot be recalled;
- any change to key handling, token lifetimes or the consent screen goes to
  the CTO.

## What proves it

A script under `tests/oidc/`, run in CI against the local stack, acting as a
real relying party over HTTP:

1. Register an application in tenant A with redirect `https://rp.test/cb`.
   Run authorize, consent and token with PKCE. The ID token decodes; its
   signature verifies against the published key set with the matching
   `kid`; `iss`, `aud`, `nonce` and `exp` are correct; `sub` equals the
   signed-in person's user id; `email` and `tid` are theirs.
2. Userinfo with the access token returns the same `sub`.
3. Revoke the application. Immediately: the refresh token answers
   `invalid_grant`; userinfo with the still-unexpired access token answers
   401; introspection answers `"active": false`; a new authorize shows an
   error and issues no code. **And the ID token from step 1 still verifies**
   — the test asserts that too, because it is the documented limit, not a
   bug.
4. A person from tenant B at tenant A's application: refused, no code.
5. The same code redeemed twice: the second answers `invalid_grant`, and the
   access token from the first stops working.
6. A redirect URI that differs by a trailing slash or an extra query
   parameter: an error shown on TatvaOS, never a redirect.
7. A wrong or missing PKCE verifier: `invalid_grant`.
8. A suspended person's refresh token: refused.
9. After the run, the API and Caddy logs contain none of the secret, code,
   verifier or token values the script used.
10. With `app.tenant_id` set to tenant B, the app role reads no tenant A row
    from any provider table — RLS still holds everywhere the resolvers are
    not used.

Red first: run step 3 against a build whose userinfo skips the
application-liveness check, and watch userinfo answer 200. Run step 9 once
with a deliberate debug log line printing the code, and watch the search
find it.

The sentence "works with any OpenID Connect application" is not written
anywhere a customer can read it until the first customer test has passed and
the OpenID Foundation's conformance tests for a basic provider have run. It
promises customers that TatvaOS sign-in becomes a dependency of their own
software, so its wording is Amit's and the CTO's (CTO, 15 Sept).

## Consequences — and whether the surface is worth it

What it opens:

- **Availability becomes the customer's problem too.** If TatvaOS sign-in is
  down, a customer's payroll sign-in is down. One server in Mumbai becomes a
  dependency of their other software. This is the largest business
  consequence, and customer wording must not promise more than the box
  delivers.
- **Compliance questions arrive with it.** SAML 2.0 (older HR and payroll
  suites speak nothing else), SCIM user provisioning, evidence that two-step
  verification is enforced, audit exports, and consent records for personal
  data shared with third-party applications under India's Digital Personal
  Data Protection Act.
- **Ongoing care.** Key rotation, token lifetime choices, and library
  upgrades on a security-sensitive path.

What it gives: every customer's other software signs in with the account
the organisation already manages, and removing a person in TatvaOS ends
their access everywhere at the next token use. That is the reason a school
or clinic picks a suite over separate tools, and it moves TatvaOS from a
tenant of someone else's identity to the identity.

**Recommendation: worth it, narrowly** — OpenID Connect only, code with PKCE
only, OpenIddict, no SAML, SCIM or dynamic registration in v1, and customer
wording that states the availability dependency. Effort, as an estimate for
one developer: two to three weeks for v1, including the console screens, the
consent screen and the test script.

Related, not decided here: with a provider in place, the phone app can sign
in as a public client with PKCE through the system browser — the standard for
native apps (RFC 8252). 0003's handoff remains how the app opens web
products inside itself.

## Revisit when

A paying customer names an application that cannot speak OpenID Connect
(SAML), asks for user provisioning (SCIM), or TatvaOS moves to more than one
server — the issuer URL and key storage both change then.
