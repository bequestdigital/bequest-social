// Build docs/analytics.html — the performance page next to the post preview,
// read straight from content/<brand>/analytics/summary.json and strategy.json.
// Zero dependencies, no client-side fetching (GitHub Pages serves it static).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, esc, readJSON } from './util.js';

const BRANDS = [
  { key: 'bequest', name: 'Bequest Digital', dir: 'content', accent: '#CBA84D' },
  { key: 'fgc', name: 'Florida Glass Company', dir: 'content/fgc', accent: '#a9cde8' },
];

function load(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? readJSON(p) : null;
}

function scoreClass(s) {
  if (s == null) return '';
  return s >= 1.3 ? 'hi' : s <= 0.7 ? 'lo' : '';
}

function bucketTable(title, b) {
  const rows = Object.entries(b || {});
  if (!rows.length) return '';
  return `<div class="tbl"><h4>${esc(title)}</h4><table><tr><th>bucket</th><th>n</th><th>mean score</th><th></th></tr>${rows
    .map(
      ([k, v]) =>
        `<tr class="${scoreClass(v.mean_score)}"><td>${esc(k)}</td><td>${v.n}</td><td>${v.mean_score}</td><td class="sig">${v.signal ? '' : 'thin sample'}</td></tr>`
    )
    .join('')}</table></div>`;
}

function postRow(p) {
  const eng = Object.entries(p.engagement || {})
    .map(([k, v]) => `${k.toUpperCase()} ${v ?? '—'}`)
    .join(' · ');
  const reach = Object.entries(p.reach || {})
    .map(([k, v]) => `${k.toUpperCase()} ${v ?? '—'}`)
    .join(' · ');
  return `<tr class="${scoreClass(p.score)}"><td>${p.date}<br><small>${esc(p.weekday || '')}</small></td><td>${esc(p.type || '')}<br><small>${esc(p.template || '')}</small></td><td class="hook">${esc(p.hook || '')}</td><td class="num">${p.score ?? '—'}</td><td class="small">${esc(eng)}</td><td class="small">${esc(reach)}</td></tr>`;
}

function brandSection(b) {
  const summary = load(`${b.dir}/analytics/summary.json`);
  const strategy = load(`${b.dir}/strategy.json`);
  if (!summary) {
    return `<section id="${b.key}"><h2 style="--accent:${b.accent}">${b.name}</h2><p class="empty">No analytics collected yet.</p></section>`;
  }
  const m = summary.channel_medians || {};
  const med = (ch) => (m[ch]?.n ? `${m[ch].engagement ?? '—'} eng / ${m[ch].reach ?? '—'} reach <small>(n=${m[ch].n})</small>` : '<small>no data</small>');
  const allPosts = [...(summary.top_posts || []), ...(summary.recent || []), ...(summary.bottom_posts || [])];
  const byDate = new Map(allPosts.map((p) => [p.date, p]));
  const recent = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
  return `<section id="${b.key}">
  <h2 style="--accent:${b.accent}">${b.name}</h2>
  <div class="tiles">
    <div class="tile"><div class="k">${summary.posts_scored}</div><div class="l">posts scored<br><small>of ${summary.posts_total} published</small></div></div>
    <div class="tile"><div class="k">FB</div><div class="l">${med('fb')}</div></div>
    <div class="tile"><div class="k">IG</div><div class="l">${med('ig')}</div></div>
    <div class="tile"><div class="k">X</div><div class="l">${med('x')}</div></div>
  </div>
  <p class="note">Metrics fetched ${esc(summary.metrics_fetched_at || 'never')}. Score 1.0 = a typical post on that channel; 2.0 = twice typical. ${esc(summary.scoring || '')}</p>
  ${
    strategy
      ? `<div class="strategy">
    <h3>Current strategy <small>updated ${esc(strategy.updated_at)}</small></h3>
    <ul>${(strategy.guidance || []).map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
    ${
      strategy.coach_notes
        ? `<p><strong>Coach reading.</strong> ${esc(strategy.coach_notes.reading)}</p><ul>${(strategy.coach_notes.instructions || [])
            .map((i) => `<li>${esc(i)}</li>`)
            .join('')}${strategy.coach_notes.test_next ? `<li><em>Test next:</em> ${esc(strategy.coach_notes.test_next)}</li>` : ''}</ul>`
        : ''
    }
    ${strategy.operator_notes ? `<p><strong>Operator notes.</strong> ${esc(strategy.operator_notes)}</p>` : ''}
    <p class="small">Type weights ${esc(JSON.stringify(strategy.weights?.type || {}))} · template weights ${esc(JSON.stringify(strategy.weights?.template || {}))}</p>
  </div>`
      : ''
  }
  <div class="tables">${bucketTable('By post type', summary.by_type)}${bucketTable('By graphic', summary.by_template)}${bucketTable('By weekday', summary.by_weekday)}</div>
  <div class="tables">${Object.entries(summary.by_hook_feature || {})
    .map(([k, v]) => bucketTable(`Hook: ${k.replace(/_/g, ' ')}`, v))
    .join('')}</div>
  <h3>Posts</h3>
  <table class="posts"><tr><th>date</th><th>type</th><th>hook</th><th>score</th><th>engagement</th><th>reach</th></tr>${recent.map(postRow).join('')}</table>
</section>`;
}

const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Bequest Social — Performance</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f3ef;color:#1d232a}
header{background:#0D2118;color:#F6F4EE;padding:26px 20px}
header h1{margin:0;font-size:22px}
header p{margin:6px 0 0;font-size:13px;color:#cbd4cd}
nav{margin-top:14px}
nav a{display:inline-block;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:7px 14px;border-radius:999px;margin-right:8px}
main{max-width:1180px;margin:0 auto;padding:10px 20px 60px}
h2{font-size:20px;border-left:5px solid var(--accent,#888);padding-left:12px;margin:38px 0 14px}
h3{font-size:15px;margin:26px 0 8px}
h3 small,h4 small{font-weight:400;color:#889;font-size:12px}
h4{font-size:13px;margin:0 0 6px;color:#556}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.tile{background:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.tile .k{font-size:24px;font-weight:700;color:#153325}
.tile .l{font-size:13px;color:#445;margin-top:4px}
.note{font-size:12px;color:#778;margin:12px 0 0}
.strategy{background:#fff;border-radius:10px;padding:14px 18px;margin:18px 0;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:14px;line-height:1.5}
.strategy ul{margin:6px 0 10px;padding-left:20px}
.tables{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:14px 0}
.tbl{background:#fff;border-radius:10px;padding:12px 14px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#889;padding:4px 6px;border-bottom:1px solid #eee}
td{padding:5px 6px;border-bottom:1px solid #f0efe9;vertical-align:top}
tr.hi td{background:#eef5ee}
tr.lo td{background:#f8ecec}
td.sig{font-size:11px;color:#a05a2c}
td.num{font-weight:700}
td.hook{max-width:420px}
.small,td.small{font-size:12px;color:#556}
table.posts{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.empty{color:#889;font-size:14px}
footer{text-align:center;font-size:12px;color:#99a;padding:30px}
</style></head><body>
<header>
  <h1>Social Performance</h1>
  <p>What the published posts actually did, and what the pipeline is doing about it. Rebuilt every Tuesday and Friday. Last built: ${now} ET.</p>
  <nav><a href="./index.html">Upcoming posts</a>${BRANDS.map((b) => `<a href="#${b.key}">${b.name}</a>`).join('')}</nav>
</header>
<main>
${BRANDS.map(brandSection).join('\n')}
</main>
<footer>Bequest Digital · autonomous publishing pipeline</footer>
</body></html>`;

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'analytics.html'), html);
console.log('docs/analytics.html built');
