// Publish an approved post package to Facebook, Instagram, and X.
//
// Usage:
//   node src/publish.js                          # publish content/approved/{today-ET}.json
//   node src/publish.js --date 2026-07-20        # explicit date
//   node src/publish.js --date ... --only ig,li  # retry specific platforms (fb|ig|x|li)
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
//      LINKEDIN_ACCESS_TOKEN, LINKEDIN_ORG_ID,
//      IMAGE_BASE_URL (optional override for the public image host IG fetches from),
//      GITHUB_TOKEN + GITHUB_REPOSITORY (for failure issues; optional locally)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import { APPROVED, PUBLISHED, ROOT, BRAND, readJSON, writeJSON, todayET, addDays, retry, xLength } from './util.js';
import { openIssue } from './notify.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
// Binary video uploads go to Meta's dedicated video host.
const GRAPH_VIDEO = 'https://graph-video.facebook.com/v21.0';

// A video package carries pkg.video = { file?, url?, duration_seconds? } next
// to the usual image.files (which hold a thumbnail frame used as the fallback
// post if a platform can't take the video). FB and X upload local bytes: use
// content/approved/<file> when committed, otherwise download video.url — the
// launch asset is hosted at poaster.co so this public repo doesn't carry
// multi-MB binaries. IG ingests straight from the URL.
async function localVideoPath(pkg) {
  if (!pkg.video) return null;
  if (pkg.video.file) {
    const p = path.join(APPROVED, pkg.video.file);
    if (fs.existsSync(p)) return p;
  }
  if (!pkg.video.url) throw new Error('video package has neither a local file nor a url');
  const tmp = path.join(os.tmpdir(), `${BRAND}-video-${pkg.date}.mp4`);
  if (!fs.existsSync(tmp)) {
    const res = await fetch(pkg.video.url);
    if (!res.ok) throw new Error(`video download ${res.status} from ${pkg.video.url}`);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  }
  return tmp;
}

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { only: ['fb', 'ig', 'x', 'li'], dryRun: false, force: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--date' && a[i + 1]) out.date = a[++i];
    else if (a[i] === '--only' && a[i + 1]) out.only = a[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a[i] === '--catch-up' && a[i + 1]) out.catchUp = parseInt(a[++i], 10) || 0;
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
  const rel = path.relative(ROOT, APPROVED).split(path.sep).join('/');
  return `https://raw.githubusercontent.com/${repo}/main/${rel}/${file}`;
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
async function publishFacebook(pkg, imagePaths, videoPath) {
  const pageId = process.env.FB_PAGE_ID;
  const uploadPhoto = async (imgPath, published, message) => {
    const form = new FormData();
    form.append('access_token', process.env.META_ACCESS_TOKEN);
    form.append('published', String(published));
    if (message) form.append('message', message);
    form.append('source', new Blob([fs.readFileSync(imgPath)], { type: 'image/jpeg' }), path.basename(imgPath));
    return graphCall(`/${pageId}/photos`, null, { form });
  };

  // meta.unpublished_test lets a connectivity check exercise auth + upload
  // without anything appearing on the page's feed.
  const visible = pkg.meta?.unpublished_test !== true;

  // Video post. If the token can't publish video (scope or spec problem), the
  // slot still goes out: fall back to the thumbnail photo post below.
  if (videoPath) {
    try {
      const form = new FormData();
      form.append('access_token', process.env.META_ACCESS_TOKEN);
      form.append('description', pkg.facebook.text);
      form.append('published', String(visible));
      form.append('source', new Blob([fs.readFileSync(videoPath)], { type: 'video/mp4' }), path.basename(videoPath));
      const res = await fetch(`${GRAPH_VIDEO}/${pageId}/videos`, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(`Graph video API: ${JSON.stringify(data.error || data).slice(0, 400)}`);
      return { id: data.id, video: true, ...(visible ? {} : { note: 'unpublished test — not visible on feed' }) };
    } catch (e) {
      if (!imagePaths.length) throw e;
      console.warn(`::warning title=FB video fallback::${e.message.slice(0, 300)} — posting the thumbnail image instead`);
      const res = await uploadPhoto(imagePaths[0], visible, pkg.facebook.text);
      return { id: res.post_id || res.id, note: `video upload failed — posted thumbnail image (${e.message.slice(0, 160)})` };
    }
  }

  if (imagePaths.length === 1) {
    const res = await uploadPhoto(imagePaths[0], visible, pkg.facebook.text);
    return { id: res.post_id || res.id, ...(visible ? {} : { note: 'unpublished test — not visible on feed' }) };
  }
  const mediaIds = [];
  for (const p of imagePaths) mediaIds.push((await uploadPhoto(p, false)).id);
  const res = await graphCall(`/${pageId}/feed`, {
    message: pkg.facebook.text,
    attached_media: JSON.stringify(mediaIds.map((id) => ({ media_fbid: id }))),
  });
  return { id: res.id };
}

// ---- Instagram: containers from public image/video URLs, then publish ----
async function waitForContainer(creationId, tries = 20, delayMs = 3000) {
  for (let i = 0; i < tries; i++) {
    const s = await graphCall(`/${creationId}`, { fields: 'status_code' }, { method: 'GET' });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR') throw new Error(`IG container ${creationId} errored`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`IG container ${creationId} not ready after ${Math.round((tries * delayMs) / 1000)}s`);
}

async function publishInstagram(pkg, imageFiles, videoUrl) {
  const igId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const caption = pkg.instagram.text + '\n\n' + pkg.instagram.hashtags.map((t) => '#' + t).join(' ');

  // Video goes out as a Reel (the only video surface the IG API still offers;
  // share_to_feed puts it on the grid). If the container is rejected — codec,
  // aspect ratio, fetch failure — fall back to the thumbnail image post.
  let note = null;
  if (videoUrl) {
    try {
      const c = await graphCall(`/${igId}/media`, { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true' });
      await waitForContainer(c.id, 60, 5000); // video transcodes take minutes, not seconds
      const pub = await graphCall(`/${igId}/media_publish`, { creation_id: c.id });
      return { id: pub.id, video: true };
    } catch (e) {
      if (!imageFiles.length) throw e;
      note = `video reel failed — posted thumbnail image (${e.message.slice(0, 160)})`;
      console.warn(`::warning title=IG video fallback::${e.message.slice(0, 300)} — posting the thumbnail image instead`);
    }
  }

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
  return { id: pub.id, ...(note ? { note } : {}) };
}

// ---- X: media upload + single post or reply-chain thread ----
async function publishX(pkg, imagePaths, videoPath) {
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
  // A video post uploads the video alone (chunked v1.1 upload, handled by the
  // library); if that fails for a non-tier reason, try the thumbnail image.
  const uploads = videoPath ? [videoPath] : imagePaths.slice(0, 4);
  for (const p of uploads) {
    try {
      const id = await client.v1.uploadMedia(p);
      // Alt text applies to images only — X rejects it on video.
      if (p !== videoPath && pkg.image.alt) await client.v1.createMediaMetadata(id, { alt_text: { text: pkg.image.alt.slice(0, 1000) } });
      mediaIds.push(id);
    } catch (e) {
      const code = e?.code || e?.data?.status;
      if (code === 402 || code === 403) {
        mediaSkipped = `media upload not available on this X API tier (HTTP ${code}) — posted text-only`;
        console.warn(`X: ${mediaSkipped}`);
        mediaIds.length = 0;
        break;
      }
      if (p === videoPath && imagePaths.length) {
        console.warn(`X: video upload failed (${e.message?.slice(0, 160)}) — trying the thumbnail image`);
        try {
          mediaIds.push(await client.v1.uploadMedia(imagePaths[0]));
          mediaSkipped = 'video dropped on X — posted thumbnail image';
        } catch {
          mediaSkipped = 'video and image both dropped on X — posted text-only';
          mediaIds.length = 0;
        }
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

// ---- LinkedIn: company-page post via the REST Posts + Images API ----
const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || '202409';
const LI_BASE = 'https://api.linkedin.com/rest';

function liHeaders(extra = {}) {
  return {
    authorization: `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
    'linkedin-version': LINKEDIN_VERSION,
    'x-restli-protocol-version': '2.0.0',
    ...extra,
  };
}

// Upload one image to LinkedIn for the given org, returning its image URN.
async function liUploadImage(orgUrn, imgPath) {
  const initRes = await fetch(`${LI_BASE}/images?action=initializeUpload`, {
    method: 'POST',
    headers: liHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ initializeUploadRequest: { owner: orgUrn } }),
  });
  const init = await initRes.json().catch(() => ({}));
  if (!initRes.ok) throw new Error(`LinkedIn image init ${initRes.status}: ${JSON.stringify(init).slice(0, 300)}`);
  const { uploadUrl, image } = init.value || {};
  if (!uploadUrl || !image) throw new Error('LinkedIn image init returned no uploadUrl/image URN');

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { authorization: `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}` },
    body: fs.readFileSync(imgPath),
  });
  if (!put.ok) throw new Error(`LinkedIn image upload ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return image;
}

async function publishLinkedIn(pkg, imagePaths) {
  const orgId = process.env.LINKEDIN_ORG_ID;
  const orgUrn = `urn:li:organization:${orgId}`;
  // LinkedIn is a professional feed: reuse the (hashtag-free, link-friendly)
  // Facebook copy unless a dedicated linkedin.text is supplied.
  const commentary = (pkg.linkedin?.text || pkg.facebook.text)
    // LinkedIn commentary requires these characters be escaped.
    .replace(/([\\()<>@[\]{}|~*_])/g, '\\$1');

  const alt = pkg.image?.alt?.slice(0, 4000) || '';
  const urns = [];
  for (const p of imagePaths) urns.push(await liUploadImage(orgUrn, p));

  const post = {
    author: orgUrn,
    commentary,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (urns.length === 1) {
    post.content = { media: { id: urns[0], altText: alt } };
  } else if (urns.length > 1) {
    post.content = { multiImage: { images: urns.map((id) => ({ id, altText: alt })) } };
  }

  const res = await fetch(`${LI_BASE}/posts`, {
    method: 'POST',
    headers: liHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(post),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`LinkedIn post ${res.status}: ${body.slice(0, 400)}`);
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }
  const id = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id') || 'posted';
  return { id };
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
  if (pkg.video) {
    if (!pkg.video.file && !pkg.video.url) errors.push('pkg.video needs a file or a url');
    if (pkg.video.file && !fs.existsSync(path.join(APPROVED, pkg.video.file))) {
      errors.push(`video missing: ${pkg.video.file}`);
    }
  }
  // Channel sections are optional per brand (e.g. FGC is Facebook-only) —
  // validate only what the package carries.
  if (!pkg.facebook?.text) errors.push('package has no facebook.text');
  else if (pkg.facebook.text.length > 63206) errors.push('FB caption over 63,206 chars');
  if (pkg.instagram) {
    const igCaption = pkg.instagram.text + '\n\n' + (pkg.instagram.hashtags || []).map((t) => '#' + t).join(' ');
    if (igCaption.length > 2200) errors.push('IG caption over 2,200 chars');
  }
  (pkg.x?.posts || []).forEach((p, i) => {
    if (xLength(p) > 280) errors.push(`X post ${i + 1} is ${xLength(p)} chars (max 280)`);
  });
  const liText = pkg.linkedin?.text || pkg.facebook?.text || '';
  if (liText.length > 3000) errors.push('LinkedIn commentary over 3,000 chars');
  return errors;
}

async function publishOne(date, opts) {
  const file = path.join(APPROVED, `${date}.json`);

  if (!fs.existsSync(file)) {
    console.log(`No approved post for ${date} (${path.relative(ROOT, file)} absent) — nothing to publish.`);
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

  // Video packages: FB and X need local bytes. If the asset can't be fetched,
  // those platforms fall back to the thumbnail image; IG still gets the URL.
  let videoPath = null;
  if (pkg.video && !opts.dryRun) {
    try {
      videoPath = await localVideoPath(pkg);
    } catch (e) {
      console.warn(`::warning title=video asset::${e.message} — FB/X will fall back to the thumbnail image`);
    }
  }
  const videoUrl = pkg.video ? pkg.video.url || (pkg.video.file ? publicImageUrl(pkg.video.file) : null) : null;

  // Brands without a channel section skip that platform entirely.
  const brandOnly = opts.only.filter((k) =>
    (k === 'fb' && pkg.facebook) || (k === 'ig' && pkg.instagram) || (k === 'x' && pkg.x) || (k === 'li' && (pkg.linkedin || pkg.facebook))
  );
  opts.only = brandOnly;

  pkg.results = pkg.results || {};
  const platforms = [
    { key: 'fb', name: 'Facebook', env: ['META_ACCESS_TOKEN', 'FB_PAGE_ID'], fn: () => publishFacebook(pkg, imagePaths, videoPath) },
    { key: 'ig', name: 'Instagram', env: ['META_ACCESS_TOKEN', 'IG_BUSINESS_ACCOUNT_ID'], fn: () => publishInstagram(pkg, imageFiles, videoUrl) },
    { key: 'x', name: 'X', env: ['X_API_KEY'], fn: () => publishX(pkg, imagePaths, videoPath) },
    { key: 'li', name: 'LinkedIn', env: ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_ORG_ID'], fn: () => publishLinkedIn(pkg, imagePaths) },
  ].filter((p) => opts.only.includes(p.key));

  // Skip any platform whose credentials aren't configured yet (e.g. LinkedIn
  // while its API approval is pending) — it's not a failure, it just isn't
  // wired up. It auto-joins the moment its secrets exist. Explicitly requesting
  // a single unconfigured platform (--only li) still surfaces as an error below.
  const ready = platforms.filter((p) => {
    const missing = p.env.filter((e) => !process.env[e]);
    if (missing.length && opts.only.length > 1) {
      console.log(`${p.name}: not configured (missing ${missing.join(', ')}) — skipping`);
      return false;
    }
    return true;
  });

  const failures = [];
  for (const platform of ready) {
    if (pkg.results[platform.key]?.ok) {
      console.log(`${platform.name}: already published (${pkg.results[platform.key].id}) — skipping`);
      continue;
    }
    if (opts.dryRun) {
      console.log(`${platform.name}: [dry-run] would publish ${imageFiles.length} image(s)${pkg.video ? ` + video (${pkg.video.file || pkg.video.url})` : ''}`);
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

  const allOk = ready.length > 0 && ready.every((p) => pkg.results[p.key]?.ok);
  if (allOk) {
    fs.mkdirSync(PUBLISHED, { recursive: true });
    pkg.meta.status = 'published';
    writeJSON(file, pkg);
    fs.renameSync(file, path.join(PUBLISHED, `${pkg.date}.json`));
    const assets = [...imageFiles, ...(pkg.video?.file && fs.existsSync(path.join(APPROVED, pkg.video.file)) ? [pkg.video.file] : [])];
    for (const f of assets) fs.renameSync(path.join(APPROVED, f), path.join(PUBLISHED, f));
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
      `gh workflow run publish.yml -f date=${pkg.date} -f only=${failedKeys}${BRAND !== 'bequest' ? ` -f brand=${BRAND}` : ''}`,
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

// Publish any missed recent days first (oldest→newest), then today. A day that
// failed (dead token, outage) self-heals on the next scheduled run instead of
// silently staying in approved/ forever.
async function main() {
  const opts = parseArgs();
  const dates = [];
  for (let i = opts.catchUp || 0; i >= 1; i--) {
    const d = addDays(opts.date, -i);
    if (fs.existsSync(path.join(APPROVED, `${d}.json`))) dates.push({ d, catchUp: true });
  }
  dates.push({ d: opts.date, catchUp: false });

  const failures = [];
  for (const { d, catchUp } of dates) {
    if (catchUp) console.log(`[catch-up] ${d} is approved but was never fully published — publishing now.`);
    try {
      await publishOne(d, catchUp ? { ...opts, force: true } : opts);
    } catch (e) {
      failures.push(`${d}: ${e.message}`);
      console.error(`Publish for ${d} failed — continuing with remaining dates.`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
