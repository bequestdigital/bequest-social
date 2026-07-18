// Expand calendar entries into full post packages via the Anthropic API and
// write them to content/queue/YYYY-MM-DD.json, then render their images.
//
// Usage:
//   node src/generate.js                       # posts in the 7 days after today
//   node src/generate.js --week-of 2026-07-19  # posts in the 7 days after that date
//   node src/generate.js --date 2026-07-20     # a single post
//   node src/generate.js --manifest out.json   # also write a run manifest (used by CI)
//
// Env: ANTHROPIC_API_KEY (required), MODEL (default claude-sonnet-4-6),
//      TOKEN_BUDGET (max input+output tokens for the whole run, default 150000)
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import brand from '../brand.config.js';
import { CONTENT, QUEUE, ROOT, readJSON, writeJSON, todayET, addDays, retry, xLength } from './util.js';

const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const TOKEN_BUDGET = Number(process.env.TOKEN_BUDGET || 150000);
const MAX_OUTPUT_TOKENS = 3000;

// ---- voice spec (the calendar is editorial law; the model executes, it does not invent) ----
const SYSTEM_PROMPT = `You write organic social media posts for Bequest Digital LLC, a two-person digital marketing agency.

Audience: churches, Christian businesses, small-to-mid nonprofits, and small business owners who'd rather build than market. Mission-driven, stewardship-minded, skeptical of corporate marketing slop and Big Tech dependence. Values ownership, craftsmanship, permanence, plain speech.

Voice: plain, direct, conviction without preachiness. Faith references natural and occasional — stewardship, calling, service, permanence — never forced. Write like a craftsman, not a marketer. Banned vocabulary: "unlock," "supercharge," "game-changing," "elevate," "revolutionize," "seamless." No em-dash overuse, no "it's not X, it's Y" constructions.

Frameworks: Sinek's Golden Circle (Why → How → What) and StoryBrand (customer is the hero, we are the guide). Cite by name when the calendar entry does.

Every post implicitly builds the case for hiring Bequest; ASK posts do it explicitly.

Stay strictly inside the hook and direction from the calendar entry. The calendar is editorial law; your job is execution, not invention.

Return ONLY a valid JSON object. No markdown fences, no commentary.`;

const SCHEMA_INSTRUCTIONS = `Return a JSON object with exactly this shape:
{
  "facebook": { "text": "<post copy, hook as the first line, no hashtags, typically 60-150 words>" },
  "instagram": { "text": "<caption adapted for IG, no hashtags inline>", "hashtags": ["3-5 tags WITHOUT # signs, chosen ONLY from the approved list"] },
  "x": { "posts": ["<single post <=270 chars>"] },
  "image": { "template": "<one of: quote-card | tip-card | carousel | diagram | stat-card>", "data": { ... }, "alt": "<one-sentence image description>" }
}

X rules: one post of <=270 characters by default. Use a 2-3 item thread (array of 2-3 strings, each <=270 chars) only when the content genuinely warrants it. Hashtags: at most one, or none.

Image template selection: honor any graphic named in the calendar entry's Direction (e.g. "carousel" -> carousel, "quote card" -> quote-card, "stat card" -> stat-card, "diagram"/"wireframe"/"side-by-side"/"comparison" -> diagram, "checklist"/"numbered list"/"template card" -> tip-card).

Image data schemas (keep image text SHORT — it must fit a 1080x1080 graphic):
- quote-card:  { "quote": "<=140 chars", "attribution": "<string or null>", "eyebrow": "<=30 chars, e.g. the week theme>" }
- tip-card:    { "eyebrow": "<=30 chars", "title": "<=70 chars", "items": ["3-7 strings, each <=70 chars"] }
- carousel:    { "cover": {"title": "<=60", "subtitle": "<=90"}, "slides": [{"title": "<=45", "body": "<=150"} x 3-7], "end": {"title": "<=60", "subtitle": "<=90"} }
- diagram:     { "mode": "columns" or "circles", "title": "<=60",
                 "columns": { "left": {"label": "<=25", "items": ["2-5 x <=45 chars"]}, "right": {"label": "<=25", "items": ["2-5 x <=45 chars"]} }  // for mode=columns
                 "circles": [{"label": "WHY", "sub": "<=35"}, {"label": "HOW", "sub": "<=35"}, {"label": "WHAT", "sub": "<=35"}]  // for mode=circles, inner->outer
               }
- stat-card:   { "eyebrow": "<=30 chars", "stat": "<=12 chars, the big number/figure", "label": "<=45 chars", "context": "<=140 chars" }`;

// ---- validation ----
export function validatePackage(pkg, entry) {
  const errors = [];
  const approved = new Set(brand.hashtags);

  if (!pkg?.facebook?.text?.trim()) errors.push('facebook.text missing');
  if (pkg?.facebook?.text && pkg.facebook.text.length > 5000) errors.push('facebook.text absurdly long');

  if (!pkg?.instagram?.text?.trim()) errors.push('instagram.text missing');
  const tags = pkg?.instagram?.hashtags;
  if (!Array.isArray(tags) || tags.length < 3 || tags.length > 5) {
    errors.push('instagram.hashtags must be an array of 3-5 tags');
  } else {
    for (const t of tags) {
      if (!approved.has(String(t).replace(/^#/, ''))) errors.push(`hashtag "${t}" not in approved set`);
    }
  }
  const igFull = (pkg?.instagram?.text || '') + '\n\n' + (tags || []).map((t) => '#' + t).join(' ');
  if (igFull.length > 2200) errors.push('instagram caption exceeds 2200 chars');

  const xPosts = pkg?.x?.posts;
  if (!Array.isArray(xPosts) || xPosts.length < 1 || xPosts.length > 3) {
    errors.push('x.posts must be an array of 1-3 strings');
  } else {
    xPosts.forEach((p, i) => {
      if (xLength(p) > 280) errors.push(`x.posts[${i}] is ${xLength(p)} chars (max 280)`);
    });
  }

  const tmpl = pkg?.image?.template;
  const data = pkg?.image?.data;
  const templates = ['quote-card', 'tip-card', 'carousel', 'diagram', 'stat-card'];
  if (!templates.includes(tmpl)) {
    errors.push(`image.template must be one of ${templates.join(', ')}`);
  } else if (!data || typeof data !== 'object') {
    errors.push('image.data missing');
  } else {
    if (tmpl === 'quote-card' && !data.quote) errors.push('quote-card needs data.quote');
    if (tmpl === 'tip-card' && (!data.title || !Array.isArray(data.items) || data.items.length < 3))
      errors.push('tip-card needs data.title and >=3 data.items');
    if (tmpl === 'carousel' && (!data.cover?.title || !Array.isArray(data.slides) || data.slides.length < 3))
      errors.push('carousel needs data.cover.title and >=3 data.slides');
    if (tmpl === 'diagram') {
      if (data.mode === 'columns' && (!data.columns?.left?.label || !data.columns?.right?.label))
        errors.push('diagram columns mode needs columns.left/right with labels');
      else if (data.mode === 'circles' && (!Array.isArray(data.circles) || data.circles.length !== 3))
        errors.push('diagram circles mode needs exactly 3 circles');
      else if (!['columns', 'circles'].includes(data.mode)) errors.push('diagram needs mode columns|circles');
    }
    if (tmpl === 'stat-card' && (!data.stat || !data.context)) errors.push('stat-card needs data.stat and data.context');
  }
  if (!pkg?.image?.alt) errors.push('image.alt missing');

  if (entry && pkg?.date && pkg.date !== entry.date) errors.push(`package date ${pkg.date} != calendar date ${entry.date}`);
  return errors;
}

// ---- Anthropic call ----
let tokensUsed = 0;

async function callClaude(entry, previousErrors) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  if (tokensUsed > TOKEN_BUDGET) {
    throw new Error(`Token budget exhausted (${tokensUsed} > ${TOKEN_BUDGET}) — aborting run`);
  }

  let user = `Calendar entry (JSON):
${JSON.stringify(entry, null, 2)}

Approved IG hashtag list: ${JSON.stringify(brand.hashtags)}

${SCHEMA_INSTRUCTIONS}`;
  if (previousErrors?.length) {
    user += `\n\nYour previous attempt failed validation with these errors — fix them:\n- ${previousErrors.join('\n- ')}`;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
    err.retryable = res.status === 429 || res.status >= 500 || res.status === 529;
    throw err;
  }
  const data = await res.json();
  tokensUsed += (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
  const text = data.content?.[0]?.text || '';
  const jsonText = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  return JSON.parse(jsonText);
}

async function generateOne(entry) {
  let errors = null;
  const body = await retry(
    async () => {
      const pkg = await callClaude(entry, errors);
      errors = validatePackage(pkg, null);
      if (errors.length) throw new Error(`validation: ${errors.join('; ')}`);
      return pkg;
    },
    { attempts: 3, baseMs: 4000, label: `generate ${entry.date}` }
  );

  return {
    id: entry.date,
    date: entry.date,
    week: entry.week,
    weekTheme: entry.weekTheme,
    type: entry.type,
    hook: entry.hook,
    direction: entry.direction,
    facebook: body.facebook,
    instagram: body.instagram,
    x: body.x,
    image: body.image,
    meta: {
      status: 'queued',
      generated_at: new Date().toISOString(),
      model: MODEL,
      generator: 'api',
    },
  };
}

// ---- main ----
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--week-of') out.weekOf = args[++i];
    else if (args[i] === '--date') out.date = args[++i];
    else if (args[i] === '--manifest') out.manifest = args[++i];
  }
  // Empty-string inputs come through from workflow_dispatch defaults.
  if (!out.weekOf) delete out.weekOf;
  if (!out.date) delete out.date;
  return out;
}

async function main() {
  const opts = parseArgs();
  const calendar = readJSON(path.join(CONTENT, 'calendar.json'));

  let targets;
  if (opts.date) {
    targets = calendar.posts.filter((p) => p.date === opts.date);
    if (!targets.length) throw new Error(`No calendar entry for ${opts.date}`);
  } else {
    const base = opts.weekOf || todayET();
    const end = addDays(base, 7);
    targets = calendar.posts.filter((p) => p.date > base && p.date <= end);
  }
  if (!targets.length) {
    console.log('No calendar entries in the target window — nothing to generate.');
    if (opts.manifest) writeJSON(opts.manifest, { week_of: null, files: [] });
    return;
  }

  console.log(`Generating ${targets.length} post(s): ${targets.map((t) => t.date).join(', ')}`);
  const files = [];
  for (const entry of targets) {
    const pkg = await generateOne(entry);
    const file = path.join(QUEUE, `${entry.date}.json`);
    writeJSON(file, pkg);
    files.push(path.relative(ROOT, file));
    console.log(`  wrote ${path.relative(ROOT, file)} (${pkg.image.template}) — tokens so far: ${tokensUsed}`);
  }

  // Render images for everything just generated.
  execFileSync('node', [path.join(ROOT, 'src', 'generate-image.js'), ...files.map((f) => path.join(ROOT, f))], {
    stdio: 'inherit',
  });

  if (opts.manifest) {
    writeJSON(opts.manifest, {
      week_of: targets[0].date,
      week: targets[0].week,
      theme: targets[0].weekTheme,
      files,
      tokens_used: tokensUsed,
    });
  }
  console.log(`Done. Total tokens used: ${tokensUsed}`);
}

// Only run when invoked directly (the validator is imported elsewhere).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
