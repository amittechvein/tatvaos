namespace TatvaOS.Api.Modules.Auth.Endpoints;

/// <summary>
/// The OpenID Connect provider's own endpoints — decision 0004.
///
/// Stage 2: OpenIddict handles discovery, the key set and the token,
/// introspection and revocation endpoints itself. The authorize endpoint is
/// passed through to us because it is where a PERSON arrives in a browser
/// and has to be signed in, asked for consent, and sent back — and that is
/// stage 3. Until then it answers 501 in plain words, so an application
/// registered today gets a sentence and not a stack trace or a silent hang.
/// </summary>
public static class OidcEndpoints
{
    public const string AuthorizePath = "/api/oauth/authorize";
    public const string TokenPath = "/api/oauth/token";
    public const string UserInfoPath = "/api/oauth/userinfo";
    public const string IntrospectionPath = "/api/oauth/introspect";
    public const string RevocationPath = "/api/oauth/revoke";
    public const string JwksPath = "/api/oauth/jwks";

    public static void MapOidcEndpoints(this IEndpointRouteBuilder app)
    {
        // Both verbs: the protocol allows an authorization request by GET or
        // POST, and OpenIddict has already parsed and validated it by the time
        // this runs (passthrough means "after validation, hand it to me").
        app.MapMethods(AuthorizePath, ["GET", "POST"], () =>
                Results.Problem(
                    title: "Sign-in through applications is not available yet",
                    detail: "This TatvaOS server publishes its OpenID Connect configuration and keys, but the "
                          + "sign-in step is not built yet. Registering an application works; signing in "
                          + "through one does not, until the next release.",
                    statusCode: StatusCodes.Status501NotImplemented))
            .AllowAnonymous()
            .WithTags("OpenID Connect");
    }
}
