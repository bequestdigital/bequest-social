// Take a published post back down off the platforms it went out on.
//
// The zero-touch pipeline can publish something that should never have gone
// out (see content/evidence/README.md — 2026-09-23 shipped an invented client
// case study). This is the undo. It deletes the live posts using the ids
// recorded in the package's results block, then moves the package to
// content/retracted/ with a reason, so the date is never silently reused and
// the record of what happened survives.
//
// Usage: node src/retract.js --date 2026-09-23 --reason "..." [--only fb,ig,x]
//        BRAND=fgc node src/retract.js --date ... --reason "..."
//        add --dry-run to print what would be deleted and touch nothing.
//
// Runs in CI (retract.yml) so the platform tokens never come local.
import fs from 'node:fs';
import path from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import { ROOT, CONTENT, PUBLISHED, readJSON, writeJSON, retry } from './util.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const RETRACTED = path.join(CONTENT, 'retracted');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { only: ['fb', 'ig', 'x'] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date') out.date = args[++i];
    else if (args[i] === '--reason') out.reason = args[++i];
    else if (args[i] === '--only') out.only = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (args[i] === '--dry-run') out.dryRun = true;
  }
  if (!out.date) throw new Error('--date YYYY-MM-DD is required');
  if (!out.reason && !out.dryRun) throw new Error('--reason is required (it is written into the retraction record)');
  return out;
}

// Same derivation publish.js uses: the stored token may be a system-user token,
// in which case the Page token has to be derived before it can delete.
async function resolvePageToken() {
  const tok = process.env.META_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;
  if (!tok || !pageId) return tok;
  try {
    const qs = new URLSearchParams({ fields: 'id,access_token', access_token: tok });
    const data = await fetch(`${GRAPH}/me/accounts?${qs}`).then((r) => r.json());
    const page = (data.data || []).find((p) => p.id === pageId);
    if (page?.access_token) return page.access_token;
  } catch {
    /* already a Page token — use as-is */
  }
  return tok;
}

async function graphDelete(id, token) {
  const qs = new URLSearchParams({ access_token: token });
  const res = await fetch(`${GRAPH}/${id}?${qs}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = JSON.stringify(data.error || data).slice(0, 400);
    // Already gone is success, not failure — the goal state is "not live".
    if (/does not exist|Unsupported get request|cannot be found/i.test(msg)) return { ok: true, alreadyGone: true };
    const err = new Error(`Graph DELETE ${id}: ${msg}`);
    err.retryable = res.status >= 500 || data.error?.is_transient;
    throw err;
  }
  return { ok: true };
}

async function deleteX(ids) {
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  });
  const out = [];
  for (const id of ids) {
    try {
      const r = await client.v2.deleteTweet(id);
      out.push({ id, ok: r?.data?.deleted !== false });
    } catch (e) {
      const msg = e?.data?.detail || e?.message || String(e);
      if (/not found|No such/i.test(msg)) out.push({ id, ok: true, alreadyGone: true });
      else out.push({ id, ok: false, error: msg.slice(0, 300) });
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs();
  const pkgPath = path.join(PUBLISHED, `${opts.date}.json`);
  if (!fs.existsSync(pkgPath)) throw new Error(`No published package at ${path.relative(ROOT, pkgPath)}`);
  const pkg = readJSON(pkgPath);
  const results = pkg.results || {};

  const plan = [];
  if (opts.only.includes('fb') && results.fb?.id) plan.push(['fb', results.fb.id]);
  if (opts.only.includes('ig') && results.ig?.id) plan.push(['ig', results.ig.id]);
  const xIds = opts.only.includes('x') ? results.x?.thread_ids || (results.x?.id ? [results.x.id] : []) : [];

  console.log(`Retracting ${opts.date}: ${plan.map(([k, id]) => `${k}=${id}`).join(' ')}${xIds.length ? ` x=${xIds.join(',')}` : ''}`);
  if (opts.dryRun) {
    console.log('--dry-run: nothing deleted.');
    return;
  }

  const token = await resolvePageToken();
  const outcome = {};

  for (const [key, id] of plan) {
    try {
      const r = await retry(() => graphDelete(id, token), { label: `delete ${key} ${id}` });
      outcome[key] = { ok: true, id, ...r };
      console.log(`  ${key} ${id} deleted${r.alreadyGone ? ' (was already gone)' : ''}`);
    } catch (e) {
      outcome[key] = { ok: false, id, error: e.message };
      console.log(`::error title=Retract failed::${key} ${id}: ${e.message}`);
    }
  }
  if (xIds.length) {
    const r = await deleteX(xIds);
    outcome.x = r;
    for (const t of r) {
      if (t.ok) console.log(`  x ${t.id} deleted${t.alreadyGone ? ' (was already gone)' : ''}`);
      else console.log(`::error title=Retract failed::x ${t.id}: ${t.error}`);
    }
  }

  // Move the package out of published/ so build-preview stops surfacing it and
  // the date can't be mistaken for a live post.
  fs.mkdirSync(RETRACTED, { recursive: true });
  pkg.meta = {
    ...pkg.meta,
    status: 'retracted',
    retracted_reason: opts.reason,
    retracted_at: new Date().toISOString(),
    retraction_results: outcome,
  };
  writeJSON(path.join(RETRACTED, `${opts.date}.json`), pkg);
  fs.rmSync(pkgPath);
  for (const f of pkg.image?.files || []) {
    const img = path.join(PUBLISHED, f);
    if (fs.existsSync(img)) fs.renameSync(img, path.join(RETRACTED, f));
  }
  console.log(`Moved package + assets to ${path.relative(ROOT, RETRACTED)}/`);

  const failed = Object.entries(outcome).some(([, v]) => (Array.isArray(v) ? v.some((t) => !t.ok) : !v.ok));
  if (failed) {
    console.log('::error title=Manual takedown needed::At least one channel did not delete — remove it by hand.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
