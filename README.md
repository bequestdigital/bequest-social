# bequest-social

Organic social automation for **Bequest Digital LLC**. Generates, queues, and publishes Mon/Wed/Fri posts to Facebook, Instagram, and X — with a human approval gate (a GitHub PR merge) before anything posts. Runs entirely on GitHub Actions; no servers.

## How it flows

```
calendar .md ──parse──▶ content/calendar.json
                              │
              Sunday 6am ET (generate-weekly.yml)
                              ▼
              Claude API writes 3 post packages
              Puppeteer renders branded graphics
                              ▼
              content/queue/  +  a review PR
                              │
                   YOU MERGE THE PR  ◀── the approval gate
                              ▼
              approve.yml moves files to content/approved/
                              │
              Mon/Wed/Fri 9am ET (publish.yml)
                              ▼
              FB Page · IG Business · X
                              ▼
              content/published/ (archive + platform post IDs)
```

**Nothing ever posts without a merged PR.** If a PR isn't merged in time, the publish run finds nothing in `approved/` for that date and exits quietly. No fallback auto-approves; a missed approval never causes a late or duplicate post.

## Repo layout

```
content/calendar.json    machine-readable calendar (parsed from the .md)
content/queue/           generated posts awaiting approval (JSON + JPG per post)
content/approved/        merged (approved) posts ready to publish
content/published/       archive with platform post IDs + timestamps
src/                     parse-calendar, generate, generate-image, publish, notify,
                         pr-body (builds the review PR), check-token (Meta token health)
templates/               5 HTML/CSS image templates (quote-card, tip-card, carousel,
                         diagram, stat-card) — all styled from brand.config.js
.github/workflows/       generate-weekly, approve, publish, token-check
brand.config.js          colors/fonts (extracted from mybequestdigital.com) + hashtag pool
```

---

## One-time setup

### 1. Create the GitHub repo and push

```bash
gh repo create bequest-social --public --source . --push
```

> **Why public?** Instagram's publishing API can't accept an image upload — it must *fetch* the image from a public URL. By default this system serves images from `raw.githubusercontent.com`, which only works on a public repo. The only "pre-publication" exposure is the coming week's queued posts (they go public on IG days later anyway). If you want the repo private instead, set an `IMAGE_BASE_URL` repo **variable** pointing at any public host that mirrors `content/approved/` (e.g. a free Cloudinary/S3 bucket) — everything else works private, since Facebook and X take direct uploads.

### 2. Add repository secrets

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (step 3) |
| `META_ACCESS_TOKEN` | Long-lived Facebook **Page** token (step 4) |
| `FB_PAGE_ID` | Numeric ID of the Bequest Facebook Page (step 4) |
| `IG_BUSINESS_ACCOUNT_ID` | Numeric ID of the linked IG Business account (step 4) |
| `X_API_KEY` / `X_API_SECRET` | X app consumer key + secret (step 5) |
| `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` | X account access token + secret (step 5) |

### 3. Anthropic key

[console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key. Generation uses `claude-sonnet-4-6` at low temperature with retry (3 attempts, exponential backoff) and a hard token budget per run (`TOKEN_BUDGET` env, default 150k tokens ≈ well under $1/week).

### 4. Meta (Facebook Page + Instagram Business)

You need admin on the Page and the linked IG Business account (you have this). What you're creating is a Meta developer app that acts on your own assets — it never needs App Review for that.

1. **Create the app**: [developers.facebook.com](https://developers.facebook.com) → My Apps → Create App → type **Business**. Name it e.g. `Bequest Social Publisher`.
2. **Get IDs**: In [Meta Business Suite](https://business.facebook.com) → Settings → Business assets: note the Facebook **Page ID** (`FB_PAGE_ID`) and the **Instagram account ID** (`IG_BUSINESS_ACCOUNT_ID`). (Or fetch later via `GET /me/accounts` and `GET /{page-id}?fields=instagram_business_account`.)
3. **Get a short-lived token**: open the [Graph API Explorer](https://developers.facebook.com/tools/explorer), select your app, click **Generate Access Token**, and grant these permissions: `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`, `business_management`.
4. **Exchange for a long-lived user token** (~60 days):
   ```
   curl "https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN"
   ```
5. **Get the long-lived Page token** (this is what goes in `META_ACCESS_TOKEN`):
   ```
   curl "https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN"
   ```
   Copy the `access_token` for the Bequest page from the response. Page tokens obtained from a long-lived user token generally **do not expire**, but treat them as ~60-day tokens to be safe.

**Token refresh**: the `token-check.yml` workflow pings the token every Tuesday and opens a GitHub issue if it's dead or expiring within 14 days. To refresh: repeat steps 3–5 (short-lived → exchange → page token) and update the `META_ACCESS_TOKEN` secret. Five minutes, from a phone browser if needed.

### 5. X (Twitter)

1. Apply at [developer.x.com](https://developer.x.com) → sign up for the **Free** tier with the Bequest account (Free allows ~500 writes/month; we use ~26).
2. In the developer portal, a default Project + App is created. Open the app's **Settings → User authentication set up**: enable **Read and write** permissions (type: "Web App, Automated App or Bot"; callback URL can be `https://mybequestdigital.com`, it isn't used).
3. **Keys and tokens** tab: copy the **API Key and Secret** (`X_API_KEY`, `X_API_SECRET`), then generate **Access Token and Secret** (`X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`). If you generated the access token *before* enabling read-write, regenerate it after.

Publishing uses API v2 for posts (threads become reply chains) and v1.1 for media upload + alt text — both covered by these same keys.

---

## The weekly rhythm

### Sunday: review from your phone

At 6am ET Sunday a PR titled **"Posts for week of YYYY-MM-DD"** appears. The PR body contains every post's full FB/IG/X copy and the rendered graphics inline — review happens entirely in the PR view (GitHub mobile app works great).

- **Approve everything** → Merge the PR. Done.
- **Edit copy first** → In the PR, open `content/queue/<date>.json` → edit (pencil icon) → change the text → commit to the same branch → merge. (If you change `image.data`, re-run rendering locally or just accept the existing graphic — the image is only re-rendered by the generation run.)
- **Reject one slot** → delete that date's `.json` and `.jpg` from the PR branch, then merge the rest.
- **Reject the whole week** → close the PR without merging. Nothing posts.
- **Skip a slot after approving** → delete `content/approved/<date>.json` (+ its images) from `main` before 9am ET that day.

Merging triggers `approve.yml`, which moves the files from `queue/` to `approved/`. **Merge before Monday 9am ET** or Monday's slot is quietly skipped (you can still publish late manually — see below).

### Mon/Wed/Fri: publishing

At 9am ET the publish workflow posts anything in `approved/` dated today, then archives it to `published/` with platform post IDs. Cron runs at both DST candidate hours (13:00/14:00 UTC) with a timezone gate so it's always 9am *New York* time.

**Partial failures**: platforms that succeed are recorded immediately; the run opens a GitHub issue naming what failed with a ready-to-paste retry command like:

```
gh workflow run publish.yml -f date=2026-07-20 -f only=ig
```

Re-runs never double-post — successful platform IDs are checked before anything is sent. Every run's log is saved as a workflow artifact. Friday runs also open a weekly summary issue.

**Missed a merge?** Merge the PR whenever, then: `gh workflow run publish.yml -f date=<the-date>` (manual runs bypass only the *time* gate, never the approval gate).

---

## Loading next quarter's calendar

1. Drop the new markdown calendar in the repo root (any `*calendar*.md` name; same table format: `## Week N (…) — Theme: …` headings and `| Mon 7/20 | TYPE | **"Hook"** | Direction |` rows). Remove or rename the old one so only the current quarter matches `*calendar*`.
2. Run `node src/parse-calendar.js` (or let the Sunday run do it — it re-parses every week). The parser validates every date against its weekday label and fails loudly on mismatches, duplicate dates, or unknown post types.
3. Commit. That's it — generation targets whatever calendar dates fall in the coming week.

## Running locally

```bash
npm install
node src/parse-calendar.js                  # md -> content/calendar.json
ANTHROPIC_API_KEY=sk-... node src/generate.js --week-of 2026-07-19
node src/generate-image.js --all-queue      # re-render graphics
node src/publish.js --date 2026-07-20 --dry-run
```

Rendering uses your installed Chrome (`puppeteer-core`; set `PUPPETEER_EXECUTABLE_PATH` if it isn't found). GitHub's Ubuntu runners ship with Chrome preinstalled.

## Guard rails (implemented)

- Approval = merged PR; no auto-approve path exists.
- Pre-publish validation: caption length limits per platform (FB 63,206 / IG 2,200 / X 280 weighted), image files exist, package date is today, not already in `published/`.
- Idempotent publishing: per-platform success IDs recorded in the package as they land; re-runs skip them; a date already in `published/` refuses to run.
- Anthropic calls: 3-attempt exponential backoff + hard per-run token budget; generated JSON is schema-validated (including hashtags restricted to the approved pool in `brand.config.js`) before anything is queued, with validation errors fed back to the model on retry.
- Every workflow run uploads its log as an artifact; failures open GitHub issues.

## Defaults chosen (flagging per the build brief)

- **Public repo** for IG image hosting via `raw.githubusercontent.com` (see setup step 1 for the private-repo alternative via `IMAGE_BASE_URL`).
- **JPEG, not PNG** graphics — Instagram's API only accepts JPEG.
- **No logo file**: the brand mark is a typeset "BEQUEST DIGITAL" wordmark in the site's fonts, matching the site's text-based branding. Drop an SVG/PNG in `templates/` and reference it in the templates if a real logo lands.
- **Carousels**: FB gets a multi-photo post, IG a true carousel, X attaches the first 4 slides.
- **Model**: `claude-sonnet-4-6` (override with a `MODEL` env/repo variable).
- **Week 1 queue contents** were produced by a local offline dry run (marked `"generator": "dry-run-local"` in the JSON) so quality could be inspected before wiring secrets; live weeks use the API path in `src/generate.js`.
- The X account posts the same content trimmed (single post) by default; threads only when the calendar content warrants, per the Standing Notes.
