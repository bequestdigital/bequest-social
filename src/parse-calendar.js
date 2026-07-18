// Parse the quarterly markdown editorial calendar into content/calendar.json.
// Usage: node src/parse-calendar.js [path-to-calendar.md]
// With no argument, uses the first *calendar*.md file in the repo root, so a
// future quarter's file can simply be dropped in and re-run.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CONTENT, writeJSON, weekdayOf } from './util.js';

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const POST_TYPES = new Set(['WHY', 'TIP', 'POV', 'PROOF', 'ASK']);

function findCalendarFile() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  const md = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith('.md') && /calendar/i.test(f))
    .sort();
  if (!md.length) throw new Error('No *calendar*.md file found in repo root.');
  return path.join(ROOT, md[0]);
}

function cleanHook(cell) {
  // Cell looks like: **"People don't give to what you do."**
  let s = cell.trim().replace(/^\*\*/, '').replace(/\*\*$/, '').trim();
  s = s.replace(/^["“]/, '').replace(/["”]$/, '');
  return s.trim();
}

function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');

  const title = (lines.find((l) => l.startsWith('# ')) || '').replace(/^#\s*/, '').trim();
  const runLine = (text.match(/\*\*Run:\*\*\s*(.+)/) || [])[1]?.trim() || '';
  const years = [...runLine.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (!years.length) throw new Error(`Could not find a year in the Run line: "${runLine}"`);
  const startYear = years[0];
  const endYear = years[years.length - 1];

  // Everything between the title and the first "## Week" heading is header meta.
  const firstWeekIdx = lines.findIndex((l) => /^## Week /.test(l));
  const headerLines = lines
    .slice(1, firstWeekIdx)
    .map((l) => l.trim())
    .filter((l) => l && l !== '---');

  // Standing Notes section, preserved raw.
  const notesIdx = lines.findIndex((l) => /^## Standing Notes/.test(l));
  const standingNotes =
    notesIdx >= 0 ? lines.slice(notesIdx + 1).join('\n').trim() : '';

  const weeks = [];
  const posts = [];
  let currentWeek = null;
  let firstMonth = null;

  for (const line of lines) {
    const weekMatch = line.match(/^## Week (\d+)\s*\(([^)]+)\)\s*[—–-]+\s*Theme:\s*(.+)$/);
    if (weekMatch) {
      currentWeek = {
        week: Number(weekMatch[1]),
        dateRange: weekMatch[2].trim(),
        theme: weekMatch[3].trim(),
      };
      weeks.push(currentWeek);
      continue;
    }
    if (/^## /.test(line)) {
      currentWeek = null; // e.g. Standing Notes
      continue;
    }
    if (!currentWeek || !line.trim().startsWith('|')) continue;

    const cells = line.split('|').map((c) => c.trim());
    // ['', 'Mon 7/20', 'WHY', '**"hook"**', 'direction', '']
    if (cells.length < 5) continue;
    const dateMatch = cells[1].match(/^(\w{3})\s+(\d{1,2})\/(\d{1,2})$/);
    if (!dateMatch) continue; // header or separator row

    const [, dayLabel, m, d] = dateMatch;
    const month = Number(m);
    if (firstMonth === null) firstMonth = month;
    // Quarters that cross a year boundary (e.g. Nov–Jan): months earlier than
    // the quarter's first month belong to the end year.
    const year = month >= firstMonth ? startYear : endYear;
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    const type = cells[2];
    if (!POST_TYPES.has(type)) {
      throw new Error(`Unknown post type "${type}" on ${iso} — expected one of ${[...POST_TYPES]}`);
    }

    posts.push({
      id: iso,
      date: iso,
      weekday: dayLabel,
      week: currentWeek.week,
      weekTheme: currentWeek.theme,
      type,
      hook: cleanHook(cells[3]),
      direction: cells[4],
    });
  }

  // Validate weekday labels against the computed calendar dates — catches
  // wrong-year assignment or typos in a future quarter's file.
  const problems = [];
  for (const p of posts) {
    if (weekdayOf(p.date) !== WEEKDAYS[p.weekday]) {
      problems.push(`${p.date} is labeled ${p.weekday} but falls on weekday index ${weekdayOf(p.date)}`);
    }
  }
  const seen = new Set();
  for (const p of posts) {
    if (seen.has(p.date)) problems.push(`duplicate date ${p.date}`);
    seen.add(p.date);
  }
  if (problems.length) {
    throw new Error('Calendar validation failed:\n  ' + problems.join('\n  '));
  }
  if (!posts.length) throw new Error('No posts parsed — check the markdown table format.');

  return {
    source: path.basename(file),
    parsed_at: new Date().toISOString(),
    title,
    run: runLine,
    meta: { headerLines, standingNotes },
    weeks,
    posts,
  };
}

const file = findCalendarFile();
const calendar = parse(file);
writeJSON(path.join(CONTENT, 'calendar.json'), calendar);

const byType = {};
for (const p of calendar.posts) byType[p.type] = (byType[p.type] || 0) + 1;
console.log(`Parsed ${calendar.posts.length} posts from ${calendar.source}`);
console.log(`  Weeks: ${calendar.weeks.length} (${calendar.posts[0].date} … ${calendar.posts.at(-1).date})`);
console.log(`  Types: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(' ')}`);
