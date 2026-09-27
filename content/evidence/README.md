# content/evidence/

A `PROOF` calendar slot will **not** generate unless `content/evidence/<date>.json`
exists. Everything in that file must be verified and permission-cleared before it
lands here — the model is instructed to use it verbatim and invent nothing.

Why the gate exists: on 2026-09-23 the Week 10 PROOF slot generated with no source
data. The model produced a "nonprofit client, +22% lift in first-time donors, 41%
average open rate" case study that never happened, and the zero-touch pipeline
published it to Facebook, Instagram and X. The calendar's standing note ("Weeks 10
and 12 PROOF posts use real client data/quotes — confirm with Tyler and clients
before those slots lock") was never enforced anywhere in code.

Shape is free-form — whatever the post needs. Keep keys self-describing:

```json
{
  "client": "Anonymized as 'a nonprofit client' — real name NOT for publication",
  "permission": "Cleared by <who> on <date>, via <email/call>",
  "figures": { "goal": "15% lift in first-time donors", "outcome": "22% lift" },
  "quote": "Exact words, copied — never paraphrased or tidied",
  "attribution": "Name, Title, Org — exactly as the client approved it"
}
```

No file, no post. A blank day is cheaper than a fabricated claim.
