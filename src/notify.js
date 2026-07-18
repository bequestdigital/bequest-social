// GitHub issue notifications: failure reports and the weekly publish summary.
//
// Usage:
//   node src/notify.js issue --title "..." --body "..."      # open an issue
//   node src/notify.js issue --title "..." --body-file f.md
//   node src/notify.js summary                               # weekly summary issue
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY
import fs from 'node:fs';
import path from 'node:path';
import { PUBLISHED, ghApi, todayET, addDays, weekdayOf } from './util.js';

export async function openIssue(title, body, labels = ['automation']) {
  const issue = await ghApi('/repos/{repo}/issues', {
    method: 'POST',
    body: { title, body, labels },
  });
  console.log(`Opened issue #${issue.number}: ${title}`);
  return issue;
}

async function weeklySummary() {
  // The Monday of the current ET week.
  let monday = todayET();
  while (weekdayOf(monday) !== 1) monday = addDays(monday, -1);
  const friday = addDays(monday, 4);

  const files = fs.existsSync(PUBLISHED)
    ? fs
        .readdirSync(PUBLISHED)
        .filter((f) => f.endsWith('.json'))
        .filter((f) => {
          const d = f.replace('.json', '');
          return d >= monday && d <= friday;
        })
        .sort()
    : [];

  const lines = [`Publishing summary for the week of **${monday}**.`, ''];
  if (!files.length) {
    lines.push('_No posts were published this week._');
  } else {
    for (const f of files) {
      const pkg = JSON.parse(fs.readFileSync(path.join(PUBLISHED, f), 'utf8'));
      lines.push(`### ${pkg.date} — ${pkg.type}: ${pkg.hook}`);
      for (const [key, name] of [['fb', 'Facebook'], ['ig', 'Instagram'], ['x', 'X']]) {
        const r = pkg.results?.[key];
        lines.push(`- ${name}: ${r?.ok ? `✅ \`${r.id}\`` : r ? `❌ ${r.error}` : '— not attempted'}`);
      }
      lines.push('');
    }
  }
  await openIssue(`Weekly summary — week of ${monday}`, lines.join('\n'), ['automation', 'summary']);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'summary') return weeklySummary();
  if (cmd === 'issue') {
    const a = process.argv.slice(3);
    let title = 'Automation notification';
    let body = '';
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--title') title = a[++i];
      else if (a[i] === '--body') body = a[++i];
      else if (a[i] === '--body-file') body = fs.readFileSync(a[++i], 'utf8');
    }
    return openIssue(title, body);
  }
  console.error('Usage: node src/notify.js issue|summary ...');
  process.exit(1);
}

// Only run main() when invoked directly (publish.js imports openIssue).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
