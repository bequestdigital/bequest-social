// Turn the per-post metrics in content/<brand>/analytics/posts/ into:
//   content/<brand>/analytics/summary.json   scored posts + roll-ups by type/template/weekday
//   content/<brand>/strategy.json            what next week's planner and generator read
//
// Usage:
//   node src/strategy.js              # rebuild summary + strategy
//   node src/strategy.js --no-coach   # skip the Claude coaching pass (no ANTHROPIC_API_KEY needed)
//   node src/strategy.js --digest     # also print a markdown digest to stdout
//
// Scoring (documented so the numbers mean the same thing every run):
//   A post is "matured" once it was at least 3 days old when last fetched.
//   For each channel with numbers, two ratios are taken against the channel's
//   median across matured posts: engagement/median_engagement and
//   reach/median_reach (reach falls back to impressions, then views).
//   A channel's score is the mean of its available ratios; the post score is
//   the mean across channels. 1.0 = a typical post; 2.0 = twice a typical post.
//   Roll-ups report n, mean score and the spread. A bucket with fewer than
//   MIN_N posts is shown but flagged `signal: false` and is never allowed to
//   move a weight on its own.
//
// Weights: each type/template weight is the bucket's mean score shrunk toward
//   1.0 by n/(n+3), then clamped to [0.4, 2.0]. PROOF and stat-card are pinned
//   to 0 — they need human-supplied evidence (content/evidence/<date>.json) and
//   the planner only ever schedules them when such a file exists.
//
// The coaching pass asks Claude for a short reading of the summary and a few
// concrete instructions for next week's posts. It can only shape tone, type
// mix, template choice and hook style; it is told it cannot introduce facts,
// figures or client claims, and the generator keeps its own evidence gate.
// `operator_notes` is never touched by code: it is the standing instruction
// from a human (or from Claude Code during a review) and survives every rebuild.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT, BRAND, readJSON, writeJSON, retry } from './util.js';
import { ANALYTICS, ANALYTICS_POSTS } from './insights.js';

const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const MIN_N = 3;
const EVIDENCE_GATED_TYPES = ['PROOF'];
const EVIDENCE_GATED_TEMPLATES = ['stat-card'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const STRATEGY_FILE = path.join(CONTENT, 'strategy.json');
export const SUMMARY_FILE = path.join(ANALYTICS, 'summary.json');

function parseArgs() {
  const a = process.argv.slice(2);
  return { coach: !a.includes('--no-coach'), digest: a.includes('--digest') };
}

function loadRecords() {
  if (!fs.existsSync(ANALYTICS_POSTS)) return [];
  return fs
    .readdirSync(ANALYTICS_POSTS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(ANALYTICS_POSTS, f)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function median(nums) {
  const s = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(nums) {
  const s = nums.filter((n) => typeof n === 'number' && Number.isFinite(n));
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
}
function round(n, d = 2) {
  return n == null ? null : Math.round(n * 10 ** d) / 10 ** d;
}
function reachOf(c) {
  return c?.reach ?? c?.impressions ?? c?.views ?? null;
}

function hookFeatures(hook = '') {
  const h = String(hook);
  return {
    words: h.trim().split(/\s+/).filter(Boolean).length,
    question: /\?/.test(h),
    second_person: /\byou(r)?\b/i.test(h),
    names_framework: /\b(sinek|storybrand|golden circle|ogilvy)\b/i.test(h),
    contrast: /\b(not|instead|but|rather than|stop)\b/i.test(h),
  };
}

export function buildSummary(records) {
  const matured = records.filter((r) => r.matured);
  const channels = ['fb', 'ig', 'x'];
  const medians = {};
  for (const ch of channels) {
    const rows = matured.map((r) => r.channels?.[ch]).filter((c) => c && !c.error);
    medians[ch] = {
      n: rows.length,
      engagement: median(rows.map((c) => c.engagement)),
      reach: median(rows.map(reachOf)),
    };
  }

  const scored = matured.map((r) => {
    const per = {};
    for (const ch of channels) {
      const c = r.channels?.[ch];
      if (!c || c.error) continue;
      const m = medians[ch];
      const ratios = [];
      if (m.engagement > 0 && typeof c.engagement === 'number') ratios.push(c.engagement / m.engagement);
      const reach = reachOf(c);
      if (m.reach > 0 && typeof reach === 'number') ratios.push(reach / m.reach);
      if (ratios.length) per[ch] = round(mean(ratios));
    }
    const score = round(mean(Object.values(per)));
    return {
      date: r.date,
      weekday: WEEKDAYS[r.weekday],
      type: r.type,
      template: r.template,
      hook: r.hook,
      score,
      channel_scores: per,
      engagement: Object.fromEntries(channels.filter((ch) => r.channels?.[ch] && !r.channels[ch].error).map((ch) => [ch, r.channels[ch].engagement])),
      reach: Object.fromEntries(channels.filter((ch) => r.channels?.[ch] && !r.channels[ch].error).map((ch) => [ch, reachOf(r.channels[ch])])),
      features: hookFeatures(r.hook),
      age_days: r.age_days_at_fetch,
    };
  });

  const bucket = (key, fn) => {
    const groups = {};
    for (const s of scored) {
      if (s.score == null) continue;
      const k = fn(s);
      if (k == null) continue;
      (groups[k] ||= []).push(s.score);
    }
    return Object.fromEntries(
      Object.entries(groups)
        .map(([k, v]) => [k, { n: v.length, mean_score: round(mean(v)), min: round(Math.min(...v)), max: round(Math.max(...v)), signal: v.length >= MIN_N }])
        .sort((a, b) => (b[1].mean_score ?? 0) - (a[1].mean_score ?? 0))
    );
  };

  const ranked = scored.filter((s) => s.score != null).sort((a, b) => b.score - a.score);
  const latest = records.map((r) => r.fetched_at).filter(Boolean).sort().at(-1) || null;
  return {
    brand: BRAND,
    built_at: new Date().toISOString(),
    metrics_fetched_at: latest,
    posts_total: records.length,
    posts_matured: matured.length,
    posts_scored: ranked.length,
    channel_medians: medians,
    channel_coverage: Object.fromEntries(
      channels.map((ch) => [ch, { ok: records.filter((r) => r.channels?.[ch] && !r.channels[ch].error).length, error: records.filter((r) => r.channels?.[ch]?.error).length }])
    ),
    by_type: bucket('type', (s) => s.type),
    by_template: bucket('template', (s) => s.template),
    by_weekday: bucket('weekday', (s) => s.weekday),
    by_hook_feature: {
      question: bucket('q', (s) => (s.features.question ? 'question' : 'statement')),
      second_person: bucket('y', (s) => (s.features.second_person ? 'addresses_you' : 'impersonal')),
      names_framework: bucket('f', (s) => (s.features.names_framework ? 'names_framework' : 'no_framework')),
      contrast: bucket('c', (s) => (s.features.contrast ? 'contrast_hook' : 'plain_hook')),
      length: bucket('l', (s) => (s.features.words <= 8 ? 'short_<=8w' : s.features.words <= 14 ? 'mid_9-14w' : 'long_15w+')),
    },
    top_posts: ranked.slice(0, 5),
    bottom_posts: ranked.slice(-5).reverse(),
    recent: scored.filter((s) => s.score != null).slice(-6).reverse(),
    scoring: 'score = mean over channels of mean(engagement/median_engagement, reach/median_reach); medians over matured posts (>=3 days old). 1.0 = typical.',
  };
}

function weightsFrom(buckets, pinned) {
  const out = {};
  for (const [k, b] of Object.entries(buckets)) {
    if (pinned.includes(k)) {
      out[k] = 0;
      continue;
    }
    const shrink = b.n / (b.n + 3);
    const w = 1 + ((b.mean_score ?? 1) - 1) * shrink;
    out[k] = round(Math.min(2, Math.max(0.4, w)));
  }
  for (const k of pinned) out[k] = 0;
  return out;
}

function ruleGuidance(summary) {
  const g = [];
  const sig = (b) => Object.entries(b).filter(([, v]) => v.signal);
  const types = sig(summary.by_type);
  if (types.length >= 2) {
    const [best, worst] = [types[0], types.at(-1)];
    if (best[1].mean_score - worst[1].mean_score >= 0.3) {
      g.push(`${best[0]} posts outperform ${worst[0]} posts (${best[1].mean_score} vs ${worst[1].mean_score}, n=${best[1].n}/${worst[1].n}). Lean the week toward ${best[0]}; keep ${worst[0]} but make it earn its slot.`);
    }
  }
  const tpls = sig(summary.by_template);
  if (tpls.length >= 2) {
    const [best, worst] = [tpls[0], tpls.at(-1)];
    if (best[1].mean_score - worst[1].mean_score >= 0.3) {
      g.push(`${best[0]} graphics score ${best[1].mean_score} vs ${worst[1].mean_score} for ${worst[0]}. Prefer ${best[0]} where the content allows.`);
    }
  }
  const days = sig(summary.by_weekday);
  if (days.length >= 2 && days[0][1].mean_score - days.at(-1)[1].mean_score >= 0.3) {
    g.push(`${days[0][0]} posts do best (${days[0][1].mean_score}); ${days.at(-1)[0]} weakest (${days.at(-1)[1].mean_score}). Put the strongest hook of the week on ${days[0][0]}.`);
  }
  for (const [name, b] of Object.entries(summary.by_hook_feature)) {
    const rows = sig(b);
    if (rows.length === 2 && Math.abs(rows[0][1].mean_score - rows[1][1].mean_score) >= 0.3) {
      g.push(`Hooks that are "${rows[0][0]}" beat "${rows[1][0]}" (${rows[0][1].mean_score} vs ${rows[1][1].mean_score}).`);
    }
  }
  if (!g.length) g.push('No bucket shows a clear, well-sampled gap yet. Keep the mix balanced and let the sample grow.');
  return g;
}

async function coach(summary, previous) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY not set — skipping coaching notes.');
    return previous?.coach_notes || null;
  }
  const trimmed = {
    posts_scored: summary.posts_scored,
    channel_medians: summary.channel_medians,
    by_type: summary.by_type,
    by_template: summary.by_template,
    by_weekday: summary.by_weekday,
    by_hook_feature: summary.by_hook_feature,
    top_posts: summary.top_posts.map((p) => ({ date: p.date, type: p.type, template: p.template, score: p.score, hook: p.hook })),
    bottom_posts: summary.bottom_posts.map((p) => ({ date: p.date, type: p.type, template: p.template, score: p.score, hook: p.hook })),
    recent: summary.recent.map((p) => ({ date: p.date, type: p.type, template: p.template, score: p.score, hook: p.hook })),
    previous_notes: previous?.coach_notes || null,
    operator_notes: previous?.operator_notes || null,
  };
  const system = `You are the performance coach for Bequest Digital's organic social pipeline (churches, Christian businesses, small nonprofits; plain, craftsman voice; no hype).
You read a scored summary of recent posts and write instructions for next week's content planner and copywriter.
Hard limits: you may shape topic emphasis, post-type mix, graphic template choice, hook style, length and tone. You may NOT introduce facts, statistics, client names, results, quotes or any claim about the world — the writers are forbidden from using numbers that a human has not supplied, and so are you. Treat any bucket with signal:false as anecdote, not evidence. If the sample is thin, say so and recommend the smallest change worth making. Prefer two or three concrete, testable instructions over a list of ten. Plain prose, no bullet symbols, no em dashes, under 140 words.
Return ONLY a JSON object: {"reading": "<2-3 sentences on what the numbers show>", "instructions": ["<concrete instruction>", "..."], "test_next": "<one thing to deliberately try next week to learn something>"}`;
  const body = {
    model: MODEL,
    max_tokens: 700,
    temperature: 0.3,
    system,
    messages: [{ role: 'user', content: `Performance summary (JSON):\n${JSON.stringify(trimmed, null, 1)}` }],
  };
  const text = await retry(
    async () => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      const data = await res.json();
      return data.content?.map((c) => c.text || '').join('') || '';
    },
    { label: 'coach', attempts: 3 }
  );
  const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(json);
  if (!parsed.reading || !Array.isArray(parsed.instructions)) throw new Error('coach returned an unexpected shape');
  // Belt and braces: the coach's text must not smuggle in numbers that look like claims.
  const flat = [parsed.reading, ...parsed.instructions, parsed.test_next || ''].join(' ');
  if (/\b\d+(\.\d+)?\s?%|\$\s?\d/.test(flat)) throw new Error(`coach notes contain a percentage or dollar figure: ${flat.slice(0, 120)}`);
  return { ...parsed, model: MODEL, at: new Date().toISOString() };
}

export function buildDigest(summary, strategy) {
  const L = [];
  L.push(`**${summary.posts_scored} scored posts** (of ${summary.posts_total} published; ${summary.posts_matured} matured). Metrics fetched ${summary.metrics_fetched_at || 'never'}.`);
  L.push('');
  const med = summary.channel_medians;
  L.push(`Typical post (median): FB ${med.fb?.engagement ?? '—'} eng / ${med.fb?.reach ?? '—'} reach · IG ${med.ig?.engagement ?? '—'} eng / ${med.ig?.reach ?? '—'} reach · X ${med.x?.engagement ?? '—'} eng / ${med.x?.reach ?? '—'} impr.`);
  L.push('');
  const tbl = (title, b) => {
    L.push(`**${title}**`);
    L.push('| bucket | n | mean score | signal |', '|---|---|---|---|');
    for (const [k, v] of Object.entries(b)) L.push(`| ${k} | ${v.n} | ${v.mean_score} | ${v.signal ? 'yes' : 'thin'} |`);
    L.push('');
  };
  tbl('By post type', summary.by_type);
  tbl('By graphic template', summary.by_template);
  tbl('By weekday', summary.by_weekday);
  L.push('**Top posts**');
  for (const p of summary.top_posts) L.push(`- ${p.date} ${p.type}/${p.template} · score ${p.score} · "${p.hook}"`);
  L.push('', '**Bottom posts**');
  for (const p of summary.bottom_posts) L.push(`- ${p.date} ${p.type}/${p.template} · score ${p.score} · "${p.hook}"`);
  L.push('');
  if (strategy) {
    L.push('**Rule-based guidance**');
    for (const g of strategy.guidance) L.push(`- ${g}`);
    L.push('');
    if (strategy.coach_notes) {
      L.push('**Coach reading**', strategy.coach_notes.reading, '');
      L.push('**Instructions for next week**');
      for (const i of strategy.coach_notes.instructions) L.push(`- ${i}`);
      if (strategy.coach_notes.test_next) L.push(`- Test next: ${strategy.coach_notes.test_next}`);
      L.push('');
    }
    if (strategy.operator_notes) L.push('**Operator notes (human)**', strategy.operator_notes, '');
    L.push(`Weights → type: ${JSON.stringify(strategy.weights.type)} · template: ${JSON.stringify(strategy.weights.template)}`);
  }
  L.push('', `_Scoring: ${summary.scoring}_`);
  return L.join('\n');
}

export async function main() {
  const opts = parseArgs();
  const records = loadRecords();
  if (!records.length) {
    console.log(`[${BRAND}] no analytics records yet — run insights.js first.`);
    return;
  }
  const summary = buildSummary(records);
  writeJSON(SUMMARY_FILE, summary);
  console.log(`[${BRAND}] summary: ${summary.posts_scored} scored of ${summary.posts_total}; medians ${JSON.stringify(summary.channel_medians)}`);

  const previous = fs.existsSync(STRATEGY_FILE) ? readJSON(STRATEGY_FILE) : {};
  const guidance = ruleGuidance(summary);
  let coachNotes = previous.coach_notes || null;
  if (opts.coach && BRAND === 'bequest') {
    try {
      coachNotes = await coach(summary, previous);
      console.log(`coach: ${coachNotes?.reading}`);
    } catch (e) {
      console.log(`::warning title=Coaching pass skipped::${e.message}`);
    }
  }
  const strategy = {
    brand: BRAND,
    updated_at: new Date().toISOString(),
    sample: { scored: summary.posts_scored, matured: summary.posts_matured, total: summary.posts_total },
    weights: {
      type: weightsFrom(summary.by_type, EVIDENCE_GATED_TYPES),
      template: weightsFrom(summary.by_template, EVIDENCE_GATED_TEMPLATES),
    },
    best_weekday: Object.entries(summary.by_weekday).find(([, v]) => v.signal)?.[0] || null,
    guidance,
    coach_notes: coachNotes,
    operator_notes: previous.operator_notes || null,
    top_hooks: summary.top_posts.map((p) => p.hook),
    bottom_hooks: summary.bottom_posts.map((p) => p.hook),
    evidence_gated: { types: EVIDENCE_GATED_TYPES, templates: EVIDENCE_GATED_TEMPLATES },
  };
  writeJSON(STRATEGY_FILE, strategy);
  console.log(`strategy written: weights ${JSON.stringify(strategy.weights)}`);
  if (opts.digest) {
    console.log('\n' + buildDigest(summary, strategy));
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
