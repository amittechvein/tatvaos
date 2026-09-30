"""
The AI sentences say the same thing everywhere, and none is left blank.

Mr. Singh, 30 Sept 2026, approving the Mail AI privacy text: the admin page,
the privacy page and the website must say "in the same words everywhere" what
is sent for each feature, to whom, where, for how long, that it is off by
default and that the administrator decides. A customer used Mail AI on
25 Sept while the privacy page still said "meeting notes only" - the words
had drifted from the product, and nothing noticed.

  1. Every sentence constant in apps/api/Shared/Ai/AiDisclosure.cs (the admin
     page is built from them) appears WORD FOR WORD in the privacy page.
  2. The privacy page and the website name the vendor and place the way the
     admin page does: "OpenAI, in the United States".
  3. The website no longer says "outside India" (the sentence it replaced).
  4. NOTHING IS PENDING: no "[PENDING" anywhere in those files. The retention
     line waits on Amit reading the OpenAI account's data settings, and the
     captions wording on Mr. Singh; until both are filled in, this fails, so
     the text cannot ship with a blank in it.

Usage: python tests/ai/privacy-text-matches.py      (from the repository root)
Exit 0 = all four hold; 1 = not; 2 = could not run.
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FILES = {
    'disclosure': 'apps/api/Shared/Ai/AiDisclosure.cs',
    'privacy': 'apps/web/app/privacy/page.tsx',
    'website': 'apps/website/public/index.html',
    'admin api': 'apps/api/Modules/Core/Endpoints/OrgAiEndpoints.cs',
    'admin page': 'apps/web/app/org/ai/page.tsx',
}
TO_WHOM = 'OpenAI, in the United States'

text = {}
for k, p in FILES.items():
    full = os.path.join(ROOT, p)
    if not os.path.isfile(full):
        print(f'  {p} not found - the check did NOT run')
        sys.exit(2)
    text[k] = open(full, encoding='utf-8-sig').read()

failures, pending = [], []

# ── 1. The constants, as C# joins them ("..." + "...") ────────────────────
consts = {}
for m in re.finditer(r'public const string (\w+)\s*=\s*((?:\s*\+?\s*"(?:[^"\\]|\\.)*")+)\s*;', text['disclosure']):
    consts[m.group(1)] = ''.join(re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(2)))
WANTED = ['HelpMeWrite', 'SuggestedReplies', 'Summarise', 'Sorting', 'NeverSent', 'WhoDecides', 'Retention']
missing = [w for w in WANTED if w not in consts]
if missing:
    print(f'  AiDisclosure.cs has no {", ".join(missing)} - the check cannot read it, so it proves nothing')
    sys.exit(2)
# Sorting's confirmation on the admin page keeps the sentence Mr. Singh
# approved ("Every new email that arrives, ... will be sent to ..."), so it is
# held to that constant's two phrases that carry the meaning, not to the
# constant itself.
SORTING_PHRASES = ['including ones about health, children or money', 'the first 1,000 characters of the new']
for name in WANTED:
    if consts[name] not in text['privacy']:
        failures.append(f'the privacy page does not carry AiDisclosure.{name} word for word: "{consts[name][:70]}..."')
    if name == 'Sorting':
        for phrase in SORTING_PHRASES:
            if phrase not in consts[name] or phrase not in text['admin api']:
                failures.append(f'the sorting sentence and the admin page do not both say "{phrase}"')
    elif f'AiDisclosure.{name}' not in text['admin api']:
        failures.append(f'the admin page (OrgAiEndpoints) does not use AiDisclosure.{name}')

# ── 2. Who and where ─────────────────────────────────────────────────────
if 'AiDisclosure.ToWhom' not in text['admin api']:
    failures.append('the admin page does not name who and where through AiDisclosure.ToWhom')
for k in ('privacy', 'website'):
    if TO_WHOM not in text[k]:
        failures.append(f'the {k} does not say "{TO_WHOM}"')

# ── 3. The sentence the website replaced ─────────────────────────────────
if 'outside India' in text['website']:
    failures.append('the website still says "outside India" - it must name OpenAI, in the United States')

# ── 4. Nothing pending ───────────────────────────────────────────────────
for k, t in text.items():
    for m in re.finditer(r'\[PENDING[^\]]*\]?', t):
        line = t.count('\n', 0, m.start()) + 1
        pending.append(f'{FILES[k]}:{line}  {m.group(0)[:90]}')

print(f'  {len(WANTED)} sentences checked across the admin page, the privacy page and the website')
for f in failures:
    print(f'  ✗ {f}')
for p in pending:
    print(f'  ✗ PENDING  {p}')
if failures or pending:
    print(f'  FAIL  {len(failures)} mismatch(es), {len(pending)} placeholder(s) still to fill')
    sys.exit(1)
print('  ✓ the same words everywhere, and nothing left blank')
sys.exit(0)
