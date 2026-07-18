// One-time helper to mint a non-expiring Facebook Page access token for the
// META_ACCESS_TOKEN secret. Run this once after the Meta app is set up, and
// again only if the token ever needs replacing.
//
// You need two things:
//   1. APP_SECRET — Meta app "Bequest Social Publisher" → App settings → Basic →
//      App secret → Show (Facebook will ask for your password to reveal it).
//   2. A short-lived user token — Graph API Explorer
//      (https://developers.facebook.com/tools/explorer/2015359832423958/):
//      "User or Page" = Get Token → Get User Access Token, ensure these scopes
//      are checked: pages_show_list, pages_manage_posts, pages_read_engagement,
//      business_management, instagram_basic, instagram_content_publish, then
//      click "Generate Access Token" and copy it.
//
// Then run:
//   APP_ID=2015359832423958 \
//   APP_SECRET=xxxxxxxx \
//   SHORT_TOKEN=EAAxxxxxxxx \
//   PAGE_ID=996611156867180 \
//   node src/meta-longlived-token.js
//
// It prints the non-expiring Page token. Paste that into the GitHub repo secret
// META_ACCESS_TOKEN (Settings → Secrets and variables → Actions), or run:
//   echo -n '<printed token>' | gh secret set META_ACCESS_TOKEN
const APP_ID = process.env.APP_ID || '2015359832423958';
const PAGE_ID = process.env.PAGE_ID || '996611156867180';
const { APP_SECRET, SHORT_TOKEN } = process.env;
const GRAPH = 'https://graph.facebook.com/v21.0';

async function j(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d;
}

async function main() {
  if (!APP_SECRET || !SHORT_TOKEN) {
    console.error('Set APP_SECRET and SHORT_TOKEN env vars. See the header of this file.');
    process.exit(1);
  }

  // 1. short-lived user token -> long-lived user token (~60 days)
  const longUser = await j(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${APP_ID}&client_secret=${encodeURIComponent(APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(SHORT_TOKEN)}`
  );

  // 2. long-lived user token -> Page token. A Page token derived from a
  //    long-lived user token does not expire.
  const page = await j(
    `${GRAPH}/${PAGE_ID}?fields=name,access_token&access_token=${encodeURIComponent(longUser.access_token)}`
  );

  // 3. confirm it's non-expiring and has the scopes we need
  const dbg = await j(
    `${GRAPH}/debug_token?input_token=${encodeURIComponent(page.access_token)}` +
      `&access_token=${encodeURIComponent(page.access_token)}`
  );
  const exp = dbg.data?.expires_at;

  console.error(`Page: ${page.name} (${PAGE_ID})`);
  console.error(`Token type: ${dbg.data?.type}  expires_at: ${exp === 0 ? 'never' : new Date(exp * 1000).toISOString()}`);
  console.error(`Scopes: ${(dbg.data?.scopes || []).join(', ')}`);
  console.error('\n--- META_ACCESS_TOKEN (paste into the GitHub secret) ---');
  console.log(page.access_token);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
