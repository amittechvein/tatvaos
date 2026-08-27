# For Core — three lines in `AppDbContext.cs`, for mail categories

`mail.categories` is a new table (migration `0032-mail-categories.sql`).
Registering it needs `Shared/Data/AppDbContext.cs`, which is yours under §5a
rule 3, so this is an ask rather than an edit.

Everything else is done: the migration, the `MailCategory` entity, the
`Message.CategoryId` column, and `MailFilters.Actions.CategoryId`. The
endpoints follow once these three lines exist — they will not compile until
then, so I have not written them yet.

Beside `FilterRules` (line ~79):

```csharp
public DbSet<MailCategory> MailCategories => Set<MailCategory>();
```

Beside the other mail tables (line ~180):

```csharp
b.Entity<MailCategory>().ToTable("categories", "mail");
```

Beside the other filters (line ~350):

```csharp
b.Entity<MailCategory>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
```

The query filter is the one that matters. Without it a category list would be
cross-tenant, and `mail.categories` carries RLS in the migration precisely so
that a mistake here is caught by the database rather than served to a customer.

No relationship is configured deliberately. `Message.CategoryId` is a bare
`Guid?` rather than a navigation property: the foreign key lives in the schema
with `ON DELETE SET NULL`, and a navigation would invite an `Include` that
loads a category for every row in a folder listing.
