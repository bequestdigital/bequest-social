// Collect per-post performance metrics from the platform APIs for everything
// in content/<brand>/published/ and store them under content/<brand>/analytics/.
//
// Usage:
//   node src/insights.js                 # refresh every post published in the last 28 days
//                                        # (plus any post never fetched before)
//   node src/insights.js --days 60       # widen the refresh window
//   node src/insights.js --date 2026-10-07
//
// Output:
//   content/<brand>/analytics/posts/<date>.json  one record per published package:
//     { date, type, template, weekday, published_at, channels: { fb, ig, x }, snapshots: [...] }
//   content/<brand>/analytics/metric-support.json  which insight metrics the API currently
//     accepts (Meta deprecates these without notice; see negotiate()).
//
// Env: META_ACCESS_TOKEN, FB_PAGE_ID (Facebook + Instagram), X_* (optional — X reads are
//      pay-per-call on the current developer plan and fail soft), BRAND (bequest|fgc).
//
// Design notes:
//   - A post's numbers keep moving for about a week, so anything younger than
//     the window is re-fetched each run and the record keeps a short snapshot
//     history. Older posts are fetched once and then left alone.
//   - Every channel fails independently. A dead X key or an IG media id that
//     was deleted by hand (IG takedowns are manual — see retract.js) records an
//     error on that channel and the run continues. The run only fails if the
//     Meta token itself is unusable.
//   - Never trust a metric name to keep working: Meta removes Page/IG insight
//     metrics in API version bumps and the error does not say which one. The
//     collector probes each metric individually the first time a request
//     fails and remembers the surviving set in metric-support.json.
import fs from 'node:fs';
import path from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import { CONTENT, PUBLISHED, BRAND, readJSON, writeJSON, todayET, weekdayOf, retry } from './util.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
export const ANALYTICS = path.join(CONTENT, 'analytics');
export const ANALYTICS_POSTS = path.join(ANALYTICS, 'posts');
const SUPPORT_FILE = path.join(ANALYTICS, 'metric-support.json');
const MAX_SNAPSHOTS = 8;

// Candidate metric sets. Order matters only for readability.
// Probed live 2026-10-20 against v21.0: post_impressions, post_impressions_unique and
// post_engaged_users now return "(#100) must be a valid insights metric" (Meta's
// Nov-2025 / Jun-2026 Media Views migration). These four are what still answers.
const FB_POST_METRICS = ['post_media_view', 'post_total_media_view_unique', 'post_clicks', 'post_reactions_by_type_total'];
const IG_MEDIA_METRICS = ['reach', 'views', 'saved', 'shares', 'total_interactions', 'impressions'];

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { days: 28 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--days' && a[i + 1]) out.days = parseInt(a[++i], 10) || 28;
    else if (a[i] === '--date' && a[i + 1]) out.date = a[++i];
  }
  return out;
}

function daysBetween(isoA, isoB) {
  return Math.round((new Date(isoB + 'T12:00:00Z') - new Date(isoA + 'T12:00:00Z')) / 86400000);
}

async function graphGet(pathname, params, token) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${GRAPH}${pathname}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = new Error(`Graph GET ${pathname}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
    err.code = data.error?.code;
    err.retryable = res.status >= 500 || data.error?.is_transient === true;
    throw err;
  }
  return data;
}

// Same derivation publish.js uses: a system-user token can read Page insights
// only through the Page's own token.
async function resolvePageToken() {
  const tok = process.env.META_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;
  if (!tok || !pageId) return tok;
  try {
    const data = await graphGet('/me/accounts', { fields: 'id,access_token' }, tok);
    const page = (data.data || []).find((p) => p.id === pageId);
    if (page?.access_token) return page.access_token;
  } catch {
    /* already a Page token */
  }
  return tok;
}

function loadSupport() {
  return fs.existsSync(SUPPORT_FILE) ? readJSON(SUPPORT_FILE) : {};
}

// Request a metric set; on a metric error, probe each metric alone and keep the
// ones the API still accepts. Returns { values: {metric: number}, metrics: [...] }.
async function negotiate(key, objectId, candidates, token, support) {
  const tryMetrics = async (metrics) => {
    const data = await graphGet(`/${objectId}/insights`, { metric: metrics.join(','), period: 'lifetime' }, token);
    const values = {};
    for (const row of data.data || []) {
      const v = row.values?.[0]?.value;
      values[row.name] = typeof v === 'object' && v !== null ? Object.values(v).reduce((s, n) => s + (Number(n) || 0), 0) : Number(v) || 0;
    }
    return values;
  };
  // support[key] = { metrics: [...], checked_at } (older files stored a bare array).
  const known = Array.isArray(support[key]) ? { metrics: support[key] } : support[key];
  const fresh = known?.checked_at && Date.now() - Date.parse(known.checked_at) < 7 * 86400000;
  if (known && known.metrics?.length === 0 && fresh) {
    // Every metric was rejected within the last week (usually a token without
    // read_insights / instagram_manage_insights). Don't re-probe on every post.
    return { values: {}, metrics: [], error: known.error || 'no supported metrics (cached)' };
  }
  let metrics = known?.metrics?.length ? known.metrics : candidates;
  try {
    return { values: await tryMetrics(metrics), metrics };
  } catch (e) {
    if (e.retryable) throw e;
    // Probe one by one. Anything that errors alone is dropped from the set.
    const ok = [];
    const values = {};
    for (const m of candidates) {
      try {
        Object.assign(values, await tryMetrics([m]));
        ok.push(m);
      } catch (inner) {
        if (inner.retryable) throw inner;
      }
    }
    support[key] = { metrics: ok, checked_at: new Date().toISOString(), ...(ok.length ? {} : { error: e.message }) };
    writeJSON(SUPPORT_FILE, support);
    if (!ok.length) {
      console.log(`::warning title=No ${key} insight metrics accepted::${e.message} — base fields (reactions/comments/likes/shares) still collected; remembered for 7 days`);
      throw e;
    }
    console.log(`  metric set for ${key} renegotiated -> ${ok.join(',')}`);
    return { values, metrics: ok };
  }
}

async function fetchFacebook(postId, token, support) {
  const fields = 'permalink_url,created_time,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)';
  const base = await retry(() => graphGet(`/${postId}`, { fields }, token), { label: `fb ${postId}`, attempts: 3, shouldRetry: (e) => e.retryable });
  let insights = { values: {}, metrics: [] };
  try {
    insights = await negotiate('fb_post', postId, FB_POST_METRICS, token, support);
  } catch (e) {
    insights.error = e.message;
  }
  const reactions = base.reactions?.summary?.total_count ?? 0;
  const comments = base.comments?.summary?.total_count ?? 0;
  const shares = base.shares?.count ?? 0;
  const v = insights.values;
  return {
    permalink: base.permalink_url || null,
    created_time: base.created_time || null,
    reactions,
    comments,
    shares,
    engagement: reactions + comments + shares,
    views: v.post_media_view ?? v.post_impressions ?? null,
    reach: v.post_total_media_view_unique ?? v.post_impressions_unique ?? null,
    clicks: v.post_clicks ?? null,
    ...(insights.error ? { insights_error: insights.error } : {}),
  };
}

async function fetchInstagram(mediaId, token, support) {
  const fields = 'like_count,comments_count,media_type,media_product_type,permalink,timestamp';
  const base = await retry(() => graphGet(`/${mediaId}`, { fields }, token), { label: `ig ${mediaId}`, attempts: 3, shouldRetry: (e) => e.retryable });
  const key = base.media_type === 'CAROUSEL_ALBUM' ? 'ig_carousel' : 'ig_media';
  let insights = { values: {}, metrics: [] };
  try {
    insights = await negotiate(key, mediaId, IG_MEDIA_METRICS, token, support);
  } catch (e) {
    insights.error = e.message;
  }
  const likes = base.like_count ?? 0;
  const comments = base.comments_count ?? 0;
  const v = insights.values;
  const saved = v.saved ?? 0;
  const shares = v.shares ?? 0;
  return {
    permalink: base.permalink || null,
    created_time: base.timestamp || null,
    media_type: base.media_type || null,
    likes,
    comments,
    saved,
    shares,
    engagement: likes + comments + saved + shares,
    reach: v.reach ?? null,
    views: v.views ?? v.impressions ?? null,
    total_interactions: v.total_interactions ?? null,
    ...(insights.error ? { insights_error: insights.error } : {}),
  };
}

// One batched read for every X post in the run. Reads cost credits on the
// current developer plan, and may be refused outright (402/429/403): treat any
// failure as "no X data this run" rather than a run failure.
async function fetchXBatch(ids) {
  const need = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
  if (need.some((n) => !process.env[n])) return { error: 'X credentials not set' };
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  });
  const out = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  for (const chunk of chunks) {
    let res;
    try {
      res = await client.v2.tweets(chunk, { 'tweet.fields': ['public_metrics', 'non_public_metrics', 'created_at'] });
    } catch (e) {
      // non_public_metrics needs user context on every tweet; fall back to public only.
      try {
        res = await client.v2.tweets(chunk, { 'tweet.fields': ['public_metrics', 'created_at'] });
      } catch (e2) {
        return { error: `X read failed: ${e2.code || ''} ${String(e2.message).slice(0, 200)}` };
      }
    }
    for (const t of res.data || []) {
      const pm = t.public_metrics || {};
      const npm = t.non_public_metrics || {};
      out[t.id] = {
        created_time: t.created_at || null,
        likes: pm.like_count ?? 0,
        reposts: pm.retweet_count ?? 0,
        replies: pm.reply_count ?? 0,
        quotes: pm.quote_count ?? 0,
        bookmarks: pm.bookmark_count ?? 0,
        engagement: (pm.like_count ?? 0) + (pm.retweet_count ?? 0) + (pm.reply_count ?? 0) + (pm.quote_count ?? 0) + (pm.bookmark_count ?? 0),
        impressions: pm.impression_count ?? npm.impression_count ?? null,
        clicks: (npm.url_link_clicks ?? 0) + (npm.user_profile_clicks ?? 0) || null,
      };
    }
    for (const err of res.errors || []) {
      if (err.resource_id) out[err.resource_id] = { error: err.detail || err.title || 'not found' };
    }
  }
  return { data: out };
}

function loadPublished() {
  if (!fs.existsSync(PUBLISHED)) return [];
  return fs
    .readdirSync(PUBLISHED)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(PUBLISHED, f)))
    .filter((p) => p?.date && p.meta?.unpublished_test !== true)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function loadRecord(date) {
  const f = path.join(ANALYTICS_POSTS, `${date}.json`);
  return fs.existsSync(f) ? readJSON(f) : null;
}

export async function main() {
  const opts = parseArgs();
  if (!process.env.META_ACCESS_TOKEN || !process.env.FB_PAGE_ID) {
    throw new Error('META_ACCESS_TOKEN and FB_PAGE_ID are required');
  }
  const token = await resolvePageToken();
  const support = loadSupport();
  const today = todayET();

  let posts = loadPublished();
  if (opts.date) posts = posts.filter((p) => p.date === opts.date);
  const targets = posts.filter((p) => {
    const age = daysBetween(p.date, today);
    const rec = loadRecord(p.date);
    return opts.date || !rec || age <= opts.days;
  });
  if (!targets.length) {
    console.log('No posts need a metrics refresh.');
    return;
  }
  console.log(`[${BRAND}] refreshing metrics for ${targets.length} post(s): ${targets.map((p) => p.date).join(', ')}`);

  // X first, as one batch, so a refused read costs one call rather than one per post.
  const xIds = targets.flatMap((p) => (p.results?.x?.ok ? p.results.x.thread_ids?.[0] || p.results.x.id : [])).filter(Boolean);
  const xBatch = xIds.length ? await fetchXBatch(xIds) : { data: {} };
  if (xBatch.error) console.log(`::warning title=X metrics unavailable::${xBatch.error}`);

  // Per-channel read health for this run. A channel whose every read is a
  // permission error means the token lacks a scope, not that the posts did
  // badly; strategy.js reads this to refuse to steer on partial data.
  const blank = () => ({ ok: 0, permission: 0, other: 0 });
  const health = { fb: blank(), fb_insights: blank(), ig: blank(), ig_insights: blank(), x: blank() };
  if (xBatch.error) health.x = { ...blank(), permission: /402|403|429|credit/i.test(xBatch.error) ? targets.length : 0, other: /402|403|429|credit/i.test(xBatch.error) ? 0 : targets.length };

  let fetched = 0;
  for (const p of targets) {
    const age = daysBetween(p.date, today);
    const rec = loadRecord(p.date) || {
      date: p.date,
      type: p.type || null,
      template: p.image?.template || null,
      weekday: weekdayOf(p.date),
      hook: p.hook || null,
      week_theme: p.weekTheme || null,
      image_count: (p.image?.files || []).length,
      published_at: p.results?.fb?.at || p.results?.ig?.at || p.results?.x?.at || null,
      channels: {},
      snapshots: [],
    };
    const channels = {};
    const at = new Date().toISOString();

    if (p.results?.fb?.ok && p.results.fb.id) {
      try {
        channels.fb = await fetchFacebook(p.results.fb.id, token, support);
      } catch (e) {
        if (e.code === 190) throw e; // invalid token: nothing else will work either
        channels.fb = { error: e.message };
      }
    }
    if (p.results?.ig?.ok && p.results.ig.id) {
      try {
        channels.ig = await fetchInstagram(p.results.ig.id, token, support);
      } catch (e) {
        if (e.code === 190) throw e;
        channels.ig = { error: e.message };
      }
    }
    if (p.results?.x?.ok) {
      const id = p.results.x.thread_ids?.[0] || p.results.x.id;
      channels.x = xBatch.error ? { error: xBatch.error } : xBatch.data[id] || { error: 'not in batch response' };
    }

    // Carry forward a channel's last good reading when this run's read failed,
    // so a one-off API error never erases known numbers.
    for (const [k, v] of Object.entries(channels)) {
      if (v.error && rec.channels?.[k] && !rec.channels[k].error) {
        channels[k] = { ...rec.channels[k], stale: true, last_error: v.error };
      }
    }

    // (#10) and "requires the '...' permission" are scope/task problems. (#100) "must
    // be a valid insights metric" is a retired metric name, which is handled by
    // negotiate() and must not read as a permission failure.
    const isPermission = (msg) => /\(#10\)|requires the '|does not have permission/i.test(msg || '') && !/does not exist|valid insights metric/i.test(msg || '');
    for (const [k, v] of Object.entries(channels)) {
      const baseErr = v.error || v.last_error;
      if (baseErr) {
        health[k][isPermission(baseErr) ? 'permission' : 'other'] += 1;
        continue;
      }
      health[k].ok += 1;
      // Base read fine; insights are a separate scope, tracked separately.
      if (k === 'fb' || k === 'ig') {
        const bucket = health[`${k}_insights`] || (health[`${k}_insights`] = blank());
        if (v.insights_error) bucket[isPermission(v.insights_error) ? 'permission' : 'other'] += 1;
        else bucket.ok += 1;
      }
    }

    rec.channels = channels;
    rec.fetched_at = at;
    rec.age_days_at_fetch = age;
    rec.matured = age >= 3;
    rec.snapshots = [...(rec.snapshots || []), { at, age_days: age, channels: compact(channels) }].slice(-MAX_SNAPSHOTS);
    writeJSON(path.join(ANALYTICS_POSTS, `${p.date}.json`), rec);
    fetched += 1;
    console.log(
      `  ${p.date} ${p.type || ''}/${p.image?.template || ''}` +
        `  fb ${fmt(channels.fb)}  ig ${fmt(channels.ig)}  x ${fmt(channels.x)}`
    );
  }
  console.log(`Done: ${fetched} record(s) written to ${path.relative(process.cwd(), ANALYTICS_POSTS)}`);

  const blocked = Object.entries(health).filter(([, h]) => h.permission > 0 && h.ok === 0 && h.permission + h.other > 0).map(([k]) => k);
  const SCOPE_FIX = {
    fb: "pages_read_user_content (read the Page's own posts: reactions, comments, shares)",
    fb_insights: 'read_insights (impressions, reach, clicks)',
    ig_insights: 'instagram_manage_insights (reach, saves, shares, views)',
    ig: 'instagram_basic',
    x: 'X read credits on the Bequest Digital developer account (reads are pay-per-call)',
  };
  writeJSON(path.join(ANALYTICS, 'health.json'), { at: new Date().toISOString(), posts_checked: targets.length, channels: health, blocked, scope_fix: Object.fromEntries(blocked.map((b) => [b, SCOPE_FIX[b]])) });
  for (const b of blocked) {
    console.log(`::error title=${b} reads blocked by permissions::Every ${b} read this run was a permission error. Fix: ${SCOPE_FIX[b]}. For Meta scopes, regenerate the Bequest Publisher system-user token in Business Settings with those scopes added and update the META_ACCESS_TOKEN secret.`);
  }
}

function compact(channels) {
  const out = {};
  for (const [k, v] of Object.entries(channels)) {
    if (v.error) {
      out[k] = { error: true };
      continue;
    }
    const { permalink, created_time, media_type, insights_error, last_error, stale, ...nums } = v;
    out[k] = nums;
  }
  return out;
}

function fmt(c) {
  if (!c) return '—';
  if (c.error) return `ERR`;
  const reach = c.reach ?? c.impressions ?? '?';
  return `${c.engagement ?? '?'}eng/${reach}reach${c.stale ? '*' : ''}`;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
