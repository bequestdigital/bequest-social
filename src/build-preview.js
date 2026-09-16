// Build docs/index.html — a human-friendly preview of every queued (and
// recently published) post across all brands, served via GitHub Pages.
// Runs inside the publish/generate workflows right before the state commit,
// so the page self-updates as posts are generated, approved, and published.
// Zero dependencies; images reference raw.githubusercontent.com on main.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, esc, todayET } from './util.js';

const REPO = process.env.GITHUB_REPOSITORY || 'bequestdigital/bequest-social';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;

const BRANDS = [
  { key: 'bequest', name: 'Bequest Digital', dir: 'content', accent: '#CBA84D', bg: '#0D2118' },
  { key: 'fgc', name: 'Florida Glass Company', dir: 'content/fgc', accent: '#a9cde8', bg: '#1d2b3a' },
];

function loadDir(dir, status) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8'));
        return { pkg, status, dir };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((e) => e.pkg?.meta?.unpublished_test !== true);
}

function weekday(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}
function prettyDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function chips(pkg) {
  const c = [];
  if (pkg.facebook) c.push('Facebook');
  if (pkg.instagram) c.push('Instagram');
  if (pkg.x) c.push('X');
  if (pkg.linkedin || (pkg.facebook && pkg.results?.li)) c.push('LinkedIn');
  return c;
}

function card({ pkg, status, dir }) {
  const sub = status === 'scheduled' ? 'approved' : 'published';
  const img = (pkg.image?.files || [])[0];
  const imgUrl = img ? `${RAW}/${dir}/${sub}/${img}` : null;
  const badge =
    status === 'scheduled'
      ? `<span class="badge up">Scheduled &middot; ${weekday(pkg.date)} ${prettyDate(pkg.date)}</span>`
      : `<span class="badge done">Published &middot; ${prettyDate(pkg.date)}</span>`;
  const text = pkg.facebook?.text || pkg.linkedin?.text || '';
  return `<div class="card${status === 'published' ? ' pub' : ''}">
    ${imgUrl ? `<a href="${imgUrl}" target="_blank"><img loading="lazy" src="${imgUrl}" alt="${esc(pkg.image?.alt || '')}"></a>` : ''}
    <div class="body">
      <div class="meta">${badge}<span class="plats">${chips(pkg).join(' &middot; ')}</span></div>
      <p>${esc(text).replace(/\n/g, '<br>')}</p>
    </div>
  </div>`;
}

function brandSection(b) {
  const today = todayET();
  const approved = loadDir(`${b.dir}/approved`, 'scheduled').sort((x, y) => x.pkg.date.localeCompare(y.pkg.date));
  const published = loadDir(`${b.dir}/published`, 'published')
    .sort((x, y) => y.pkg.date.localeCompare(x.pkg.date))
    .slice(0, 6);
  const upcoming = approved.filter((e) => e.pkg.date >= today);
  const overdue = approved.filter((e) => e.pkg.date < today);
  return `<section id="${b.key}">
    <h2 style="--accent:${b.accent}">${b.name}</h2>
    <div class="count">${upcoming.length} post${upcoming.length === 1 ? '' : 's'} scheduled</div>
    ${upcoming.length ? `<div class="grid">${upcoming.map(card).join('\n')}</div>` : '<p class="empty">Nothing queued.</p>'}
    ${overdue.length ? `<h3>Awaiting publish (past-dated)</h3><div class="grid">${overdue.map(card).join('\n')}</div>` : ''}
    ${published.length ? `<details><summary>Recently published (${published.length})</summary><div class="grid">${published.map(card).join('\n')}</div></details>` : ''}
  </section>`;
}

const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Bequest Social — Post Preview</title>
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
h2{font-size:20px;border-left:5px solid var(--accent,#888);padding-left:12px;margin:38px 0 4px}
h3{font-size:14px;color:#a05a2c;margin:26px 0 10px}
.count{font-size:13px;color:#667;margin-bottom:16px;padding-left:17px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}
.card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.card img{width:100%;aspect-ratio:1;object-fit:cover;display:block}
.card .body{padding:12px 14px 16px}
.card p{font-size:13px;line-height:1.5;margin:10px 0 0;white-space:normal}
.meta{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.badge{font-size:11px;font-weight:700;letter-spacing:.04em;padding:4px 9px;border-radius:6px}
.badge.up{background:#e8f0e9;color:#1e5c31}
.badge.done{background:#eee;color:#666}
.plats{font-size:11px;color:#889}
.card.pub{opacity:.75}
details{margin-top:20px}
summary{cursor:pointer;font-size:14px;font-weight:600;color:#556;margin-bottom:12px}
.empty{color:#889;font-size:14px;padding-left:17px}
footer{text-align:center;font-size:12px;color:#99a;padding:30px}
</style></head><body>
<header>
  <h1>Upcoming Social Posts</h1>
  <p>Everything queued for auto-publish, exactly as it will appear. Updates automatically after every generation and publish run. Last built: ${now} ET.</p>
  <nav>${BRANDS.map((b) => `<a href="#${b.key}">${b.name}</a>`).join('')}</nav>
</header>
<main>
${BRANDS.map(brandSection).join('\n')}
</main>
<footer>Bequest Digital · autonomous publishing pipeline · <a href="https://github.com/${REPO}">repo</a></footer>
</body></html>`;

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'index.html'), html);
console.log(`docs/index.html built (${BRANDS.map((b) => b.name).join(', ')})`);
