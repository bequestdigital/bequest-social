// Continue the editorial calendar past the end of the hand-written one.
//
// The Q3 calendar (bequest-social-calendar-q3.md) ends 2026-10-16. From then on,
// each Sunday this planner asks Claude for the coming week's Mon/Wed/Fri entries
// in the same shape the parser produces ({date, weekday, week, weekTheme, type,
// hook, direction}), steered by content/strategy.json — what has actually
// performed — and writes them to content/calendar-extension.json. generate.js
// merges that file with calendar.json, so the rest of the pipeline is unchanged.
//
// Usage:
//   node src/plan.js                       # plan the 7 days after today if nothing is scheduled
//   node src/plan.js --week-of 2026-10-25  # plan the 7 days after that date
//   node src/plan.js --force               # re-plan even if entries exist (replaces them)
//
// Guard rails:
//   - Types are drawn from WHY/TIP/POV/ASK. PROOF (and any direction asking for
//     a stat graphic) is only allowed on a date that already has
//     content/evidence/<date>.json — the planner is told which dates qualify.
//   - Hooks and directions are ideas, not facts: the output is rejected if it
//     contains a percentage, a dollar figure, or a "study/survey/research" claim.
//   - Hooks must not repeat anything already published or already planned.
//   - Hand-written calendar entries always win over planned ones for a date.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT, PUBLISHED, readJSON, writeJSON, todayET, addDays, weekdayOf, nextMonday, retry } from './util.js';

const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
export const EXTENSION_FILE = path.join(CONTENT, 'calendar-extension.json');
const CALENDAR_FILE = path.join(CONTENT, 'calendar.json');
const STRATEGY_FILE = path.join(CONTENT, 'strategy.json');
const EVIDENCE_DIR = path.join(CONTENT, 'evidence');
const POST_DAYS = [1, 3, 5]; // Mon / Wed / Fri
const TYPES = ['WHY', 'TIP', 'POV', 'ASK'];
const TEMPLATES = ['quote-card', 'tip-card', 'carousel', 'diagram'];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--week-of' && a[i + 1]) out.weekOf = a[++i];
    else if (a[i] === '--force') out.force = true;
  }
  if (!out.weekOf) delete out.weekOf;
  return out;
}

export function loadExtension() {
  return fs.existsSync(EXTENSION_FILE) ? readJSON(EXTENSION_FILE) : { posts: [] };
}

// All calendar entries, hand-written first, planned ones filling gaps.
export function mergedCalendarPosts() {
  const cal = fs.existsSync(CALENDAR_FILE) ? readJSON(CALENDAR_FILE) : { posts: [] };
  const ext = loadExtension();
  const seen = new Set(cal.posts.map((p) => p.date));
  const extra = (ext.posts || []).filter((p) => !seen.has(p.date));
  return [...cal.posts, ...extra].sort((a, b) => a.date.localeCompare(b.date));
}

function recentHooks(n = 18) {
  const hooks = [];
  if (fs.existsSync(PUBLISHED)) {
    for (const f of fs.readdirSync(PUBLISHED).filter((f) => f.endsWith('.json')).sort().slice(-n)) {
      try {
        const p = readJSON(path.join(PUBLISHED, f));
        if (p.hook) hooks.push(`${p.date} ${p.type}: ${p.hook}`);
      } catch {
        /* skip */
      }
    }
  }
  for (const p of loadExtension().posts || []) hooks.push(`${p.date} ${p.type}: ${p.hook} (planned)`);
  return hooks.slice(-n - 6);
}

function evidenceDates(dates) {
  return dates.filter((d) => fs.existsSync(path.join(EVIDENCE_DIR, `${d}.json`)));
}

function calendarVoice() {
  const cal = fs.existsSync(CALENDAR_FILE) ? readJSON(CALENDAR_FILE) : {};
  const header = (cal.meta?.headerLines || []).join('\n');
  const notes = cal.meta?.standingNotes || cal.meta?.notes || '';
  return { header, notes: typeof notes === 'string' ? notes : JSON.stringify(notes) };
}

function validatePlan(plan, dates, evidence) {
  const errors = [];
  if (!plan?.weekTheme || typeof plan.weekTheme !== 'string') errors.push('weekTheme missing');
  if (!Array.isArray(plan?.posts) || plan.posts.length !== dates.length) errors.push(`expected ${dates.length} posts`);
  const banned = /\b\d+(\.\d+)?\s?%|\$\s?\d|\b(study|survey|research|statistic|stat\b|data shows|according to)\b/i;
  for (const [i, p] of (plan?.posts || []).entries()) {
    if (p.date !== dates[i]) errors.push(`post ${i} date ${p.date} should be ${dates[i]}`);
    const allowed = evidence.includes(p.date) ? [...TYPES, 'PROOF'] : TYPES;
    if (!allowed.includes(p.type)) errors.push(`post ${p.date}: type ${p.type} not allowed (${allowed.join('/')})`);
    if (!p.hook?.trim() || p.hook.length > 140) errors.push(`post ${p.date}: hook missing or >140 chars`);
    if (!p.direction?.trim() || p.direction.length > 400) errors.push(`post ${p.date}: direction missing or >400 chars`);
    const text = `${p.hook} ${p.direction}`;
    if (banned.test(text)) errors.push(`post ${p.date}: contains a figure or research claim (${text.match(banned)[0]})`);
    if (!evidence.includes(p.date) && /\bstat\s?(card|graphic)\b/i.test(p.direction)) errors.push(`post ${p.date}: stat graphic needs evidence`);
    if (!TEMPLATES.some((t) => new RegExp(t.replace('-', '[ -]?'), 'i').test(p.direction)) && !/\b(wireframe|side-by-side|comparison|checklist|numbered list|quote)\b/i.test(p.direction)) {
      errors.push(`post ${p.date}: direction must name the graphic (${TEMPLATES.join(', ')})`);
    }
  }
  return errors;
}

async function askClaude(prompt, system, previousErrors) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  let user = prompt;
  if (previousErrors?.length) user += `\n\nYour previous attempt failed validation — fix these:\n- ${previousErrors.join('\n- ')}`;
  return retry(
    async () => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, temperature: 0.5, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) {
        const err = new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      const data = await res.json();
      const text = (data.content || []).map((c) => c.text || '').join('').trim();
      return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    },
    { label: 'plan', attempts: 3 }
  );
}

export async function planWeek(base, { force = false } = {}) {
  // Same window generate.js uses: the 7 days after `base`, on posting days.
  // From the Sunday cron that is Mon/Wed/Fri of the coming week.
  const window = [1, 2, 3, 4, 5, 6, 7].map((n) => addDays(base, n)).filter((d) => POST_DAYS.includes(weekdayOf(d)));
  const scheduled = new Set(mergedCalendarPosts().map((p) => p.date));
  const dates = force ? window : window.filter((d) => !scheduled.has(d));
  if (!dates.length) {
    console.log(`Every posting day in the week after ${base} already has a calendar entry — nothing to plan.`);
    return null;
  }
  const monday = nextMonday(addDays(base, 1));
  const cal = fs.existsSync(CALENDAR_FILE) ? readJSON(CALENDAR_FILE) : { posts: [] };
  const lastWeekNo = Math.max(0, ...mergedCalendarPosts().map((p) => p.week || 0));
  const weekNo = lastWeekNo + 1;
  const strategy = fs.existsSync(STRATEGY_FILE) ? readJSON(STRATEGY_FILE) : null;
  const evidence = evidenceDates(dates);
  const voice = calendarVoice();

  const system = `You plan the coming week of organic social posts for Bequest Digital LLC, a two-person digital marketing agency. You continue an existing 13-week calendar in its exact format and editorial voice. You produce hooks and directions only; a separate writer turns them into copy and a separate renderer makes the graphic.
Rules you cannot break:
- Post types: ${TYPES.join(', ')}${evidence.length ? `, plus PROOF only on ${evidence.join(', ')}` : ''}. Never PROOF, testimonial, case study, client result or "their words" on any other date.
- Hooks and directions must contain no numbers presented as facts: no percentages, dollar figures, benchmarks, studies, surveys or "research shows". Counts in a title ("3 questions") are fine.
- Each direction must name the graphic: quote card, tip card (checklist / numbered list), carousel, diagram (wireframe / side-by-side / comparison), or ig-native (Instagram-native look - casual, like a person typed it in the app; best for short punchy lines, wry observations and ASK questions; at most one ig-native per week). Never a stat card or stat graphic unless the date has evidence.
- No hook may restate a hook already used (list provided). Vary the angle, not just the words.
- Keep the audience register: churches, Christian businesses, small-to-mid nonprofits, owners who'd rather build than market. Plain speech, ownership, craftsmanship, permanence, stewardship. Faith natural, never performative. Never partisan.
Return ONLY a JSON object: {"weekTheme": "<3-6 words>", "posts": [{"date": "YYYY-MM-DD", "type": "...", "hook": "<=140 chars, the first line of the post>", "direction": "<=400 chars: angle, what to cover, and the graphic>"}]}`;

  const prompt = `Original calendar framing (for voice and audience):
${voice.header}

Standing notes from the original calendar:
${voice.notes.slice(0, 2500)}

Filler bank from the calendar (good seams to mine): "Marketing terms in one sentence" series; platform-change reactions; one-post book summaries (Start With Why, Building a StoryBrand, Ogilvy); "questions we get from churches" mini-series.

Week ${weekNo} dates (${dates.map((d) => `${WEEKDAY[weekdayOf(d)]} ${d}`).join(', ')}). Recent weekly themes: ${[...new Set(cal.posts.slice(-9).map((p) => p.weekTheme))].join(' · ')}.

Performance strategy from our own analytics (follow it; sample sizes are small, so treat it as a lean, not a law):
${strategy ? JSON.stringify({ weights: strategy.weights, guidance: strategy.guidance, coach_notes: strategy.coach_notes, operator_notes: strategy.operator_notes, top_hooks: strategy.top_hooks, bottom_hooks: strategy.bottom_hooks }, null, 1) : 'none yet — keep a balanced TIP/POV mix with one WHY or ASK.'}

Hooks already used (do not repeat):
${recentHooks().map((h) => `- ${h}`).join('\n')}

Plan the three posts. Use the type weights to choose the mix (higher weight = more of it), the template weights to choose graphics, and the coach instructions to shape hooks. ASK posts should not exceed one per week.`;

  let errors = [];
  let plan;
  for (let attempt = 1; attempt <= 3; attempt++) {
    plan = await askClaude(prompt, system, errors);
    errors = validatePlan(plan, dates, evidence);
    if (!errors.length) break;
    console.log(`  plan attempt ${attempt} rejected: ${errors.join(' | ')}`);
  }
  if (errors.length) throw new Error(`Planner could not produce a valid week: ${errors.join(' | ')}`);

  const posts = plan.posts.map((p) => ({
    id: p.date,
    date: p.date,
    weekday: WEEKDAY[weekdayOf(p.date)],
    week: weekNo,
    weekTheme: plan.weekTheme,
    type: p.type,
    hook: p.hook.trim(),
    direction: p.direction.trim(),
    planned: { at: new Date().toISOString(), model: MODEL, strategy_updated_at: strategy?.updated_at || null },
  }));
  const ext = loadExtension();
  ext.posts = [...(ext.posts || []).filter((p) => !dates.includes(p.date)), ...posts].sort((a, b) => a.date.localeCompare(b.date));
  ext.updated_at = new Date().toISOString();
  writeJSON(EXTENSION_FILE, ext);
  console.log(`Planned week ${weekNo} "${plan.weekTheme}": ${posts.map((p) => `${p.date} ${p.type}`).join(', ')}`);
  for (const p of posts) console.log(`  ${p.date} ${p.type}: ${p.hook}`);
  return posts;
}

async function main() {
  const opts = parseArgs();
  await planWeek(opts.weekOf || todayET(), { force: !!opts.force });
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
