"""How each organisation user's answer changed between two measurements.

  CHANGED: anything that existed BEFORE and is different AFTER — the plan,
           its products, any feature's included/limit/source/override, the
           AI credits, the storage figures — or a user on one side only.
           Mr. Singh's rule for PR 313: this must be 0.
  ADDED:   feature codes that did not exist before (the catalogue grew),
           listed with what the organisation gets: included? limit? why?

usage: python compare.py BEFORE_PREFIX AFTER_PREFIX
       (reads <prefix>.users.tsv and <prefix>.answers.tsv)
prints: changed_users=N added_users=N, then one line per added feature
"""
import json, sys
from collections import Counter

def answers(prefix):
    d = {}
    for line in open(prefix + '.answers.tsv', encoding='utf-8'):
        t, a = line.rstrip('\n').split('\t', 1)
        d[t] = json.loads(a)
    return d

def users(prefix):
    return dict((u, t) for u, t, _ in (l.rstrip('\n').split('\t') for l in open(prefix + '.users.tsv', encoding='utf-8')))

KEEP = ('Included', 'Limit', 'Source', 'OverrideId', 'OverrideExpiresAt')

def classify(x, y):
    """-> (changed: bool, added: dict code -> (included, limit, source))"""
    if y is None:
        return True, {}
    changed = x['ai'] != y['ai'] or x['cap'] != y['cap'] \
        or any(x['ent'][k] != y['ent'].get(k) for k in x['ent'] if k != 'Features')
    fx = {f['Code']: f for f in x['ent']['Features']}
    fy = {f['Code']: f for f in y['ent']['Features']}
    for c, f in fx.items():
        if c not in fy or any(f.get(k) != fy[c].get(k) for k in KEEP):
            changed = True
    added = {c: (f['Included'], f['Limit'], f['Source']) for c, f in fy.items() if c not in fx}
    return changed, added

b, a = answers(sys.argv[1]), answers(sys.argv[2])
ub, ua = users(sys.argv[1]), users(sys.argv[2])
changed_users, added_users, added = 0, 0, Counter()
for u in set(ub) | set(ua):
    if u not in ub or u not in ua or ub[u] != ua[u]:
        changed_users += 1; continue
    ch, ad = classify(b[ub[u]], a.get(ua[u]))
    changed_users += ch
    if ad:
        added_users += 1
        for c, v in ad.items(): added[(c,) + v] += 1
print(f"changed_users={changed_users} added_users={added_users}")
for (c, inc, lim, src), n in sorted(added.items()):
    print(f"  added {c}: included={inc} limit={'none' if lim is None else lim} ({src}) for {n} user(s)")
