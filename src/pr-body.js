// Build the weekly review PR body from a generation manifest: full copy for
// every platform plus embedded images, so approval happens entirely in the PR.
//
// Usage: BRANCH=posts/week-of-X node src/pr-body.js manifest.json > pr-body.md
import path from 'node:path';
import { ROOT, readJSON } from './util.js';

const manifest = readJSON(path.resolve(process.argv[2]));
const repo = process.env.GITHUB_REPOSITORY || 'OWNER/REPO';
const branch = process.env.BRANCH || 'main';

const out = [];
out.push(`Generated posts for the week of **${manifest.week_of}** (Week ${manifest.week} — ${manifest.theme}).`);
out.push('');
out.push('**Merging this PR approves all posts below.** To edit copy, edit the JSON file in this branch. To reject a single slot, delete its JSON + image files from the branch before merging.');
out.push('');

for (const rel of manifest.files) {
  const pkg = readJSON(path.join(ROOT, rel));
  out.push('---');
  out.push(`## ${pkg.date} — ${pkg.type}: ${pkg.hook}`);
  out.push('');
  for (const img of pkg.image.files || []) {
    out.push(`<img src="https://github.com/${repo}/blob/${branch}/content/queue/${img}?raw=true" width="420" alt="${(pkg.image.alt || '').replace(/"/g, '&quot;')}">`);
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
