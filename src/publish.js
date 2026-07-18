// Publish an approved post package to Facebook, Instagram, and X.
//
// Usage:
//   node src/publish.js                          # publish content/approved/{today-ET}.json
//   node src/publish.js --date 2026-07-20        # explicit date
//   node src/publish.js --date ... --only ig,x   # retry specific platforms (fb|ig|x)
//   node src/publish.js --dry-run                # validate + log, post nothing
//
// Behavior:
//   - No approved file for the date -> exits 0 quietly (a missed approval must
//     never cause a late or duplicate post).
//   - Per-platform results are recorded in the package file as they succeed, so
//     a re-run the same day never double-posts.
//   - The file (and its images) move to content/published/ only when every
//     requested platform has succeeded. Partial failure leaves it in approved/
//     with the successes recorded, and opens a GitHub issue with a retry command.
//
// Env: META_ACCESS_TOKEN, FB_PAGE_ID, IG_BUSINESS_ACCOUNT_ID,
//      X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET,
//      IMAGE_BASE_URL (optional override for the public image host IG fetches from),
//      GITHUB_TOKEN + GITHUB_REPOSITORY (for failure issues; optional locally)
import fs from 'node:fs';
import path from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import { APPROVED, PUBLISHED, ROOT, readJSON, writeJSON, todayET, retry, xLength } from './util.js';
import { openIssue } from './notify.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { only: ['fb', 'ig', 'x'], dryRun: false, force: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--date' && a[i + 1]) out.date = a[++i];
    else if (a[i] === '--only' && a[i + 1]) out.only = a[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a[i] === '--dry-run') out.dryRun = true;
    else if (a[i] === '--force') out.force = true;
  }
  if (!out.date) out.date = todayET();
  return out;
}

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

// Public URL Instagram can fetch the image from. Default: raw.githubusercontent.com
// on main (requires the repo to be public, or IMAGE_BASE_URL pointing at any host
// that serves content/approved/<file>).
function publicImageUrl(file) {
  if (process.env.IMAGE_BASE_URL) {
    return `${process.env.IMAGE_BASE_URL.replace(/\/$/, '')}/${file}`;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('Set GITHUB_REPOSITORY or IMAGE_BASE_URL so Instagram can fetch images');
  return `https://raw.githubusercontent.com/${repo}/main/content/approved/${file}`;
}

async function graphCall(pathname, params, { method = 'POST', form } = {}) {
  let res;
  if (form) {
    res = await fetch(`${GRAPH}${pathname}`, { method, body: form });
  } else if (method === 'GET') {
    // GET requests carry params in the query string; a body is invalid on GET.
    const qs = new URLSearchParams({ ...params, access_token: process.env.META_ACCESS_TOKEN });
    res = await fetch(`${GRAPH}${pathname}?${qs}`, { method });
  } else {
    const qs = new URLSearchParams({ ...params, access_token: process.env.META_ACCESS_TOKEN });
    res = await fetch(`${GRAPH}${pathname}`, {
      method,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: qs,
    });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = new Error(`Graph API ${pathname}: ${JSON.stringify(data.error || data).slice(0, 400)}`);
    err.retryable = res.status >= 500 || data.error?.is_transient;
    throw err;
  }
  return data;
}

// Resolve the Page access token used for both Facebook posting and Instagram
// content publishing. META_ACCESS_TOKEN may be stored as a Page token (used
// directly) or as a system-user / user token (in which case we derive the
// non-expiring Page token for FB_PAGE_ID). Both surfaces post with this token.
async function resolvePageToken() {
  const tok = process.env.META_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;
  if (!tok || !pageId) return tok;
  try {
    const qs = new URLSearchParams({ fields: 'id,access_token', access_token: tok });
    const data = await fetch(`${GRAPH}/me/accounts?${qs}`).then((r) => r.json());
    const page = (data.data || []).find((p) => p.id === pageId);
    if (page?.access_token) return page.access_token;
  } catch {
    /* token is likely already a Page token — fall through and use it as-is */
  }
  return tok;
}

// ---- Facebook: direct binary upload; multi-image posts use unpublished photos ----
async function publishFacebook(pkg, imagePaths) {
  const pageId = process.env.FB_PAGE_ID;
  const uploadPhoto = async (imgPath, published, message) => {
    const form = new FormData();
    form.append('access_token', process.env.META_ACCESS_TOKEN);
    form.append('published', String(published));
    if (message) form.append('message', message);
    form.append('source', new Blob([fs.readFileSync(imgPath)], { type: 'image/jpeg' }), path.basename(imgPath));
    return graphCall(`/${pageId}/photos`, null, { form });
  };

  if (imagePaths.length === 1) {
    const res = await uploadPhoto(imagePaths[0], true, pkg.facebook.text);
    return { id: res.post_id || res.id };
  }
  const mediaIds = [];
  for (const p of imagePaths) mediaIds.push((await uploadPhoto(p, false)).id);
  const res = await graphCall(`/${pageId}/feed`, {
    message: pkg.facebook.text,
    attached_media: JSON.stringify(mediaIds.map((id) => ({ media_fbid: id }))),
  });
  return { id: res.id };
}

// ---- Instagram: containers from public image URLs, then publish ----
async function waitForContainer(creationId) {
  for (let i = 0; i < 20; i++) {
    const s = await graphCall(`/${creationId}`, { fields: 'status_code' }, { method: 'GET' });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR') throw new Error(`IG container ${creationId} errored`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`IG container ${creationId} not ready after 60s`);
}

async function publishInstagram(pkg, imageFiles) {
  const igId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const caption = pkg.instagram.text + '\n\n' + pkg.instagram.hashtags.map((t) => '#' + t).join(' ');

  let creationId;
  if (imageFiles.length === 1) {
    const c = await graphCall(`/${igId}/media`, { image_url: publicImageUrl(imageFiles[0]), caption });
    creationId = c.id;
  } else {
    const children = [];
    for (const f of imageFiles) {
      const c = await graphCall(`/${igId}/media`, { image_url: publicImageUrl(f), is_carousel_item: 'true' });
      await waitForContainer(c.id);
      children.push(c.id);
    }
    const c = await graphCall(`/${igId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });
    creationId = c.id;
  }
  await waitForContainer(creationId);
  const pub = await graphCall(`/${igId}/media_publish`, { creation_id: creationId });
  return { id: pub.id };
}

// ---- X: media upload + single post or reply-chain thread ----
async function publishX(pkg, imagePaths) {
  requireEnv(['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET']);
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  });

  // Media upload uses the X API v1.1 endpoints, which the free tier does not
  // include (returns 402/403). If that happens, fall back to a text-only post
  // so the content and link still go out, rather than dropping X entirely.
  const mediaIds = [];
  let mediaSkipped = null;
  for (const p of imagePaths.slice(0, 4)) {
    try {
      const id = await client.v1.uploadMedia(p);
      if (pkg.image.alt) await client.v1.createMediaMetadata(id, { alt_text: { text: pkg.image.alt.slice(0, 1000) } });
      mediaIds.push(id);
    } catch (e) {
      const code = e?.code || e?.data?.status;
      if (code === 402 || code === 403) {
        mediaSkipped = `media upload not available on this X API tier (HTTP ${code}) — posted text-only`;
        console.warn(`X: ${mediaSkipped}`);
        mediaIds.length = 0;
        break;
      }
      throw e;
    }
  }

  const ids = [];
  let replyTo = null;
  for (let i = 0; i < pkg.x.posts.length; i++) {
    const body = { text: pkg.x.posts[i] };
    if (i === 0 && mediaIds.length) body.media = { media_ids: mediaIds };
    if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
    let res;
    try {
      res = await client.v2.tweet(body);
    } catch (e) {
      // If the tweet is rejected for a tier/payment reason while it carries
      // media, retry text-only — the image, not the post, may be what's gated.
      const code = e?.code || e?.data?.status;
      if ((code === 402 || code === 403) && body.media) {
        mediaSkipped = `image dropped on X (HTTP ${code} with media) — posted text-only`;
        console.warn(`X: ${mediaSkipped}`);
        delete body.media;
        res = await client.v2.tweet(body);
      } else {
        throw e;
      }
    }
    replyTo = res.data.id;
    ids.push(res.data.id);
  }
  return { id: ids[0], thread_ids: ids, ...(mediaSkipped ? { note: mediaSkipped } : {}) };
}

// ---- validation before anything posts ----
function validate(pkg, imagePaths, opts) {
  const errors = [];
  if (!opts.force && pkg.date !== todayET()) {
    errors.push(`package date ${pkg.date} is not today (${todayET()} ET) — use --force to override`);
  }
  if (fs.existsSync(path.join(PUBLISHED, `${pkg.date}.json`))) {
    errors.push(`content/published/${pkg.date}.json already exists — already posted`);
  }
  for (const p of imagePaths) {
    if (!fs.existsSync(p)) errors.push(`image missing: ${p}`);
  }
  if (pkg.facebook.text.length > 63206) errors.push('FB caption over 63,206 chars');
  const igCaption = pkg.instagram.text + '\n\n' + pkg.instagram.hashtags.map((t) => '#' + t).join(' ');
  if (igCaption.length > 2200) errors.push('IG caption over 2,200 chars');
  pkg.x.posts.forEach((p, i) => {
    if (xLength(p) > 280) errors.push(`X post ${i + 1} is ${xLength(p)} chars (max 280)`);
  });
  return errors;
}

async function main() {
  const opts = parseArgs();
  const file = path.join(APPROVED, `${opts.date}.json`);

  if (!fs.existsSync(file)) {
    console.log(`No approved post for ${opts.date} (${path.relative(ROOT, file)} absent) — nothing to publish.`);
    return;
  }

  const pkg = readJSON(file);
  const imageFiles = pkg.image.files || [];
  const imagePaths = imageFiles.map((f) => path.join(APPROVED, f));

  const errors = validate(pkg, imagePaths, opts);
  if (errors.length) {
    throw new Error('Pre-publish validation failed:\n  ' + errors.join('\n  '));
  }

  // Meta posting (FB + IG) uses the Page token; derive it from META_ACCESS_TOKEN
  // if a system-user/user token was stored. X doesn't use it.
  if (!opts.dryRun && (opts.only.includes('fb') || opts.only.includes('ig')) && process.env.META_ACCESS_TOKEN) {
    process.env.META_ACCESS_TOKEN = await resolvePageToken();
  }

  pkg.results = pkg.results || {};
  const platforms = [
    { key: 'fb', name: 'Facebook', env: ['META_ACCESS_TOKEN', 'FB_PAGE_ID'], fn: () => publishFacebook(pkg, imagePaths) },
    { key: 'ig', name: 'Instagram', env: ['META_ACCESS_TOKEN', 'IG_BUSINESS_ACCOUNT_ID'], fn: () => publishInstagram(pkg, imageFiles) },
    { key: 'x', name: 'X', env: ['X_API_KEY'], fn: () => publishX(pkg, imagePaths) },
  ].filter((p) => opts.only.includes(p.key));

  const failures = [];
  for (const platform of platforms) {
    if (pkg.results[platform.key]?.ok) {
      console.log(`${platform.name}: already published (${pkg.results[platform.key].id}) — skipping`);
      continue;
    }
    if (opts.dryRun) {
      console.log(`${platform.name}: [dry-run] would publish ${imageFiles.length} image(s)`);
      continue;
    }
    try {
      requireEnv(platform.env);
      const res = await retry(platform.fn, { attempts: 2, baseMs: 5000, label: platform.name });
      pkg.results[platform.key] = { ok: true, ...res, at: new Date().toISOString() };
      writeJSON(file, pkg); // record each success immediately — idempotency on re-run
      console.log(`${platform.name}: published (${res.id})`);
    } catch (e) {
      pkg.results[platform.key] = { ok: false, error: e.message, at: new Date().toISOString() };
      writeJSON(file, pkg);
      failures.push({ platform: platform.name, key: platform.key, error: e.message });
      console.error(`${platform.name}: FAILED — ${e.message}`);
    }
  }

  if (opts.dryRun) return;

  const allOk = platforms.every((p) => pkg.results[p.key]?.ok);
  if (allOk) {
    fs.mkdirSync(PUBLISHED, { recursive: true });
    pkg.meta.status = 'published';
    writeJSON(file, pkg);
    fs.renameSync(file, path.join(PUBLISHED, `${pkg.date}.json`));
    for (const f of imageFiles) fs.renameSync(path.join(APPROVED, f), path.join(PUBLISHED, f));
    console.log(`All platforms published — moved to content/published/${pkg.date}.json`);
  } else {
    const failedKeys = failures.map((f) => f.key).join(',');
    const body = [
      `Publish run for **${pkg.date}** had failures. Successful platforms are recorded and will not repost.`,
      '',
      ...failures.map((f) => `- **${f.platform}**: \`${f.error}\``),
      '',
      'Retry just the failed platforms:',
      '```',
      `gh workflow run publish.yml -f date=${pkg.date} -f only=${failedKeys}`,
      '```',
      `(or locally: \`node src/publish.js --date ${pkg.date} --only ${failedKeys} --force\`)`,
    ].join('\n');
    if (process.env.GITHUB_TOKEN) {
      await openIssue(`Publish failure ${pkg.date}: ${failures.map((f) => f.platform).join(', ')}`, body).catch((e) =>
        console.error(`Could not open issue: ${e.message}`)
      );
    }
    throw new Error(`Publish incomplete for ${pkg.date}: ${failures.map((f) => f.platform).join(', ')} failed`);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
