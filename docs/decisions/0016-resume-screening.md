# 0016 — Résumé screening: what the AI may do to a candidate

**Status:** proposed. For Mr. Singh's review, as his Hire & People handover
asks (§3): *"Resume screening — it ranks human beings. Must be explainable to a
rejected candidate, and a human must be able to see and overturn it. Before
Phase 3."* Nothing here is built.
**Date:** 2026-10-08
**Lane:** Hire & People
**Needs:** Amit (the product shape, §1 and §10) · Mr. Singh (the record, the
provider, the checks) · a lawyer (§9, through Mr. Singh)

---

## Context

Roadmap Phase 3 (R3) draws the pipeline as *Résumé → AI Parsing → Skills →
Experience → Qualification → Job Matching → **Match Score***, with a recruiter
assistant on top ("show me the top 10 BDM candidates", "why is this person a
good match", "compare these five"). The same roadmap, §6.5, sets the
obligations:

- **assistive only — "no automatic rejection, ever"**, in the code and not only
  in the document;
- **every score explainable and logged**: model, version, what it saw, what it
  said;
- **historical hiring data reproduces historical bias.**

Three things decided since then bear on it:

- **0010: erasure wins over explainability.** When a candidate is erased,
  their rejection reason goes with them. An AI explanation is no different: it
  is erased with the candidate, and nobody keeps a copy "to be able to explain".
- **`AiGate` (Mr. Singh, 30 Sept).** Every AI feature has an organisation list
  that ships **empty**, and stays empty until the feature's disclosure is live.
  Every entry point asks the gate, and a build check enforces it.
- **The provider shared our inputs for training until 1 Oct 2026** (Techvein's
  OpenAI organisation, turned off that day on Amit's go). Résumés are the most
  personal text this product has handled, so §6 makes the provider's terms a
  precondition, not an afterthought.

## 1. The central proposal: evidence, not a score

**I recommend that TatvaOS does not show a single "match %".** "The model said
43%" is exactly the answer §6.5 says is not an answer. It cannot be explained
to a rejected candidate, and a recruiter cannot meaningfully overturn it: what
would "it's really 60%" mean?

Instead, **screening is checked against the job's own requirements, one by
one:**

1. The recruiter writes the requirements on the job opening, each marked
   **must-have** or **nice-to-have**: "3+ years B2B sales", "fluent Hindi",
   "B.Ed.". The requirements are the recruiter's, written by a person.
2. For each requirement, the AI says one of **shown / not shown / unclear**, and
   **quotes the line of the résumé it relied on**. With no quote, the answer is
   "not shown". An AI may not assert a fact the résumé does not contain.
3. Candidates are sorted by **must-haves shown**, then nice-to-haves. The sort
   is a count anyone can redo by eye.
4. **A person can mark any line wrong** ("she does have a B.Ed.; it's on page 2").
   Once a person has marked a line, their answer replaces the AI's in the sort,
   and both are kept (§4).

What the candidate can be told, if they ask why: *"Your application was
assessed against these four requirements. For two, the reviewer found [evidence];
for 'fluent Hindi', nothing in your résumé showed it."* That is explainable,
and it is true.

**This changes the roadmap's promised "Match Score", so Amit decides.** If a
score is wanted anyway, it should be the visible count ("3 of 4 must-haves"),
never a model-generated percentage.

## 2. What the AI may never do — enforced in the code

| Never | Enforced by |
|---|---|
| Reject, withdraw, move a stage, or change any outcome | The screening code holds **no reference** to the application-state writers. A source check (like `check-job-gate.sh`) fails the build if the screening module calls them. |
| Hide a candidate from the list | The candidate list is **not filterable by AI result.** It is sortable only, and every candidate stays visible. There is no "show only matches" switch. |
| Run without a person asking | Screening runs when a recruiter presses **Screen** (one application or a job's batch), never automatically on arrival. *(Amit may choose automatic-on-arrival later. §1 still holds either way.)* |
| Be the only thing a rejection rests on | The reject dialog requires the human's reason (`ck_application_rejection_reason`, #267). An AI line is **not** offered as the reason text. |

## 3. What the AI sees — less than the résumé

Before any résumé text goes to a model, the gate **removes** what should not
influence screening and has no bearing on the requirements:

- name, photo, email, phone, full address (city kept only if a requirement
  names a location);
- **date of birth and age, gender, marital status, religion, caste,
  community, father's or spouse's name, nationality, physical details.** Indian
  résumés often carry these, and they are exactly what screening must not see;
- employment gaps are not removed, but the prompt instructs the model to treat
  them as neutral. The test set in §8 checks it.

**Removal is imperfect, and the document says so.** A college name or a club
can stand in for community or gender. Whether college names are removed is
**Amit's call**: they help the "B.Ed. from a recognised university"
requirement, and they also carry class bias. My recommendation is to keep the
degree and drop the institution unless a requirement names one.

## 4. The explanation record — kept, shown, and erased

`hire.screening_runs`, one row per (application, run):

- the **requirements as they stood** (a copy: an edited job must not rewrite
  history);
- **model, model version, prompt template version** (versioned in the repo);
- a **hash of the redacted input**, not the text itself, so a run can be shown
  to have seen this exact résumé without a second copy of it;
- per requirement: **shown / not shown / unclear, the quoted evidence**, and a
  person's correction if any (who, when, what);
- who pressed Screen, and when.

It is **shown to the recruiter in full**. It is reachable only through
`HireAccess` (a hiring manager sees runs for their own jobs' applications only,
as #267). It **cascades with the application**, so 0010's erasure and #271's
retention delete it with the candidate, and the audit log holds counts only, as
everywhere in Hire.

## 5. The recruiter assistant ("top 10 BDM candidates")

It answers **from the stored runs and the structured fields**, never by sending
a whole talent pool to a model to rank. "Top 10" means the §1 sort, filtered.
"Why is this a good match" means "show the run". "Compare these five" means the
runs side by side. Generating text such as interview questions is fine, but it
draws only on the job description and never on candidates' résumés.

And it **only ever sees what the asking person may see** (`HireAccess`). A
hiring manager's "top 10" is the top 10 of *their* jobs.

## 6. Consent, disclosure and the provider — before the first run

1. **The provider's terms first.** The API organisation's data controls must
   show **no sharing for training** on the day this ships, read from the
   provider's console and recorded. If the provider offers zero retention for
   this kind of data, we use it. **Mr. Singh rules on the provider.**
2. **A new AI feature label, `hire.screening`, with its list empty** (the
   `AiGate` rule) until the candidate-facing disclosure is live.
3. **The candidate notice (0010 §7) says AI assists screening**: what it looks
   at, that a person decides, and that they may ask for the explanation. That
   wording goes to Mr. Singh before any candidate sees it, as 0010 requires.
4. **The organisation's own `allow_ai` stays the consent**, as for every AI
   feature.

## 7. Bias: what can be measured without collecting what we refuse to collect

Hire does not record gender, religion or caste, and should not start in order
to measure bias. So the measurement is **counterfactual**, on synthetic data:

- a fixed test set of résumés in **pairs that differ in one thing only**: a
  woman's name or a man's, a Hindu, Muslim or Christian name, a government or a
  private college, a two-year gap or none;
- every model or prompt change runs the set, and **any pair whose results
  differ fails the change**;
- the set is in the repository, versioned, and grows whenever a recruiter's
  correction reveals a pattern.

Plus, in production: **how often people overturn the AI**, per requirement
type. A requirement type that is overturned often is wrong more often than not,
and is worth reading.

## 8. The checks, and their red runs

1. **No path from screening to an outcome** (source scan). *Red:* call the
   reject writer from the screening module.
2. **Redaction:** for a fixture résumé containing a name, a phone number, a
   DOB, a religion and a caste, the exact text sent to the (faked) provider
   contains none of them. *Red:* skip the redaction step.
3. **Quote or "not shown":** a provider reply claiming "shown" with no quote,
   or with a quote that is not in the résumé, is stored as "not shown". *Red:*
   trust the reply.
4. **Counterfactual pairs** (§7) agree. *Red:* a prompt that mentions gender.
5. **The gate:** the existing AI-entry check covers the new entry point. With
   the list empty, Screen answers "not available".
6. **Visibility:** a hiring manager cannot see another job's runs; erasing a
   candidate leaves zero runs. *Red:* read the table outside `HireAccess`.
7. **History holds:** editing a job's requirements does not change an old
   run's requirements.

## 9. For the lawyer (through Mr. Singh)

- Whether any Indian law or rule specifically governs automated assessment of
  job applicants, beyond the DPDP Act's general duties. I do not know of one,
  and I am not the person to say.
- Whether a rejected candidate has a right to the explanation, or whether we
  are simply choosing to give it. The design gives it either way.
- Whether disability-related information in a résumé (the RPwD Act 2016) needs
  handling beyond §3's removal.

## 10. Questions

**For Amit (product):**
1. §1: evidence per requirement instead of a "match %". (I recommend it. It
   changes the roadmap's wording.)
2. §2: Screen pressed by a person, or automatic on arrival. (I recommend a
   person, for R3.)
3. §3: drop college names unless a requirement names one. (I recommend
   dropping them.)
4. §6: may a rejected candidate ask for, and receive, their screening
   explanation? (I recommend yes.)

**For Mr. Singh:**
5. §4: storing a hash of the input, not the input. Is that enough for
   "what it saw"?
6. §6: the provider, and the zero-retention question.
7. §7: whether the counterfactual set is a CI gate or a release checklist item.

**Out of scope here:** interview recordings and their summaries. That is
roadmap open question 3, Amit's, and the most sensitive thing in the product.
It deserves its own record.

## Consequences

- **Easier:** every screening result can be explained in a sentence and
  corrected by a person. Erasure stays simple. No opaque number can quietly
  become the decision.
- **Harder:** recruiters must write requirements as a list, which is more work
  than a free-text description. The sort is coarser than a percentage, and some
  will want the percentage.
- **Accepted:** redaction leaks through proxies (§3). Counterfactual tests find
  some bias, not all of it.

## Revisit when

- a customer or regulator asks for something this record cannot answer;
- the provider changes, or its data terms do;
- recruiters overturn one kind of requirement most of the time (§7). Then the
  approach for that kind is wrong, not the recruiter.
