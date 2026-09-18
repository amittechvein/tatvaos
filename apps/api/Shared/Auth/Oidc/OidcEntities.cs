using OpenIddict.EntityFrameworkCore.Models;

namespace TatvaOS.Api.Shared.Auth.Oidc;

// ============================================================================
//  The OpenID Connect provider's four tables — decision 0004, stage 1.
// ============================================================================
//
//  OpenIddict's own entity shapes, each given a TenantId, so the tables sit
//  under FORCE ROW LEVEL SECURITY like every other table here. This is
//  option (b) of 0004: the two lookups that must run before a tenant is
//  known (client by id, token by reference) go through SECURITY DEFINER
//  resolvers in TenantSafeStores.cs; every other read and every write is
//  ordinary RLS. AppDbContext.SaveChangesAsync stamps TenantId on every new
//  row, and RLS WITH CHECK refuses a mismatched one — the same two fences
//  every tenant-owned row already has.
//
//  Column names come from AppDbContext's snake_case convention, so the SQL in
//  local/postgres/init/20260917-oidc-provider.sql is written to match EXACTLY
//  what EF will ask for: ClientId → client_id, RedirectUris → redirect_uris,
//  the shadow foreign keys → application_id / authorization_id. A mismatch
//  compiles perfectly and fails on the first query, which is why stage 1's
//  test creates a row through the manager and reads it back.
//
//  The scopes table is the one that carries no tenant: openid, profile, email
//  and offline_access are the same four for every organisation and are
//  registered in code. The table exists because OpenIddict's EF integration
//  expects the entity; it is reference data, readable by everyone.
// ============================================================================

public sealed class OidcApplication : OpenIddictEntityFrameworkCoreApplication<Guid, OidcAuthorization, OidcToken>
{
    public Guid TenantId { get; set; }

    /// <summary>Who registered it, for the console and the audit trail.</summary>
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// Revoke, never delete — the mail.api_keys posture. From this timestamp
    /// the client resolver stops returning the row, so authorize and the
    /// token endpoint answer invalid_client; the console still lists it.
    /// </summary>
    public DateTimeOffset? RevokedAt { get; set; }

    /// <summary>
    /// The first characters of a confidential client's secret, so the console
    /// can say "the one starting tos_ab12…" without ever holding the secret.
    /// The secret itself is hashed by OpenIddict's manager and never stored
    /// in a recoverable form.
    /// </summary>
    public string? ClientSecretPrefix { get; set; }

    /// <summary>
    /// "Allowed for everyone in the organisation": skips the consent prompt.
    /// Flipping it is audited (0004). Mirrors ConsentType so the console has
    /// one boolean and OpenIddict has its own word for the same fact.
    /// </summary>
    public bool AllowedForEveryone { get; set; }

    // ----------------------------------------------------------------------
    //  WHO THE APPLICATION SAYS IT IS (0004; Amit's review, 18 Sept 2026).
    //
    //  Every field below is a string somebody typed into a form. None of it
    //  is verified by us, and the consent screen must never present it with
    //  the authority of "Added by <organisation> administrators", which IS a
    //  fact we can vouch for. A self-declared company name shown as a checked
    //  one is a phishing vector (CTO, 18 Sept 2026).
    //
    //  Standard OpenID Connect client-metadata names where they exist
    //  (RFC 7591 section 2): ClientUri, PolicyUri, TosUri, Contacts.
    //  Description and OperatorName are ours and are not dressed up as
    //  protocol fields.
    // ----------------------------------------------------------------------
    public string? Description { get; set; }
    public string? OperatorName { get; set; }
    public string? ClientUri { get; set; }
    public string? PolicyUri { get; set; }
    public string? TosUri { get; set; }
    public string? Contacts { get; set; }

    /// <summary>
    /// Our copy of the logo, served from our own endpoint and never
    /// hotlinked from the application's server - see the migration for why.
    /// LogoContentType is the only type it is ever served as.
    /// </summary>
    public byte[]? LogoBytes { get; set; }
    public string? LogoContentType { get; set; }
    public DateTimeOffset? LogoUpdatedAt { get; set; }
}

public sealed class OidcAuthorization : OpenIddictEntityFrameworkCoreAuthorization<Guid, OidcApplication, OidcToken>
{
    public Guid TenantId { get; set; }
}

public sealed class OidcScope : OpenIddictEntityFrameworkCoreScope<Guid>
{
}

public sealed class OidcToken : OpenIddictEntityFrameworkCoreToken<Guid, OidcApplication, OidcAuthorization>
{
    public Guid TenantId { get; set; }
}
