# 0017 — Payroll: build it, or hand it to someone who already does it

**Status:** proposed. **This is Amit's decision** (roadmap §7, open question 2).
Mr. Singh's handover (§3) asks that it be settled "before Phase 9 is
scheduled, not inside it". This paper lays out the choice. Nothing is built,
and nothing here needs building before R5.
**Date:** 2026-10-09
**Lane:** Hire & People
**Needs:** Amit (the choice) · Mr. Singh (§4, the technical shape of whichever
is chosen) · a chartered accountant (§5)

---

## The question in one paragraph

Paying salaries in India means getting **PF, ESI, TDS (income tax), professional
tax and labour welfare fund** right for every employee, every month, in every
state the customer has staff. The rates and slabs change with budgets and
state notifications. When the numbers are wrong, the result is not a bug
report: an employee is underpaid, or the customer gets a notice from EPFO or
the tax department, and they hold us responsible. The question is whether
TatvaOS calculates those numbers itself, or lets a specialist do it.

## The three options

### A. Build it ourselves

TatvaOS computes gross-to-net, deductions, statutory contributions, payslips,
Form 16, and the challans/returns data.

- **For:** it is all ours; no partner, no revenue share; one product, one bill;
  the deepest integration with attendance and leave.
- **Against:** **we own statutory correctness forever.** Every Union budget,
  every EPFO or ESIC circular, every state's professional-tax slab change is
  our work, on a deadline we do not set. One wrong month affects every
  customer at once. It needs someone who knows Indian payroll law (not only a
  developer) to check every release. It is the largest single build in the
  roadmap.
- **Realistic first version:** months, not weeks, and only for the states our
  first customers are in.

### B. Integrate with a payroll provider

TatvaOS keeps the people, attendance, leave and salary structure (which it
needs anyway, R5). A specialist payroll service does the statutory
calculation, payslips and filings, and we pass data both ways.

- **For:** statutory correctness is the partner's job and their whole business.
  R6 ships much sooner. The customer gets filings done by someone accountable
  for them.
- **Against:** a partner relationship and probably a revenue share or
  per-employee fee. Their outages and price changes become ours. Data about
  salaries leaves TatvaOS for the partner (a DPDP processor agreement, and a
  question for 0015's design). Two products for the customer to understand,
  unless the integration is seamless.
- **Who:** Indian payroll providers exist that sell to businesses our size.
  **Whether any of them offers an API suited to being embedded in another
  product, on terms we would accept, is unverified.** Finding out is the first
  task if B is chosen. We already use Razorpay for billing, and Razorpay sells a
  payroll product, so that is a natural first conversation. It is not a
  recommendation of them over others.

### C. Payroll-ready, not payroll — export first

TatvaOS produces a clean, month-end **payroll input file**: who worked, which
days, leave taken, loss of pay, salary structure, joiners and leavers, arrears.
The customer's existing payroll (their CA, Tally, a provider) computes and
pays.

- **For:** **no statutory risk at all.** It is useful from day one, because
  most of a payroll team's month-end pain is gathering exactly these inputs. It
  takes weeks, not months. It keeps both A and B open, since it is the data
  either needs.
- **Against:** the customer still needs something else to pay salaries. "HR
  suite with payroll" is not something we can say yet.

## My recommendation

**C now, as R6's payroll piece; then B; A only if the business later wants
payroll as a product line of its own.**

- C is the part of payroll that is really ours: attendance, leave and the
  people data are in TatvaOS anyway. It carries no statutory risk and ships
  with R5 and R6.
- B can then be chosen with a partner in hand and with real customers asking,
  rather than guessed now.
- A is a different company's product. If TatvaOS ever wants it, it should be a
  decision to hire payroll expertise, not a phase in this roadmap.

**What C means for what we tell customers:** "TatvaOS prepares your payroll
inputs; your payroll provider or CA runs payroll." It must not be called
"payroll" on the website or in the product (handover §5.2: the label is a
promise).

## 4. For Mr. Singh: what each option needs from the code

- **All three** need the salary structure held as **effective-dated rows**
  (what was true on the 1st of a month stays true when the structure changes on
  the 15th), and amounts in **paise, as integers**, never floating point.
- **C:** one export per organisation per month, frozen once generated (a
  re-export is a new version, never an overwrite). It is a payroll file in
  0015's sense, so it is masked by default and audited per value where it
  carries bank details or PAN.
- **B:** the partner is a **processor** under the DPDP Act: an agreement before
  any data flows, the minimum fields sent, and a record of each transfer. The
  partner's credentials sealed like other platform secrets (`SettingsCrypto`),
  not in `.env` text.
- **A:** statutory rates as **data with an effective date and a source** (the
  circular or notification), never constants in code. A test per rate change,
  using a worked example from the source. A second, independent calculation of
  every payslip before it is released.

## 5. For a chartered accountant (through Amit)

1. If TatvaOS produces only payroll inputs (C), does it carry any statutory
   responsibility for the payroll that is run from them?
2. Which states will our first People customers have staff in? (Professional
   tax and labour welfare fund differ by state, so this sizes A and B.)
3. Of the providers a CA would trust, which already work with businesses of
   our customers' size (schools, 20–500 staff)?

## Consequences of the recommendation

- **Easier:** R6 carries no statutory risk. The month-end export is useful on
  its own and is groundwork for B.
- **Harder:** "TatvaOS does payroll" is not true yet and must not be said. The
  roadmap's Phase 9 becomes "payroll inputs" until B is chosen.
- **Accepted:** customers who want everything in one product must wait for B.

## Revisit when

- two or more paying customers ask for payroll run inside TatvaOS;
- a payroll provider offers an embeddable API on terms worth taking;
- the business decides payroll is a product line in its own right (that is
  when A becomes a question again, with payroll expertise hired to answer it).
