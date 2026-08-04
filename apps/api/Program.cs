using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Admin.Endpoints;
using TatvaOS.Api.Modules.Auth.Endpoints;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

var builder = WebApplication.CreateBuilder(args);

// ---------------------------------------------------------------------------
//  Tenancy — registered first because everything below depends on it
// ---------------------------------------------------------------------------
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<TenantContext>();
builder.Services.AddScoped<TenantConnectionInterceptor>();

// ---------------------------------------------------------------------------
//  Database
// ---------------------------------------------------------------------------
builder.Services.AddDbContext<AppDbContext>((sp, options) =>
{
    options.UseNpgsql(builder.Configuration.GetConnectionString("Postgres"));

    // The interceptor sets app.tenant_id on every connection. Without it, RLS
    // has nothing to compare against and every query returns zero rows.
    //
    // The connection string MUST use the tatvaos_app role, which is created
    // NOBYPASSRLS. Connecting as postgres or any BYPASSRLS role silently
    // disables tenant isolation — the queries succeed and return everything.
    options.AddInterceptors(sp.GetRequiredService<TenantConnectionInterceptor>());

    if (builder.Environment.IsDevelopment())
    {
        options.EnableSensitiveDataLogging();
        options.EnableDetailedErrors();
    }
});

// ---------------------------------------------------------------------------
//  Authentication and authorisation
// ---------------------------------------------------------------------------
var jwtKey = builder.Configuration["Jwt:SigningKey"]
             ?? Environment.GetEnvironmentVariable("JWT_SIGNING_KEY")
             ?? throw new InvalidOperationException(
                 "JWT signing key is not configured. Set Jwt:SigningKey or JWT_SIGNING_KEY. " +
                 "There is deliberately no default — a hardcoded fallback would ship to production.");

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"],
            ValidAudience = builder.Configuration["Jwt:Audience"],
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });

builder.Services.AddAuthorizationBuilder()
    .AddPolicy("SuperAdmin", p => p.RequireRole("super_admin"))
    .AddPolicy("OrgAdmin", p => p.RequireRole("super_admin", "org_owner", "org_admin"))
    .AddPolicy("User", p => p.RequireAuthenticatedUser());

// ---------------------------------------------------------------------------
//  Application services
// ---------------------------------------------------------------------------
builder.Services.AddScoped<IPasswordHasher, Argon2PasswordHasher>();
builder.Services.AddScoped<TokenIssuer>();
builder.Services.AddScoped<StorageAllocator>();
builder.Services.AddScoped<AuditWriter>();

builder.Services.AddOpenApi();

builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? ["http://localhost:3000"])
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

var app = builder.Build();

// ---------------------------------------------------------------------------
//  Pipeline — order matters
// ---------------------------------------------------------------------------
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
else
{
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseCors();

app.UseAuthentication();
// AFTER authentication — it reads the tenant claim from the validated principal.
// BEFORE the endpoints — they hit the database and need the context set.
app.UseMiddleware<TenantMiddleware>();
app.UseAuthorization();

app.MapAuthEndpoints();
app.MapOrganisationEndpoints();
app.MapUserEndpoints();

// ---------------------------------------------------------------------------
//  Bootstrap the first super admin
// ---------------------------------------------------------------------------
//  A fresh database has no way in. Passwords are Argon2id, so they cannot be
//  seeded from SQL — there is no way to write a valid hash by hand — and a
//  seeded default password would be the same on every install, which is worse
//  than no login at all.
//
//  So: if no super admin exists AND both variables are set, create one. Runs
//  once; on every later start the account exists and this does nothing. Unset
//  the variables after the first start.
// ---------------------------------------------------------------------------
await BootstrapAdmin.EnsureAsync(app.Services, app.Logger);

app.MapGet("/health", () => Results.Ok(new { status = "ok" }))
   .AllowAnonymous()
   .WithTags("Operations");

app.MapGet("/health/db", async (AppDbContext db, CancellationToken ct) =>
{
    var canConnect = await db.Database.CanConnectAsync(ct);
    return canConnect ? Results.Ok(new { database = "ok" })
                      : Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
}).AllowAnonymous().WithTags("Operations");

app.Run();

/// <summary>Exposed so the integration and isolation tests can boot the app.</summary>
public partial class Program;
