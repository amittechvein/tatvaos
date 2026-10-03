"""
Every AI entry point asks AiGate first, and every AI feature label has a list.

WHY (Mr. Singh, 30 Sept 2026). On 25 Sept a customer used Mail AI before its
privacy text existed: the feature went live ahead of its disclosure. AiGate
(apps/api/Shared/Ai/AiGate.cs) gives every AI feature an organisation list
that ships empty until the disclosure is live. This check makes forgetting it
a failed build instead of a finding:

  1. SENDERS ASK. Every method in apps/api that sends to an AI provider -
     calls .CompleteAsync( (IAiGateway) or .TranscribeAsync( (a recording's
     audio, ConnectTranscriber) - calls AiGate.AllowedAsync( EARLIER IN THE
     SAME METHOD. The gateway asks too; this is the entry point asking, so
     nothing is read or prepared for a feature the organisation does not have.
  2. LABELS HAVE LISTS. Every feature label in the code - a `const string
     ...Feature = "..."`, or a `feature: "..."` argument - is a key of
     AiGate.Features or in AiGate.NoOrganisationContent.

Exempt, by name, because they ARE the plumbing rather than callers of it:
  Shared/Ai/MeteredAiGateway.cs  the gate's own home: it passes a request on
                                 to the provider after asking AiGate itself
  Shared/Ai/OpenAiGateway.cs,    the provider, and the interface
  Shared/Ai/IAiGateway.cs
  Modules/Connect/ConnectTranscriber.cs   defines TranscribeAsync

Usage: python tests/ai/every_ai_entry_calls_gate.py [apps/api directory]
Exit 0 = every entry asks and every label is listed; 1 = not; 2 = could not run.
"""
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'api')
ROOT = os.path.abspath(ROOT)

EXEMPT = {
    'Shared/Ai/MeteredAiGateway.cs',
    'Shared/Ai/OpenAiGateway.cs',
    'Shared/Ai/IAiGateway.cs',
    'Modules/Connect/ConnectTranscriber.cs',
}
SINK = re.compile(r'\.(CompleteAsync|TranscribeAsync)\(')
GATE = 'AiGate.AllowedAsync('
# Where a method (or a route's lambda) begins. Deliberately generous: the
# nearest one above a sink bounds the search, and a too-near boundary can only
# make the check STRICTER (it sees less), never let a missing gate through.
METHOD_START = re.compile(
    r'^\s*(?:(?:public|private|protected|internal|static|async|override|sealed|virtual)\s+)+[\w<>\[\],.? ]+\s+\w+\s*\('
    r'|\bapp\.Map(?:Get|Post|Put|Delete|Patch)\('
    r'|^\s*(?:public|private|internal)\s+sealed\s+class\s+\w+\(')

if not os.path.isdir(ROOT):
    print(f'  apps/api not found at {ROOT} - the check did NOT run')
    sys.exit(2)

files = []
for dp, dn, fn in os.walk(ROOT):
    dn[:] = [d for d in dn if d not in ('bin', 'obj')]
    for f in fn:
        if f.endswith('.cs'):
            files.append(os.path.join(dp, f))

rel = lambda p: os.path.relpath(p, ROOT).replace(os.sep, '/')
failures = []
senders = 0

# ── 1. Senders ask ─────────────────────────────────────────────────────────
for path in files:
    r = rel(path)
    if r in EXEMPT:
        continue
    lines = open(path, encoding='utf-8-sig').read().split('\n')
    for i, line in enumerate(lines):
        code = line.split('//', 1)[0]
        if not SINK.search(code):
            continue
        # A declaration of such a method, not a call to one.
        if re.search(r'\b(Task<[^>]*>|Task)\s+(CompleteAsync|TranscribeAsync)\(', code):
            continue
        senders += 1
        start = i
        while start > 0 and not METHOD_START.search(lines[start]):
            start -= 1
        body = '\n'.join(l.split('//', 1)[0] for l in lines[start:i + 1])
        if GATE not in body:
            failures.append(f'{r}:{i + 1}  sends to AI without asking AiGate.AllowedAsync first '
                            f'(method starting at line {start + 1})')

# ── 2. Labels have lists ───────────────────────────────────────────────────
consts = {}          # Name -> value, for every const string in apps/api
labels = {}          # value -> where it was found
CONST = re.compile(r'const\s+string\s+(\w+)\s*=\s*"([^"]*)"')
LABEL_CONST = re.compile(r'const\s+string\s+(\w*Feature)\s*=\s*"([a-z][a-z0-9_.]*)"')
LABEL_ARG = re.compile(r'feature:\s*"([a-z][a-z0-9_.]*)"')
for path in files:
    text = open(path, encoding='utf-8-sig').read()
    for m in CONST.finditer(text):
        consts.setdefault(m.group(1), m.group(2))
    for m in LABEL_CONST.finditer(text):
        labels.setdefault(m.group(2), f'{rel(path)} ({m.group(1)})')
    for m in LABEL_ARG.finditer(text):
        labels.setdefault(m.group(1), rel(path))

gate_path = os.path.join(ROOT, 'Shared', 'Ai', 'AiGate.cs')
if not os.path.isfile(gate_path):
    failures.append('Shared/Ai/AiGate.cs is missing: there is no registry of AI features at all')
    registered = set()
else:
    gate = open(gate_path, encoding='utf-8-sig').read()
    registered = set()
    for m in re.finditer(r'^\s*\[([\w.]+)\]\s*=', gate, re.M):       # [X.Name] = key
        name = m.group(1).split('.')[-1]
        if name in consts:
            registered.add(consts[name])
        else:
            failures.append(f'Shared/Ai/AiGate.cs: registry key {m.group(1)} is not a const string this check can read')
    for m in re.finditer(r'\[\s*"([a-z][a-z0-9_.]*)"\s*\]\s*=', gate):  # ["literal"] = key
        registered.add(m.group(1))
    exempt_block = re.search(r'NoOrganisationContent\s*=\s*new[^{]*\{([^}]*)\}', gate)
    if exempt_block:
        registered |= set(re.findall(r'"([a-z][a-z0-9_.]*)"', exempt_block.group(1)))

# ...and the label each CompleteAsync( call actually passes: its last
# argument, a literal or a const resolved by name. Without this, a label
# held in a const not named ...Feature (AiGate.Docs) is invisible to rule 2.
def last_argument(text, open_at):
    depth, i, start = 0, open_at, open_at + 1
    args = []
    while i < len(text):
        ch = text[i]
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
            if depth == 0:
                args.append(text[start:i])
                break
        elif ch == ',' and depth == 1:
            args.append(text[start:i]); start = i + 1
        i += 1
    return args[-1].strip() if args else ''

for path in files:
    r = rel(path)
    if r in EXEMPT:
        continue
    text = open(path, encoding='utf-8-sig').read()
    for m in re.finditer(r'\.CompleteAsync\(', text):
        arg = re.sub(r'^feature:\s*', '', last_argument(text, m.end() - 1))
        lit = re.fullmatch(r'"([a-z][a-z0-9_.]*)"', arg)
        if lit:
            labels.setdefault(lit.group(1), r)
        elif re.fullmatch(r'[\w.]+', arg) and arg.split('.')[-1] in consts:
            labels.setdefault(consts[arg.split('.')[-1]], f'{r} ({arg})')
        else:
            line = text.count('\n', 0, m.start()) + 1
            failures.append(f"{r}:{line}  CompleteAsync's feature argument [{arg}] is not a label this check can read")

for label, where in sorted(labels.items()):
    if label not in registered:
        failures.append(f'{where}: AI feature label "{label}" has no list in AiGate.Features')

print(f'  {senders} places send to an AI provider; {len(labels)} feature labels; {len(registered)} listed in AiGate')
if senders == 0:
    print('  found NO senders - the patterns no longer match the code, so this proves nothing')
    sys.exit(2)
if failures:
    for f in failures:
        print(f'  ✗ {f}')
    print(f'  FAIL  {len(failures)} problem(s)')
    sys.exit(1)
print('  ✓ every sender asks AiGate first, and every label has a list')
sys.exit(0)
