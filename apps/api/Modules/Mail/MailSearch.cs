using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// The search box, as a grammar rather than a list of fields.
///
/// ═════════════════════════════════════════════════════════════════════════
///  WHY THIS REPLACED MailQuery (Amit, 23 September 2026)
///
///  The old parser read a flat bag of conditions: every operator was ANDed,
///  there was no OR, no negation and no grouping, so "invoice OR receipt"
///  searched for the word OR. Amit asked for Gmail's behaviour, and Gmail's
///  behaviour is a LANGUAGE — the operators are the easy half, the hard half
///  is that they compose:
///
///      from:accounts@x.com (invoice OR receipt) newer_than:30d -paid
///
///  So this parses to a tree and turns the tree into one predicate. Adding an
///  operator is then a case label, not a new field threaded through a record.
///
///  ── PRECEDENCE, WHICH GMAIL DOES NOT DOCUMENT AND PEOPLE RELY ON ────────
///
///  OR binds TIGHTER than the space between terms. "a OR b c" is (a OR b)
///  AND c, not a OR (b AND c). Getting this backwards silently widens every
///  query somebody writes, and a search that returns too much reads as a
///  search that is broken.
///
///  ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────
///
///  Gmail operators with nothing behind them in TatvaOS are NOT accepted as
///  no-ops: has:drive, has:document, has:spreadsheet, has:presentation,
///  has:youtube, category:promotions and the rest of Gmail's tabs, coloured
///  stars, is:important, is:muted, in:snoozed, in:archive (this product has
///  no archive folder). An operator that parses and then quietly matches
///  everything is worse than one that does not exist, because the results
///  look authoritative. They fall through to free text, same as any other
///  unknown word — see the note on unknown operators below.
///
///  header:, list: and deliveredto: are absent for a harder reason: the
///  mail.messages.headers jsonb column EXISTS but nothing ever writes it
///  (checked 23 Sept 2026 — ingest reads MIME headers and drops them). Those
///  three would have parsed, run, and matched nothing at all. They need the
///  ingest worker to store headers first, and even then could only answer
///  for mail received after that ships.
///
///  ── AN UNKNOWN OPERATOR IS TEXT, NEVER A DROPPED CONDITION ──────────────
///
///  Inherited from MailQuery and still the rule: "ratio:2" means it
///  literally. Silently discarding half of what somebody typed while
///  returning confident-looking results is the worst thing a search box can
///  do.
/// ═════════════════════════════════════════════════════════════════════════
/// </summary>
public static class MailSearch
{
    // ── What the caller has to resolve before a query can be built ────────
    /// <param name="SelfAddress">For from:me / to:me.</param>
    /// <param name="FolderIdsBySpecialUse">'\Inbox' → the ids in this mailbox.</param>
    /// <param name="CategoryIdsByName">Lower-cased category name → id, for label:.</param>
    /// <param name="Attachments">Scoped attachment rows, for filename:.</param>
    public sealed record Context(
        string SelfAddress,
        IReadOnlyDictionary<string, Guid[]> FolderIdsBySpecialUse,
        IReadOnlyDictionary<string, Guid> CategoryIdsByName,
        IQueryable<Attachment> Attachments);

    // ── The tree ──────────────────────────────────────────────────────────
    public abstract record Node;
    public sealed record AndNode(IReadOnlyList<Node> Parts) : Node;
    public sealed record OrNode(IReadOnlyList<Node> Parts) : Node;
    public sealed record NotNode(Node Part) : Node;
    /// <param name="Field">"" for free text, otherwise the operator name.</param>
    public sealed record TermNode(string Field, string Value, bool Phrase = false) : Node;

    // =====================================================================
    //  Tokenising
    // =====================================================================
    private sealed record Token(string Text, bool Quoted);

    /// <summary>
    /// Splits on whitespace, keeps "quoted phrases" whole (including after an
    /// operator, so subject:"q3 report" is one condition), and makes the
    /// grouping characters their own tokens so the parser can see them.
    /// </summary>
    private static List<Token> Tokenise(string q)
    {
        var tokens = new List<Token>();
        var current = new System.Text.StringBuilder();
        var quotedRun = false;
        var inQuotes = false;

        void Flush()
        {
            if (current.Length == 0 && !quotedRun) return;
            tokens.Add(new Token(current.ToString(), quotedRun));
            current.Clear();
            quotedRun = false;
        }

        foreach (var ch in q)
        {
            if (ch == '"') { inQuotes = !inQuotes; if (inQuotes) quotedRun = true; continue; }
            if (inQuotes) { current.Append(ch); continue; }

            if (char.IsWhiteSpace(ch)) { Flush(); continue; }

            // Grouping punctuation is structure, not text — but only OUTSIDE a
            // quoted run and only when it is not glued to an operator value
            // (from:(a OR b) keeps its bracket as a token, which is what lets
            // the field carry a group).
            if (ch is '(' or ')' or '{' or '}')
            {
                Flush();
                tokens.Add(new Token(ch.ToString(), false));
                continue;
            }

            current.Append(ch);
        }
        Flush();
        return tokens;
    }

    // =====================================================================
    //  Parsing — recursive descent over the token list
    // =====================================================================
    private sealed class Cursor(List<Token> tokens)
    {
        private int _i;
        public bool Done => _i >= tokens.Count;
        public Token Peek => tokens[_i];
        public Token Next() => tokens[_i++];
    }

    public static Node Parse(string? q)
    {
        var cursor = new Cursor(Tokenise(q ?? string.Empty));
        var node = ParseSequence(cursor, stopAt: null);
        return node;
    }

    /// <summary>A run of factors. Whitespace between them means AND.</summary>
    private static Node ParseSequence(Cursor c, string? stopAt)
    {
        var parts = new List<Node>();

        while (!c.Done)
        {
            if (stopAt is not null && !c.Peek.Quoted && c.Peek.Text == stopAt) { c.Next(); break; }
            if (!c.Peek.Quoted && (c.Peek.Text == ")" || c.Peek.Text == "}")) { c.Next(); break; }

            var factor = ParseOr(c, stopAt);
            if (factor is not null) parts.Add(factor);
        }

        return parts.Count == 1 ? parts[0] : new AndNode(parts);
    }

    /// <summary>
    /// One factor, plus any OR chain hanging off it. OR binds tighter than
    /// the implicit AND — see the class note.
    /// </summary>
    private static Node? ParseOr(Cursor c, string? stopAt)
    {
        var left = ParseFactor(c);
        if (left is null) return null;

        while (!c.Done && !c.Peek.Quoted
               && (c.Peek.Text.Equals("OR", StringComparison.OrdinalIgnoreCase) || c.Peek.Text == "|"))
        {
            c.Next();
            var right = ParseFactor(c);
            if (right is null) break;
            left = left is OrNode existing
                ? new OrNode([.. existing.Parts, right])
                : new OrNode([left, right]);
        }

        return left;
    }

    private static Node? ParseFactor(Cursor c)
    {
        if (c.Done) return null;
        var token = c.Next();

        if (!token.Quoted)
        {
            // A bare AND is punctuation: the space already means AND.
            if (token.Text.Equals("AND", StringComparison.OrdinalIgnoreCase)) return ParseFactor(c);

            if (token.Text == "(") return ParseSequence(c, stopAt: ")");
            // Braces are Gmail's OR group: {from:a from:b} is a OR b.
            if (token.Text == "{")
            {
                var inner = ParseSequence(c, stopAt: "}");
                return inner is AndNode and2 ? new OrNode(and2.Parts) : inner;
            }
            if (token.Text is ")" or "}") return null;

            if (token.Text.StartsWith('-') && token.Text.Length > 1)
                return new NotNode(TermFrom(token with { Text = token.Text[1..] }, c));
        }

        return TermFrom(token, c);
    }

    /// <summary>
    /// A token becomes a term. `field:(a OR b)` and `field:(a b)` are handled
    /// here by parsing the group and stamping the field onto every leaf — that
    /// is what makes subject:(invoice payment) mean two subject conditions
    /// rather than a subject and a stray word.
    /// </summary>
    private static Node TermFrom(Token token, Cursor c)
    {
        var text = token.Text;
        var colon = token.Quoted ? -1 : text.IndexOf(':');

        // No colon, or nothing usable around it: free text. "12:30" stays text.
        if (colon <= 0) return new TermNode(string.Empty, text, token.Quoted);

        var field = text[..colon].ToLowerInvariant();
        var value = text[(colon + 1)..];

        if (value.Length == 0 && !c.Done && !c.Peek.Quoted && c.Peek.Text == "(")
        {
            c.Next();
            var group = ParseSequence(c, stopAt: ")");
            return StampField(group, field);
        }

        return new TermNode(field, value, token.Quoted);
    }

    private static Node StampField(Node node, string field) => node switch
    {
        AndNode a => new AndNode([.. a.Parts.Select(p => StampField(p, field))]),
        OrNode o => new OrNode([.. o.Parts.Select(p => StampField(p, field))]),
        NotNode n => new NotNode(StampField(n.Part, field)),
        TermNode t => t with { Field = string.IsNullOrEmpty(t.Field) ? field : t.Field },
        _ => node,
    };

    // =====================================================================
    //  Turning the tree into one predicate
    // =====================================================================
    /// <param name="hideBin">
    /// True for the CROSS-FOLDER search, where Gmail's behaviour applies:
    /// Trash and Junk stay out unless the query asks for them (Amit's choice,
    /// 23 Sept 2026 — a deleted message surfacing above a live one is the
    /// complaint it prevents).
    ///
    /// FALSE when filtering inside one folder. Somebody standing in Trash and
    /// typing a word is not asking to be shown nothing, and that is exactly
    /// what hiding the bin would do there.
    /// </param>
    public static IQueryable<Message> Apply(
        IQueryable<Message> query, string? q, Context ctx, bool hideBin)
    {
        if (string.IsNullOrWhiteSpace(q)) return hideBin ? ExcludeBin(query, ctx) : query;

        var tree = Parse(q);
        var predicate = Build(tree, ctx);
        if (predicate is not null) query = query.Where(predicate);

        if (!hideBin || MentionsBin(tree)) return query;
        return ExcludeBin(query, ctx);
    }

    private static bool MentionsBin(Node node) => node switch
    {
        AndNode a => a.Parts.Any(MentionsBin),
        OrNode o => o.Parts.Any(MentionsBin),
        NotNode n => MentionsBin(n.Part),
        TermNode { Field: "in" } t =>
            t.Value.ToLowerInvariant() is "trash" or "spam" or "junk" or "anywhere" or "all",
        _ => false,
    };

    private static IQueryable<Message> ExcludeBin(IQueryable<Message> query, Context ctx)
    {
        var binned = Folders(ctx, "\\Trash").Concat(Folders(ctx, "\\Junk")).ToArray();
        return binned.Length == 0 ? query : query.Where(m => !binned.Contains(m.FolderId));
    }

    private static Guid[] Folders(Context ctx, string specialUse) =>
        ctx.FolderIdsBySpecialUse.TryGetValue(specialUse, out var ids) ? ids : [];

    private static Expression<Func<Message, bool>>? Build(Node node, Context ctx)
    {
        switch (node)
        {
            case AndNode a:
            {
                Expression<Func<Message, bool>>? acc = null;
                foreach (var part in a.Parts)
                {
                    var next = Build(part, ctx);
                    if (next is null) continue;
                    acc = acc is null ? next : Combine(acc, next, Expression.AndAlso);
                }
                return acc;
            }
            case OrNode o:
            {
                Expression<Func<Message, bool>>? acc = null;
                foreach (var part in o.Parts)
                {
                    var next = Build(part, ctx);
                    // A branch that cannot be built (an unusable value) must
                    // not silently narrow an OR to its other side.
                    if (next is null) continue;
                    acc = acc is null ? next : Combine(acc, next, Expression.OrElse);
                }
                return acc;
            }
            case NotNode n:
            {
                var inner = Build(n.Part, ctx);
                if (inner is null) return null;
                var p = Expression.Parameter(typeof(Message), "m");
                return Expression.Lambda<Func<Message, bool>>(
                    Expression.Not(Replace(inner.Body, inner.Parameters[0], p)), p);
            }
            case TermNode t:
                return Term(t, ctx);
            default:
                return null;
        }
    }

    private static Expression<Func<Message, bool>> Combine(
        Expression<Func<Message, bool>> left,
        Expression<Func<Message, bool>> right,
        Func<Expression, Expression, BinaryExpression> join)
    {
        var p = Expression.Parameter(typeof(Message), "m");
        var body = join(
            Replace(left.Body, left.Parameters[0], p),
            Replace(right.Body, right.Parameters[0], p));
        return Expression.Lambda<Func<Message, bool>>(body, p);
    }

    private static Expression Replace(Expression body, ParameterExpression from, ParameterExpression to)
        => new ParameterSwap(from, to).Visit(body)!;

    private sealed class ParameterSwap(ParameterExpression from, ParameterExpression to) : ExpressionVisitor
    {
        protected override Expression VisitParameter(ParameterExpression node)
            => node == from ? to : base.VisitParameter(node);
    }

    /// <summary>% and _ are LIKE wildcards; somebody typing them means the characters.</summary>
    private static string Like(string value) =>
        "%" + value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

    // =====================================================================
    //  One term. Every operator TatvaOS can actually answer lives here.
    //
    //  A term that cannot be built returns the FREE TEXT reading of what was
    //  typed rather than null — "after:soon" is a search for the words, not a
    //  silently dropped date filter.
    // =====================================================================
    private static Expression<Func<Message, bool>> Term(TermNode t, Context ctx)
    {
        var raw = t.Field.Length == 0 ? t.Value : $"{t.Field}:{t.Value}";
        var v = t.Value;

        switch (t.Field)
        {
            case "":
                return FreeText(v, t.Phrase);

            // ── who ───────────────────────────────────────────────────────
            case "from":
            {
                if (v.Equals("me", StringComparison.OrdinalIgnoreCase))
                {
                    var self = ctx.SelfAddress.ToLowerInvariant();
                    return m => m.FromAddr != null && m.FromAddr.ToLower() == self;
                }
                var p = Like(v);
                return m => EF.Functions.ILike(m.FromAddr ?? "", p, "\\")
                         || EF.Functions.ILike(m.FromName ?? "", p, "\\");
            }

            // Recipients live in text[]. Containment translates to = ANY and
            // has for years; substring inside an array needs an unnest whose
            // translation is a runtime surprise, so this stays exact — the
            // note MailQuery carried, kept because the reasoning still holds.
            case "to":
            {
                var addr = (v.Equals("me", StringComparison.OrdinalIgnoreCase)
                    ? ctx.SelfAddress : v).ToLowerInvariant();
                return m => m.ToAddrs.Contains(addr)
                         || (m.CcAddrs != null && m.CcAddrs.Contains(addr));
            }
            case "cc":
            {
                var addr = (v.Equals("me", StringComparison.OrdinalIgnoreCase)
                    ? ctx.SelfAddress : v).ToLowerInvariant();
                return m => m.CcAddrs != null && m.CcAddrs.Contains(addr);
            }

            // ── what ──────────────────────────────────────────────────────
            case "subject":
            {
                var p = Like(v);
                return m => EF.Functions.ILike(m.Subject ?? "", p, "\\");
            }
            case "filename":
            {
                var p = Like(v);
                var attachments = ctx.Attachments;
                return m => attachments.Any(a =>
                    a.MessageId == m.Id && EF.Functions.ILike(a.Filename ?? "", p, "\\"));
            }
            case "rfc822msgid":
            {
                var id = v.Trim('<', '>');
                return m => m.MessageIdHeader != null && m.MessageIdHeader.Contains(id);
            }

            // ── state ─────────────────────────────────────────────────────
            case "has" when v.Equals("attachment", StringComparison.OrdinalIgnoreCase):
                return m => m.HasAttachments;
            case "has" when v.Equals("userlabels", StringComparison.OrdinalIgnoreCase):
                return m => m.CategoryId != null;
            case "has" when v.Equals("nouserlabels", StringComparison.OrdinalIgnoreCase):
                return m => m.CategoryId == null;

            case "is" when v.Equals("unread", StringComparison.OrdinalIgnoreCase):
                return m => !m.IsRead;
            case "is" when v.Equals("read", StringComparison.OrdinalIgnoreCase):
                return m => m.IsRead;
            // starred is Gmail's word for what this product calls flagged.
            case "is" when v.Equals("flagged", StringComparison.OrdinalIgnoreCase)
                        || v.Equals("starred", StringComparison.OrdinalIgnoreCase):
                return m => m.IsFlagged;
            case "is" when v.Equals("unstarred", StringComparison.OrdinalIgnoreCase)
                        || v.Equals("unflagged", StringComparison.OrdinalIgnoreCase):
                return m => !m.IsFlagged;

            // ── where ─────────────────────────────────────────────────────
            case "in":
            {
                var special = v.ToLowerInvariant() switch
                {
                    "inbox" => "\\Inbox",
                    "sent" => "\\Sent",
                    "trash" or "bin" => "\\Trash",
                    "spam" or "junk" => "\\Junk",
                    "drafts" or "draft" => "\\Drafts",
                    "scheduled" => "\\Scheduled",
                    _ => null,
                };
                // anywhere means "do not narrow" — the bin exclusion is lifted
                // by MentionsBin, so this is honestly a no-op condition.
                if (v.Equals("anywhere", StringComparison.OrdinalIgnoreCase)
                    || v.Equals("all", StringComparison.OrdinalIgnoreCase))
                    return _ => true;
                if (special is null) return FreeText(raw, false);
                var ids = Folders(ctx, special);
                return m => ids.Contains(m.FolderId);
            }
            case "label":
            {
                if (!ctx.CategoryIdsByName.TryGetValue(v.ToLowerInvariant(), out var id))
                    return FreeText(raw, false);
                return m => m.CategoryId == id;
            }

            // ── when ──────────────────────────────────────────────────────
            case "after" or "since" when TryDay(v, out var a):
                return m => m.ReceivedAt >= a;
            case "before" or "until" when TryDay(v, out var b):
                return m => m.ReceivedAt < b;
            case "newer_than" when TryAgo(v, out var newer):
                return m => m.ReceivedAt >= newer;
            case "older_than" when TryAgo(v, out var older):
                return m => m.ReceivedAt < older;

            // ── how big ───────────────────────────────────────────────────
            case "larger" or "size" when TryBytes(v, out var min):
                return m => m.SizeBytes >= min;
            case "smaller" when TryBytes(v, out var max):
                return m => m.SizeBytes <= max;

            default:
                return FreeText(raw, t.Phrase);
        }
    }

    /// <summary>
    /// Free text: the indexed vector first, then ILIKE over the fields a
    /// partial word would otherwise miss. A QUOTED phrase skips the vector —
    /// websearch_to_tsquery would match the words in any order, which is the
    /// opposite of what quotes were typed to ask for.
    /// </summary>
    private static Expression<Func<Message, bool>> FreeText(string term, bool phrase)
    {
        var p = Like(term);
        if (phrase)
        {
            return m => EF.Functions.ILike(m.Subject ?? "", p, "\\")
                     || EF.Functions.ILike(m.BodyText ?? "", p, "\\")
                     || EF.Functions.ILike(m.Snippet ?? "", p, "\\");
        }

        return m =>
            (m.SearchVector != null
             && m.SearchVector.Matches(EF.Functions.WebSearchToTsQuery("simple", term)))
            || EF.Functions.ILike(m.Subject ?? "", p, "\\")
            || EF.Functions.ILike(m.FromAddr ?? "", p, "\\")
            || EF.Functions.ILike(m.FromName ?? "", p, "\\")
            || EF.Functions.ILike(m.Snippet ?? "", p, "\\");
    }

    /// <summary>Midnight UTC on the given day. 2026/09/01 and 2026-09-01 both.</summary>
    private static bool TryDay(string value, out DateTimeOffset day)
    {
        day = default;
        var normalised = value.Replace('/', '-');
        if (!DateOnly.TryParse(normalised, System.Globalization.CultureInfo.InvariantCulture, out var d))
            return false;
        day = new DateTimeOffset(d.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero);
        return true;
    }

    /// <summary>newer_than:7d / 1m / 1y — the instant that far back.</summary>
    private static bool TryAgo(string value, out DateTimeOffset when)
    {
        when = default;
        if (value.Length < 2) return false;
        if (!int.TryParse(value[..^1], out var n) || n <= 0) return false;

        var now = DateTimeOffset.UtcNow;
        when = char.ToLowerInvariant(value[^1]) switch
        {
            'd' => now.AddDays(-n),
            'w' => now.AddDays(-7 * n),
            'm' => now.AddMonths(-n),
            'y' => now.AddYears(-n),
            _ => default,
        };
        return when != default;
    }

    /// <summary>larger:10M, smaller:500k, size:1000000.</summary>
    private static bool TryBytes(string value, out long bytes)
    {
        bytes = 0;
        if (value.Length == 0) return false;

        var last = char.ToLowerInvariant(value[^1]);
        var multiplier = last switch { 'k' => 1024L, 'm' => 1024L * 1024, 'g' => 1024L * 1024 * 1024, _ => 1L };
        var digits = multiplier == 1 ? value : value[..^1];

        if (!long.TryParse(digits, out var n) || n < 0) return false;
        bytes = n * multiplier;
        return true;
    }
}
