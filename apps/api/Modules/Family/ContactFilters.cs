using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Family;

/// <summary>
/// The filter that every list-shaped route shares.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THIS EXISTS BECAUSE THREE ROUTES HAVE TO AGREE ABOUT WHAT "MATCHING"
///  MEANS, AND ONE OF THEM NOW WRITES.
///
///  Listing and exporting had their own copies of these four clauses, which
///  was harmless while both only read. Bulk labelling changes that: the UI
///  says "select all 1,499 matching this filter" and then asks the server to
///  label them. If the bulk route's idea of the filter drifts from the list
///  route's by even one clause, somebody labels a set of contacts they were
///  never shown — and finds out much later.
///
///  So there is one definition, and the promise the button makes is a promise
///  the same code keeps.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Deliberately does NOT handle the search term. Search runs through the
/// full-text vector on a different path, and "everything matching" a free-text
/// query is a promise this cannot keep — the client hides that option while a
/// search is active.
/// </summary>
public static class ContactFilters
{
    public static IQueryable<Contact> Apply(
        AppDbContext db,
        IQueryable<Contact> q,
        string? ownership,
        Guid? groupId,
        bool? favourite,
        string? source)
    {
        if (ownership is "personal" or "organisational")
            q = q.Where(c => c.OwnershipType == ownership);

        if (favourite == true)
            q = q.Where(c => c.IsFavourite);

        // "auto" is the whole family of auto_* sources rather than one value:
        // the client's question is "what did mail decide to save", not which
        // particular flavour of mail event produced it.
        if (source == "auto")
            q = q.Where(c => c.Source == "auto_received"
                          || c.Source == "auto_sent"
                          || c.Source == "auto_reply");
        else if (source == "manual")
            q = q.Where(c => c.Source == "manual" || c.Source == "import" || c.Source == "api");

        if (groupId is Guid gid)
            q = q.Where(c => db.ContactGroupMembers
                .Any(m => m.GroupId == gid && m.ContactId == c.Id));

        return q;
    }
}
