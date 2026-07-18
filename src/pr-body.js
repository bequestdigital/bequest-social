// Build the weekly heads-up body (full copy for every platform + embedded
// images). In zero-touch mode this is posted as an FYI GitHub issue so you can
// see — and veto — the week's posts, but no action is required for them to run.
//
// Usage: GITHUB_REPOSITORY=owner/repo [IMG_REF=main] [IMG_DIR=content/approved] \
//          node src/pr-body.js manifest.json > week-body.md
import path from 'node:path';
import { ROOT, readJSON } from './util.js';

const manifest = readJSON(path.resolve(process.argv[2]));
const repo = process.env.GITHUB_REPOSITORY || 'OWNER/REPO';
// Where the committed images live (branch/ref + directory) for <img> previews.
const imgRef = process.env.IMG_REF || 'main';
const imgDir = process.env.IMG_DIR || 'content/approved';

const out = [];
out.push(`Auto-approved posts for the week of **${manifest.week_of}** (Week ${manifest.week} — ${manifest.theme}).`);
out.push('');
out.push('**No action needed — these publish automatically** on their Mon/Wed/Fri 9am ET slots. To pull or edit one, delete or edit its file under `content/approved/` before its publish day.');
out.push('');

for (const rel of manifest.files) {
  const pkg = readJSON(path.join(ROOT, rel));
  out.push('---');
  out.push(`## ${pkg.date} — ${pkg.type}: ${pkg.hook}`);
  out.push('');
  for (const img of pkg.image.files || []) {
    out.push(`<img src="https://raw.githubusercontent.com/${repo}/${imgRef}/${imgDir}/${img}" width="420" alt="${(pkg.image.alt || '').replace(/"/g, '&quot;')}">`);
  }
  out.push('');
  out.push('### Facebook');
  out.push('```');
  out.push(pkg.facebook.text);
  out.push('```');
  out.push('### Instagram');
  out.push('```');
  out.push(pkg.instagram.text);
  out.push('');
  out.push(pkg.instagram.hashtags.map((t) => '#' + t).join(' '));
  out.push('```');
  out.push(`### X ${pkg.x.posts.length > 1 ? `(thread of ${pkg.x.posts.length})` : ''}`);
  for (const p of pkg.x.posts) {
    out.push('```');
    out.push(p);
    out.push('```');
  }
  out.push('');
}
out.push(`_Model: ${manifest.files.length ? readJSON(path.join(ROOT, manifest.files[0])).meta.model : 'n/a'} · tokens used: ${manifest.tokens_used ?? 'n/a'}_`);

console.log(out.join('\n'));
