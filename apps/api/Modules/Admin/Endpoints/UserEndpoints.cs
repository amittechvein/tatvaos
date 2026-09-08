using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Organisation administration — people within one tenant.
///
/// Every query here is scoped by the tenant on the authenticated principal.
/// There is no route parameter for the tenant, deliberately: an id in the URL
/// is an id a client can change.
///
/// ─────────────────────────────────────────────────────────────────────────
///  These endpoints operate on PEOPLE (core.users), not on mailboxes.
///
///  Creating a person may also create a mailbox, but the person is the thing
///  that exists. Suspending one removes every product at once — which is the
///  entire reason identity sits in Core rather than in Mail. If this ever
///  starts taking a mailbox id, the "one suspend" promise is gone and
///  somebody will keep their Payroll access after they leave.
/// ─────────────────────────────────────────────────────────────────────────
///
/// One boundary worth stating explicitly, because it is a design position and
/// not an oversight: an organisation admin can create users, reset passwords
/// and set quotas, but has NO endpoint that returns another user's mail.
/// Administrative power over an account does not imply access to its contents.
/// Where mailbox delegation is genuinely needed it is explicit, audited, and
/// visible to the mailbox owner.
/// </summary>
public static class UserEndpoints
{
    /// <summary>One person's storage across every product, for the list page.</summary>
    private sealed record UserUsageRow(Guid UserId, long UsedBytes, long? QuotaBytes);

    public static void MapUserEndpoints(this IEndpointRouteBuilder app)
    {
        var users = app.MapGroup("/api/org/users")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        users.MapGet("/", ListAsync);
        users.MapPost("/", CreateAsync);
        users.MapPut("/{id:guid}", UpdateAsync);
        users.MapPost("/bulk", BulkCreateAsync);
        users.MapPost("/{id:guid}/suspend", SuspendAsync);
        users.MapPost("/{id:guid}/reactivate", ReactivateAsync);
        users.MapPost("/{id:guid}/reset-password", ResetPasswordAsync);
        users.MapPost("/{id:guid}/reset-mailbox-password", ResetMailboxPasswordAsync);
        users.MapDelete("/{id:guid}", DeleteAsync);
        users.MapPost("/{id:guid}/offboard", OffboardAsync);

        // Profile photos are SELF-SERVICE or admin-managed, so they cannot sit
        // in the OrgAdmin group — an ordinary employee setting their own photo
        // from the account page is not an admin and would be blocked before the
        // handler ran. This group requires only an authenticated user; each
        // write handler enforces "your own photo, or you administer this org".
        // Reads are open to any signed-in member of the tenant (RLS scopes them
        // to the tenant anyway) so colleagues' photos can render in a list.
        var avatars = app.MapGroup("/api/org/users")
            .RequireAuthorization("User")
            .WithTags("Organisation administration");
        avatars.MapGet("/{id:guid}/avatar", AvatarAsync);
        avatars.MapPut("/{id:guid}/avatar", SetAvatarAsync);
        avatars.MapDelete("/{id:guid}/avatar", DeleteAvatarAsync);

        // Departments live in DepartmentEndpoints — they are a tree now, and
        // two routes reaching the same table with different shapes is how the
        // screen and the API start disagreeing about what a quota means.
    }

    // ------------------------------------------------------------------
    //  The role hierarchy, in one place.
    //
    //  An org_admin must not be able to act ON an org_owner — suspend them,
    //  delete them, or reset their password. Any of those is a takeover: reset
    //  the owner's password, sign in as them, and the organisation has a new
    //  owner in every way that matters. Only an owner (or the platform) may
    //  touch an owner, and only an owner may MAKE an owner for the same
    //  reason in reverse.
    // ------------------------------------------------------------------
    private static bool IsOwnerScope(TenantContext tenant) =>
        tenant.Role is "org_owner" or "super_admin";

    private static IResult? GuardActOn(TenantContext tenant, User target) =>
        target.Role == "org_owner" && !IsOwnerScope(tenant)
            ? Results.Json(new
              {
                  error = "Only an organisation owner can manage another owner's account.",
              }, statusCode: 403)
            : null;

    private static readonly string[] AssignableRoles =
        ["org_owner", "org_admin", "it_admin", "manager", "employee", "auditor"];

    /// <summary>
    /// Ends every live session the person has, immediately. Suspension and
    /// password resets that leave refresh tokens alive only take effect when
    /// the access token expires — up to fifteen minutes in which a suspended
    /// account keeps working, which reads as the button not working.
    /// </summary>
    private static Task RevokeSessionsAsync(
        AppDbContext db, Guid userId, string reason, CancellationToken ct) =>
        db.RefreshTokens
            .Where(t => t.UserId == userId && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(t => t.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow)
                .SetProperty(t => t.RevokeReason, (string?)reason), ct);

    private static async Task<bool> WouldRemoveLastOwnerAsync(
        AppDbContext db, User target, CancellationToken ct) =>
        target.Role == "org_owner" &&
        await db.Users.CountAsync(
            u => u.Role == "org_owner" && u.Id != target.Id && u.Status == "active", ct) == 0;

    private static async Task<IResult> ListAsync(
        AppDbContext db, Guid? departmentId, string? q, CancellationToken ct)
    {
        // No .Where(u => u.TenantId == ...) here — the global query filter and
        // RLS both apply it. Writing it by hand as well would suggest the
        // filter is optional, and someone would eventually "tidy it away".
        //
        // Deleted people are hidden from the roster. A soft delete keeps the
        // row for audit and for the "one suspend removes every product"
        // guarantee, but a decommissioned account listed among the active
        // staff — as the retired bootstrap admin was — is clutter, and the
        // header count ("N in this organisation") must not include the dead.
        var query = db.Users.AsNoTracking().Where(u => u.Status != "deleted");

        if (departmentId is Guid cid)
            query = query.Where(u => u.DepartmentId == cid);

        if (!string.IsNullOrWhiteSpace(q))
        {
            var term = $"%{q.Trim()}%";
            query = query.Where(u =>
                EF.Functions.ILike(u.Email, term) ||
                EF.Functions.ILike(u.DisplayName, term));
        }

        // Three queries, not one projection with correlated subqueries.
        //
        // Pulling the mailbox fields as three separate subqueries per user
        // would issue three round trips per row, and collecting the product
        // codes inside a projection is not something EF reliably translates.
        // A school listing 400 students is the normal case here, so the shape
        // of this query is the difference between a page that loads and one
        // that times out.
        var rows = await query
            .OrderBy(u => u.Email)
            .Select(u => new
            {
                u.Id, u.Email, u.DisplayName, u.DepartmentId,
                DepartmentName = u.Department != null ? u.Department.Name : null,
                u.Role, u.Status, u.MfaEnabled, u.LastLoginAt, u.CreatedAt,
                HasVerifiedRecoveryEmail = u.RecoveryEmailVerifiedAt != null,
            })
            .ToListAsync(ct);

        var ids = rows.Select(r => r.Id).ToList();

        var boxes = await db.Mailboxes.AsNoTracking()
            .Where(m => m.UserId != null && ids.Contains(m.UserId.Value))
            .Select(m => new { UserId = m.UserId!.Value, m.Address, m.QuotaBytes, m.UsedBytes })
            .ToListAsync(ct);

        var access = await db.ProductAccess.AsNoTracking()
            .Where(p => ids.Contains(p.UserId) && p.RevokedAt == null)
            .Select(p => new { p.UserId, p.ProductCode })
            .ToListAsync(ct);

        // Which of these people have a photo — just the ids, never the bytes.
        var withAvatar = (await db.UserAvatars.AsNoTracking()
            .Where(a => ids.Contains(a.UserId))
            .Select(a => a.UserId)
            .ToListAsync(ct)).ToHashSet();

        // Usage across ALL products, one query for the whole page rather than
        // a function call per row. The people list is built for four hundred
        // people and a per-row call is four hundred round trips.
        var usageRows = await db.Database
            .SqlQuery<UserUsageRow>($@"
                SELECT u.id AS ""UserId"",
                       COALESCE((SELECT SUM(x.used_bytes) FROM core.user_storage_usage(u.id) x), 0)::bigint AS ""UsedBytes"",
                       u.storage_quota_bytes AS ""QuotaBytes""
                  FROM core.users u
                 WHERE u.id = ANY({ids})")
            .ToListAsync(ct);
        var usageByUser = usageRows.ToDictionary(r => r.UserId);

        var boxByUser = boxes.GroupBy(b => b.UserId).ToDictionary(g => g.Key, g => g.First());
        var productsByUser = access.GroupBy(a => a.UserId)
            .ToDictionary(g => g.Key, g => g.Select(a => a.ProductCode).ToArray());

        var list = rows.Select(r =>
        {
            boxByUser.TryGetValue(r.Id, out var box);
            return new UserResponse(
                r.Id, r.Email, r.DisplayName,
                box?.Address,
                r.DepartmentId, r.DepartmentName,
                r.Role, r.Status,
                productsByUser.TryGetValue(r.Id, out var p) ? p : [],
                // The person's allowance and what they are using across every
                // product — NOT the mailbox's. Falls back to the mailbox
                // figures for anyone provisioned before the allowance existed.
                usageByUser.TryGetValue(r.Id, out var use) && use.QuotaBytes is long qb
                    ? qb : box?.QuotaBytes ?? 0,
                usageByUser.TryGetValue(r.Id, out var use2)
                    ? use2.UsedBytes : box?.UsedBytes ?? 0,
                r.MfaEnabled, r.LastLoginAt, r.CreatedAt,
                r.HasVerifiedRecoveryEmail,
                withAvatar.Contains(r.Id));
        }).ToList();

        return Results.Ok(list);
    }

    private static async Task<IResult> CreateAsync(
        CreateUserRequest req,
        AppDbContext db, StorageAllocator storage, TenantContext tenant,
        AuditWriter audit, IPasswordHasher hasher,
        SystemMailer mailer, IConfiguration config, CancellationToken ct)
    {
        var capacity = await storage.GetCapacityAsync(tenant.TenantId, "mail", ct);
        if (!capacity.CanAddUser)
            return Results.BadRequest(new { error = capacity.Reason });

        var domain = await db.Domains.FirstOrDefaultAsync(d => d.Id == req.DomainId, ct);
        if (domain is null) return Results.BadRequest(new { error = "Unknown domain." });

        // Mailboxes on an unverified domain would be created and then fail to
        // receive anything, which looks like our bug rather than an incomplete
        // setup. Refuse clearly instead.
        if (domain.OwnershipVerifiedAt is null)
            return Results.BadRequest(new
            {
                error = $"The domain {domain.Fqdn} is not verified yet. Publish the verification " +
                        "TXT record first — mailboxes created now could not receive mail.",
            });

        var localPart = req.LocalPart.Trim().ToLowerInvariant();
        if (!IsValidLocalPart(localPart))
            return Results.BadRequest(new { error = "Invalid local part." });

        var address = $"{localPart}@{domain.Fqdn}";

        var category = req.DepartmentId is Guid cid
            ? await db.Departments.FirstOrDefaultAsync(c => c.Id == cid, ct)
            : null;

        var products = req.Products ?? category?.DefaultProducts ?? ["mail"];
        var wantsMailbox = products.Contains("mail");

        // The sign-in identity must be unique platform-wide. So must a mailbox
        // address, and the two share a namespace, so both are checked even when
        // no mailbox is being created.
        if (await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Email == address, ct))
            return Results.Conflict(new { error = $"{address} already exists as a sign-in." });

        if (wantsMailbox &&
            (await db.Mailboxes.IgnoreQueryFilters().AnyAsync(m => m.Address == address, ct) ||
             await db.Aliases.IgnoreQueryFilters().AnyAsync(a => a.Address == address, ct)))
            return Results.Conflict(new { error = $"{address} already exists." });

        var password = req.Password ?? PasswordGenerator.Generate();

        // Explicit role wins over the department default. Owners making
        // owners is the succession path — without it the first owner is the
        // only owner forever, and the last-owner protections elsewhere mean
        // they can never even leave.
        string role;
        if (!string.IsNullOrWhiteSpace(req.Role))
        {
            role = req.Role.Trim().ToLowerInvariant();
            if (!AssignableRoles.Contains(role))
                return Results.BadRequest(new { error = "Unknown role." });
            if (role == "org_owner" && !IsOwnerScope(tenant))
                return Results.Json(new
                {
                    error = "Only an organisation owner can create another owner.",
                }, statusCode: 403);
        }
        else
        {
            role = category?.DefaultRole ?? "employee";
        }

        // ---- Core: the person -------------------------------------------
        var user = new User
        {
            TenantId = tenant.TenantId,
            DomainId = domain.Id,
            Email = address,
            DisplayName = req.DisplayName.Trim(),
            DepartmentId = category?.Id,
            Role = role,
            Status = "pending",
            PasswordHash = hasher.Hash(password),
            // An admin generated this and will send it over chat or read it
            // aloud. It is a handover credential, not the person's password.
            MustChangePassword = true,
        };
        // The person's allowance across every product. Resolved the same way
        // the mailbox quota was — explicit value, else department, else org —
        // so nothing about provisioning changes except where it is recorded.
        user.StorageQuotaBytes = await storage.ResolveQuotaAsync(
            tenant.TenantId, req.DepartmentId, req.QuotaBytes, "mail", ct);

        db.Users.Add(user);

        foreach (var code in products.Distinct())
            db.ProductAccess.Add(new ProductAccess
            {
                TenantId = tenant.TenantId,
                UserId = user.Id,
                ProductCode = code,
            });

        // ---- Mail: what Core grants them --------------------------------
        Mailbox? mailbox = null;
        if (wantsMailbox)
        {
            var quota = await storage.ResolveQuotaAsync(
                tenant.TenantId, req.DepartmentId, req.QuotaBytes, "mail", ct);

            mailbox = new Mailbox
            {
                TenantId = tenant.TenantId,
                DomainId = domain.Id,
                UserId = user.Id,
                Address = address,
                LocalPart = localPart,
                Type = "user",
                // Same password to start with, so the person has one thing to
                // remember on day one. It diverges the moment either is reset,
                // which is the point of keeping them in separate columns.
                ImapPasswordHash = hasher.Hash(password),
                QuotaBytes = quota,
            };
            db.Mailboxes.Add(mailbox);
        }

        // Default folders are created by the trg_mail_default_folders trigger,
        // not here. One implementation covers the API, the seed and anything
        // that inserts a mailbox later; two would drift.
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("user.created", "user", user.Id.ToString(),
            after: new { user.Email, products, category = category?.Name }, ct: ct);

        // ------------------------------------------------------------------
        //  Welcome email — the branded first message in their new inbox.
        //
        //  Only when a mailbox was actually created: a Payroll-only person has
        //  no inbox to receive it. This is LOCAL delivery to their own hosted
        //  mailbox, so it lands even before outbound SMTP is unblocked, and it
        //  is best-effort — a failed send never fails the person's creation.
        //  Always from no_reply@tatvaos.com, regardless of the platform default.
        // ------------------------------------------------------------------
        if (mailbox is not null)
        {
            var orgName = await db.Tenants.AsNoTracking()
                .Where(t => t.Id == tenant.TenantId)
                .Select(t => t.Name)
                .FirstOrDefaultAsync(ct) ?? "your organisation";
            var baseUrl = config["Jwt:Issuer"] ?? "https://core.tatvaos.com";

            await mailer.SendHtmlAsync(
                user.Email,
                WelcomeEmail.Subject(orgName),
                WelcomeEmail.Html(user.DisplayName, orgName, baseUrl, mailbox.Address),
                from: "no_reply@tatvaos.com",
                ct: ct);
        }

        // The generated password is returned once and never stored in
        // recoverable form. Losing it means a reset, which is the correct
        // trade — a retrievable password is a stored plaintext password.
        return Results.Created($"/api/org/users/{user.Id}", new
        {
            user.Id,
            user.Email,
            mailboxAddress = mailbox?.Address,
            quotaBytes = mailbox?.QuotaBytes,
            products,
            temporaryPassword = req.Password is null ? password : null,
            note = "The user must change this on first sign-in.",
        });
    }

    /// <summary>
    /// Edit a person: name, department, role, mailbox quota.
    ///
    /// Email is deliberately NOT editable here. It is the sign-in identity and
    /// usually the mailbox address; renaming it is an aliasing operation with
    /// mail-routing consequences, not a form field. That gets its own flow.
    /// </summary>
    private static async Task<IResult> UpdateAsync(
        Guid id, UpdateUserRequest req,
        AppDbContext db, StorageAllocator storage, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        if (GuardActOn(tenant, user) is IResult denied) return denied;

        var before = new { user.DisplayName, user.DepartmentId, user.Role };

        if (!string.IsNullOrWhiteSpace(req.DisplayName))
            user.DisplayName = req.DisplayName.Trim();

        if (req.DepartmentId is Guid did)
        {
            if (did == Guid.Empty)
            {
                user.DepartmentId = null;
            }
            else
            {
                // Validated inside the tenant — the global filter scopes this
                // query, so another tenant's department id lands here as null.
                var dept = await db.Departments.FirstOrDefaultAsync(d => d.Id == did, ct);
                if (dept is null)
                    return Results.BadRequest(new { error = "Unknown department." });
                user.DepartmentId = dept.Id;
            }
        }

        if (!string.IsNullOrWhiteSpace(req.Role))
        {
            // Nobody edits their own role — not even to something lower. The
            // UI disables the field, but the SERVER is the rule: without this
            // line an org_admin promotes themselves to owner with one curl.
            if (user.Id == tenant.UserId)
                return Results.BadRequest(new
                {
                    error = "You cannot change your own role. Ask another owner or admin.",
                });

            var role = req.Role.Trim().ToLowerInvariant();
            if (!AssignableRoles.Contains(role))
                return Results.BadRequest(new { error = "Unknown role." });

            // Making an owner is the one promotion an admin cannot perform —
            // it is the same power as being one.
            if (role == "org_owner" && user.Role != "org_owner" && !IsOwnerScope(tenant))
                return Results.Json(new
                {
                    error = "Only an organisation owner can promote someone to owner.",
                }, statusCode: 403);

            // An organisation must always have at least one owner. Without
            // this, demoting the last one locks the whole tenant out of its
            // own administration — recoverable only by a support ticket.
            if (user.Role == "org_owner" && role != "org_owner")
            {
                var otherOwners = await db.Users.CountAsync(
                    u => u.Role == "org_owner" && u.Id != user.Id && u.Status != "deleted", ct);
                if (otherOwners == 0)
                    return Results.BadRequest(new
                    {
                        error = "This is the organisation's only owner. Make someone else " +
                                "an owner first, then change this role.",
                    });
            }

            user.Role = role;
        }

        // The allowance is the PERSON's, across every product — mail, files,
        // and whatever ships next. It used to be written onto the mailbox,
        // which is why "you have 30 GB" was only ever true of email.
        //
        // A Payroll-only user with no mailbox still gets one: they will have
        // files, and the number has to mean something before the product they
        // use exists.
        long? newQuota = null;
        if (req.QuotaBytes is long q && q > 0)
        {
            // Never below what is already stored. An allowance under current
            // usage refuses everything the moment it is saved — incoming mail
            // included — which an admin adjusting a number almost never means.
            var usedRows = await db.Database
                .SqlQuery<long>($"SELECT COALESCE(SUM(used_bytes),0)::bigint AS \"Value\" FROM core.user_storage_usage({id})")
                .ToListAsync(ct);
            var used = usedRows.FirstOrDefault();

            user.StorageQuotaBytes = Math.Max(q, used);
            newQuota = user.StorageQuotaBytes;

            // The mailbox quota column is kept in step so the mail edge, which
            // reads mailboxes directly and knows nothing about core.users,
            // does not enforce a stale smaller number.
            var mailboxes = await db.Mailboxes.Where(m => m.UserId == id).ToListAsync(ct);
            foreach (var mb in mailboxes) mb.QuotaBytes = user.StorageQuotaBytes.Value;
        }

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.updated", "user", user.Id.ToString(),
            before: before,
            after: new { user.DisplayName, user.DepartmentId, user.Role, quotaBytes = newQuota },
            ct: ct);

        return Results.Ok(new
        {
            user.Id, user.Email, user.DisplayName, user.DepartmentId, user.Role,
            quotaBytes = newQuota,
        });
    }

    /// <summary>
    /// Bulk creation.
    ///
    /// A school onboarding 200 students one at a time is the point at which an
    /// admin abandons the product. Partial success is reported per row rather
    /// than failing the batch — one duplicate address should not discard 199
    /// good rows.
    /// </summary>
    private static async Task<IResult> BulkCreateAsync(
        BulkCreateUserRequest req,
        AppDbContext db, StorageAllocator storage, TenantContext tenant,
        AuditWriter audit, IPasswordHasher hasher,
        IServiceScopeFactory scopeFactory, IConfiguration config, CancellationToken ct)
    {
        if (req.Users is null || req.Users.Count == 0)
            return Results.BadRequest(new { error = "No rows to import." });
        var capacity = await storage.GetCapacityAsync(tenant.TenantId, "mail", ct);
        if (!capacity.CanAddUser)
            return Results.BadRequest(new { error = capacity.Reason });
        if (capacity.MaxUsers is int max && capacity.UserCount + req.Users.Count > max)
            return Results.BadRequest(new
            {
                error = $"Creating {req.Users.Count} users would exceed the limit of {max}. " +
                        $"Currently {capacity.UserCount}.",
            });
        var domain = await db.Domains.FirstOrDefaultAsync(d => d.Id == req.DomainId, ct);
        if (domain is null || domain.OwnershipVerifiedAt is null)
            return Results.BadRequest(new { error = "Domain is unknown or not verified." });

        // Every department once, so a row can name its own ("Class 5A") and
        // be matched by name, case-insensitively. Two departments sharing a
        // name make it ambiguous: the row is skipped and says so, rather than
        // guessing which one a spreadsheet meant.
        var departments = await db.Departments.ToListAsync(ct);
        var byName = departments
            .GroupBy(d => d.Name.Trim(), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);
        var defaultDept = req.DepartmentId is Guid cid
            ? departments.FirstOrDefault(c => c.Id == cid)
            : null;
        if (req.DepartmentId is not null && defaultDept is null)
            return Results.BadRequest(new { error = "Department is unknown." });

        var created = new List<object>();
        var skipped = new List<object>();
        // (address, name) for each new person who got a mailbox — the welcome
        // emails are sent AFTER the response, in the background, because 200
        // synchronous SMTP sends would turn a fast bulk import into a timeout.
        var welcomes = new List<(string Email, string Name)>();
        // Addresses claimed by an earlier row of THIS batch: the database
        // check below cannot see rows that are not saved yet.
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in req.Users)
        {
            var localPart = (entry.LocalPart ?? string.Empty).Trim().ToLowerInvariant();
            var displayName = (entry.DisplayName ?? string.Empty).Trim();
            var address = $"{localPart}@{domain.Fqdn}";
            if (!IsValidLocalPart(localPart))
            {
                skipped.Add(new { address, displayName, reason = "invalid local part" });
                continue;
            }
            if (displayName.Length < 2)
            {
                skipped.Add(new { address, displayName, reason = "name is missing" });
                continue;
            }
            if (!seen.Add(address))
            {
                skipped.Add(new { address, displayName, reason = "repeated in this batch" });
                continue;
            }
            var dept = defaultDept;
            var deptName = entry.Department?.Trim();
            if (!string.IsNullOrEmpty(deptName))
            {
                if (!byName.TryGetValue(deptName, out var matches))
                {
                    skipped.Add(new { address, displayName, reason = $"unknown department '{deptName}'" });
                    continue;
                }
                if (matches.Count > 1)
                {
                    skipped.Add(new
                    {
                        address, displayName,
                        reason = $"'{deptName}' names {matches.Count} departments — rename one, or leave the column blank and pick it above",
                    });
                    continue;
                }
                dept = matches[0];
            }
            if (await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Email == address, ct) ||
                await db.Mailboxes.IgnoreQueryFilters().AnyAsync(m => m.Address == address, ct))
            {
                skipped.Add(new { address, displayName, reason = "already exists" });
                continue;
            }
            var products = dept?.DefaultProducts ?? ["mail"];
            var wantsMailbox = products.Contains("mail");
            if (req.DryRun)
            {
                created.Add(new { email = address, displayName, department = dept?.Name, mailbox = wantsMailbox });
                continue;
            }
            var quota = await storage.ResolveQuotaAsync(
                tenant.TenantId, dept?.Id, null, "mail", ct);
            var password = PasswordGenerator.Generate();
            var user = new User
            {
                TenantId = tenant.TenantId,
                DomainId = domain.Id,
                Email = address,
                DisplayName = displayName,
                DepartmentId = dept?.Id,
                Role = dept?.DefaultRole ?? "employee",
                Status = "pending",
                PasswordHash = hasher.Hash(password),
            };
            db.Users.Add(user);
            foreach (var code in products.Distinct())
                db.ProductAccess.Add(new ProductAccess
                {
                    TenantId = tenant.TenantId,
                    UserId = user.Id,
                    ProductCode = code,
                });
            if (wantsMailbox)
            {
                db.Mailboxes.Add(new Mailbox
                {
                    TenantId = tenant.TenantId,
                    DomainId = domain.Id,
                    UserId = user.Id,
                    Address = address,
                    LocalPart = localPart,
                    Type = "user",
                    ImapPasswordHash = hasher.Hash(password),
                    QuotaBytes = quota,
                });
                welcomes.Add((address, displayName));
            }
            created.Add(new { email = address, displayName, department = dept?.Name, temporaryPassword = password });
        }
        // A dry run reports and stops: no save, no audit row, no mail.
        if (req.DryRun)
            return Results.Ok(new { dryRun = true, created, skipped });

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.bulk_created", "user", null,
            after: new { count = created.Count, skipped = skipped.Count }, ct: ct);
        // Fire the welcome emails after the response, on a fresh DI scope (the
        // request's is disposed the moment we return). Best-effort: a school
        // importing 200 students gets its list instantly, and the inboxes fill
        // over the next few seconds without the admin waiting on SMTP.
        if (welcomes.Count > 0)
        {
            var orgName = await db.Tenants.AsNoTracking()
                .Where(t => t.Id == tenant.TenantId).Select(t => t.Name)
                .FirstOrDefaultAsync(ct) ?? "your organisation";
            var baseUrl = config["Jwt:Issuer"] ?? "https://core.tatvaos.com";
            SendWelcomesInBackground(scopeFactory, welcomes, orgName, baseUrl);
        }
        return Results.Ok(new { dryRun = false, created, skipped });
    }

    /// <summary>
    /// Sends a batch of welcome emails on a background task with its own scope,
    /// so it outlives the request. Every failure is swallowed per-recipient —
    /// one undeliverable address must not stop the other 199, and a welcome
    /// that does not arrive is never worth surfacing an error for.
    /// </summary>
    private static void SendWelcomesInBackground(
        IServiceScopeFactory scopeFactory,
        IReadOnlyList<(string Email, string Name)> welcomes,
        string orgName, string baseUrl)
    {
        _ = Task.Run(async () =>
        {
            using var scope = scopeFactory.CreateScope();
            var mailer = scope.ServiceProvider.GetRequiredService<SystemMailer>();
            var subject = WelcomeEmail.Subject(orgName);
            foreach (var (email, name) in welcomes)
            {
                try
                {
                    await mailer.SendHtmlAsync(
                        email, subject, WelcomeEmail.Html(name, orgName, baseUrl, email),
                        from: "no_reply@tatvaos.com");
                }
                catch
                {
                    // Best-effort: intentionally swallowed so one bad address
                    // cannot break the batch or leak an unobserved exception.
                }
            }
        });
    }

    /// <summary>
    /// Suspend a person — every product at once.
    ///
    /// This is the payoff for putting identity in Core. One action stops them
    /// signing in, stops IMAP, and stops Drive and Payroll the day those ship.
    /// The mailbox is deactivated but NOT deleted: mail addressed to it is
    /// rejected at SMTP time so the sender knows immediately, while the stored
    /// mail is retained for whatever legal window applies.
    /// </summary>

    /// <summary>
    /// Offboarding: everything that leaving means, as ONE action.
    ///
    /// Before this existed, removing a leaver was four separate steps —
    /// suspend, deactivate the mailbox, revoke access, remember to do
    /// something about their address — and missing any one left either live
    /// access or a black hole that bounces mail from customers who only know
    /// the leaver's address. This endpoint is those steps in one transaction,
    /// plus the piece none of them covered: FORWARDING.
    ///
    /// Forwarding is an alias row, which is what makes it real rather than
    /// cosmetic: Postfix resolves recipients through mail.aliases, so mail to
    /// the leaver's address — from colleagues AND from the outside world — is
    /// delivered into the successor's mailbox from the moment this commits.
    /// The leaver's own stored mail stays retained in their deactivated
    /// mailbox, exactly as plain deletion leaves it.
    /// </summary>
    private static async Task<IResult> OffboardAsync(
        Guid id, OffboardRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        if (user.Id == tenant.UserId)
            return Results.BadRequest(new { error = "You cannot offboard your own account." });

        if (GuardActOn(tenant, user) is IResult denied) return denied;

        if (await WouldRemoveLastOwnerAsync(db, user, ct))
            return Results.BadRequest(new
            {
                error = "This is the organisation's only active owner. " +
                        "Make someone else an owner first.",
            });

        // Resolve the successor BEFORE changing anything, so a bad request
        // leaves the leaver untouched rather than half-offboarded.
        Mailbox? successorBox = null;
        if (req.ForwardToUserId is Guid successorId)
        {
            if (successorId == id)
                return Results.BadRequest(new { error = "Mail cannot be forwarded to the person who is leaving." });

            var successorActive = await db.Users.AsNoTracking()
                .AnyAsync(u => u.Id == successorId && u.Status == "active", ct);
            successorBox = await db.Mailboxes
                .FirstOrDefaultAsync(m => m.UserId == successorId && m.IsActive, ct);

            if (!successorActive || successorBox is null)
                return Results.BadRequest(new
                {
                    error = "The person to forward mail to needs an active account with a mailbox.",
                });
        }

        user.Status = "deleted";

        var mailboxes = await db.Mailboxes.Where(m => m.UserId == id).ToListAsync(ct);
        foreach (var mb in mailboxes) mb.IsActive = false;

        await db.ProductAccess
            .Where(p => p.UserId == id && p.RevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(p => p.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow), ct);

        var forwarded = new List<string>();
        if (successorBox is not null)
        {
            foreach (var mb in mailboxes)
            {
                // One alias per address the leaver held. Idempotent: a repeat
                // offboard call must not stack duplicate alias rows.
                var exists = await db.Aliases
                    .AnyAsync(a => a.Address == mb.Address && a.IsActive, ct);
                if (exists) continue;

                db.Aliases.Add(new Alias
                {
                    TenantId = user.TenantId,
                    DomainId = mb.DomainId,
                    TargetMailboxId = successorBox.Id,
                    Address = mb.Address,
                });
                forwarded.Add(mb.Address);
            }
        }

        await db.SaveChangesAsync(ct);
        await RevokeSessionsAsync(db, id, "account offboarded", ct);
        await audit.WriteAsync("user.offboarded", "user", id.ToString(),
            before: new { user.Email, user.Role },
            after: new
            {
                mailboxesDeactivated = mailboxes.Count,
                forwardedTo = req.ForwardToUserId,
                forwardedAddresses = forwarded,
            }, ct: ct);

        return Results.Ok(new
        {
            user.Id,
            user.Status,
            mailboxesDeactivated = mailboxes.Count,
            forwardedAddresses = forwarded,
            note = forwarded.Count > 0
                ? "Sign-in and access are closed. Mail to their address now reaches the person you chose; their own stored mail is retained."
                : "Sign-in and access are closed. Their stored mail is retained; mail to their address will bounce.",
        });
    }

    private static async Task<IResult> SuspendAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        // Suspending yourself ends with nobody signed in and an account only
        // someone else can revive. If it is ever the right move, it is a move
        // for a colleague to make.
        if (user.Id == tenant.UserId)
            return Results.BadRequest(new { error = "You cannot suspend your own account." });

        if (GuardActOn(tenant, user) is IResult denied) return denied;

        if (await WouldRemoveLastOwnerAsync(db, user, ct))
            return Results.BadRequest(new
            {
                error = "This is the organisation's only active owner. " +
                        "Make someone else an owner first.",
            });

        user.Status = "suspended";

        var mailboxes = await db.Mailboxes.Where(m => m.UserId == id).ToListAsync(ct);
        foreach (var mb in mailboxes) mb.IsActive = false;

        await db.SaveChangesAsync(ct);
        await RevokeSessionsAsync(db, id, "account suspended", ct);
        await audit.WriteAsync("user.suspended", "user", id.ToString(),
            after: new { mailboxesDeactivated = mailboxes.Count }, ct: ct);

        return Results.Ok(new { user.Id, user.Status, mailboxesDeactivated = mailboxes.Count });
    }

    private static async Task<IResult> ReactivateAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        if (GuardActOn(tenant, user) is IResult denied) return denied;

        if (user.Status == "deleted")
            return Results.BadRequest(new
            {
                error = "This account was deleted. Create the person again instead.",
            });

        user.Status = "active";
        var mailboxes = await db.Mailboxes.Where(m => m.UserId == id).ToListAsync(ct);
        foreach (var mb in mailboxes) mb.IsActive = true;

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.reactivated", "user", id.ToString(), ct: ct);

        return Results.Ok(new { user.Id, user.Status });
    }

    /// <summary>
    /// Soft delete. The row keeps its id and its audit history; the mailbox is
    /// deactivated but its stored mail is retained — the legal-retention
    /// window belongs to the organisation, not to the person who left. What
    /// deletion means here is: cannot sign in, receives no mail, occupies no
    /// seat, and the address shows as deleted rather than vanishing from the
    /// admin's view of history.
    /// </summary>
    private static async Task<IResult> DeleteAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        if (user.Id == tenant.UserId)
            return Results.BadRequest(new { error = "You cannot delete your own account." });

        if (GuardActOn(tenant, user) is IResult denied) return denied;

        if (await WouldRemoveLastOwnerAsync(db, user, ct))
            return Results.BadRequest(new
            {
                error = "This is the organisation's only active owner. " +
                        "Make someone else an owner first.",
            });

        user.Status = "deleted";

        var mailboxes = await db.Mailboxes.Where(m => m.UserId == id).ToListAsync(ct);
        foreach (var mb in mailboxes) mb.IsActive = false;

        // Product access is revoked rather than deleted, for the same reason
        // the user row survives: "who could reach what, when" must remain
        // answerable after the person is gone.
        await db.ProductAccess
            .Where(p => p.UserId == id && p.RevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(p => p.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow), ct);

        await db.SaveChangesAsync(ct);
        await RevokeSessionsAsync(db, id, "account deleted", ct);
        await audit.WriteAsync("user.deleted", "user", id.ToString(),
            before: new { user.Email, user.Role }, ct: ct);

        return Results.Ok(new { user.Id, user.Status });
    }

    /// <summary>
    /// Resets the CORE password — the one sign-in that covers every product.
    ///
    /// Deliberately does not touch the mailbox app password. Those are separate
    /// credentials so that revoking a mail client does not lock someone out of
    /// Payroll, and the reverse. Use reset-mailbox-password for that.
    /// </summary>
    private static async Task<IResult> ResetPasswordAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit,
        IPasswordHasher hasher, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        // Your own password changes through /auth/change-password, which
        // demands the current one. An admin resetting THEMSELVES through this
        // endpoint would be a way to skip that check.
        if (user.Id == tenant.UserId)
            return Results.BadRequest(new
            {
                error = "Change your own password from your account page.",
            });

        // The takeover guard. Reset a password, sign in as its owner: those
        // are the same power, so it follows the same hierarchy as suspension.
        if (GuardActOn(tenant, user) is IResult denied) return denied;

        var password = PasswordGenerator.Generate();
        user.PasswordHash = hasher.Hash(password);
        // A password the admin has seen is a handover credential, exactly as
        // at creation — it must not survive first sign-in.
        user.MustChangePassword = true;
        await db.SaveChangesAsync(ct);

        // Whoever held the old password may hold a session. End them all.
        await RevokeSessionsAsync(db, id, "password reset by admin", ct);

        // Audited because it is a common step in an account takeover. The
        // record is what makes that detectable afterwards.
        await audit.WriteAsync("user.password_reset", "user", id.ToString(), ct: ct);

        return Results.Ok(new
        {
            user.Id,
            temporaryPassword = password,
            note = "They must change it on first sign-in. All their sessions have been signed out.",
        });
    }

    /// <summary>
    /// Resets the MAILBOX password — the credential mail apps (Outlook,
    /// phones, IMAP/SMTP) sign in with. This is neither the core password
    /// (reset-password above) nor an "app password": app passwords live in
    /// their own store and people manage those themselves from mail
    /// settings. The route was named reset-app-password until September
    /// 2026; the wrong name sent an admin to the wrong reset during a live
    /// diagnosis — names are part of the interface.
    /// </summary>
    private static async Task<IResult> ResetMailboxPasswordAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit, IPasswordHasher hasher, CancellationToken ct)
    {
        // Fetch the user to authorize the action
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        // Prevent admin from resetting their own mailbox password through this
        // endpoint (they should use account settings instead).
        if (user.Id == tenant.UserId)
            return Results.BadRequest(new { error = "Reset your own mailbox password from your account page." });

        // The privilege guard: admin can only reset a mailbox password for users
        // they have authority over (same organisation, appropriate role).
        if (GuardActOn(tenant, user) is IResult denied) return denied;

        var mailboxes = await db.Mailboxes.Where(m => m.UserId == id).ToListAsync(ct);
        if (mailboxes.Count == 0) return Results.NotFound(new { error = "No mailbox for this user." });

        var password = PasswordGenerator.Generate();
        foreach (var mb in mailboxes) mb.ImapPasswordHash = hasher.Hash(password);
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("mailbox.password_reset", "user", id.ToString(), ct: ct);

        return Results.Ok(new
        {
            userId = id,
            temporaryPassword = password,
            note = "Existing mail clients will stop working until reconfigured.",
        });
    }

    // ------------------------------------------------------------------
    //  Profile photo
    // ------------------------------------------------------------------

    private const int MaxAvatarBytes = 2 * 1024 * 1024; // 2 MB decoded

    // You may change a photo if it is YOUR OWN, or if you administer this org.
    // The account page relies on the first half; Add Person on the second.
    private static bool MayManageAvatar(TenantContext tenant, Guid targetUserId) =>
        tenant.UserId == targetUserId ||
        tenant.Role is "org_owner" or "org_admin" or "super_admin";

    private static async Task<IResult> AvatarAsync(Guid id, AppDbContext db, CancellationToken ct)
    {
        var a = await db.UserAvatars.AsNoTracking()
            .Where(x => x.UserId == id)
            .Select(x => new { x.Image, x.Mime })
            .FirstOrDefaultAsync(ct);
        return a is null ? Results.NotFound() : Results.File(a.Image, a.Mime);
    }

    private static async Task<IResult> SetAvatarAsync(
        Guid id, SetAvatarRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        if (!MayManageAvatar(tenant, id))
            return Results.Json(new { error = "You can only change your own photo." }, statusCode: 403);

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        if (!TryParseImageDataUrl(req.DataUrl, out var mime, out var bytes))
            return Results.BadRequest(new { error = "Expected an image data URL, e.g. data:image/jpeg;base64,…" });
        if (bytes.Length > MaxAvatarBytes)
            return Results.BadRequest(new { error = "That image is too large. Crop it or choose a smaller one (max 2 MB)." });

        var existing = await db.UserAvatars.FirstOrDefaultAsync(a => a.UserId == id, ct);
        if (existing is null)
        {
            db.UserAvatars.Add(new UserAvatar
            {
                UserId = id, TenantId = user.TenantId, Image = bytes, Mime = mime,
            });
        }
        else
        {
            existing.Image = bytes;
            existing.Mime = mime;
            existing.UpdatedAt = DateTimeOffset.UtcNow;
        }

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.avatar_set", "user", id.ToString(), ct: ct);
        return Results.Ok(new { userId = id, hasAvatar = true });
    }

    private static async Task<IResult> DeleteAvatarAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (!MayManageAvatar(tenant, id))
            return Results.Json(new { error = "You can only change your own photo." }, statusCode: 403);

        var a = await db.UserAvatars.FirstOrDefaultAsync(x => x.UserId == id, ct);
        if (a is null) return Results.NotFound();
        db.UserAvatars.Remove(a);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.avatar_removed", "user", id.ToString(), ct: ct);
        return Results.Ok(new { userId = id, hasAvatar = false });
    }

    /// <summary>
    /// Parses "data:image/xxx;base64,DATA" into a validated image type and its
    /// bytes. Rejects anything that is not one of a small set of image types —
    /// storing an arbitrary blob a browser will later render is how a stored
    /// XSS or an SVG-with-script gets in, so SVG is deliberately excluded.
    /// </summary>
    private static bool TryParseImageDataUrl(string dataUrl, out string mime, out byte[] bytes)
    {
        mime = "";
        bytes = [];
        if (string.IsNullOrWhiteSpace(dataUrl) ||
            !dataUrl.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            return false;

        var comma = dataUrl.IndexOf(',');
        if (comma < 0) return false;

        var header = dataUrl[5..comma];
        if (!header.Contains("base64", StringComparison.OrdinalIgnoreCase)) return false;

        var m = header.Split(';')[0].Trim().ToLowerInvariant();
        string[] allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
        if (!allowed.Contains(m)) return false;

        try { bytes = Convert.FromBase64String(dataUrl[(comma + 1)..]); }
        catch { return false; }
        if (bytes.Length == 0) return false;

        mime = m;
        return true;
    }

    // ------------------------------------------------------------------

    private static bool IsValidLocalPart(string local) =>
        local.Length is > 0 and <= 64 &&
        System.Text.RegularExpressions.Regex.IsMatch(local, @"^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$");
}
