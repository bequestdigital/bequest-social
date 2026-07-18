// Weekly Meta token health check. Long-lived Page tokens expire (~60 days);
// this opens a GitHub issue when the token is dead or expiring soon so a
// refresh never gets missed.
//
// Env: META_ACCESS_TOKEN (required); GITHUB_TOKEN + GITHUB_REPOSITORY to open issues.
import { openIssue } from './notify.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const WARN_DAYS = 14;

async function main() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN not set');

  // Liveness check.
  const me = await fetch(`${GRAPH}/me?access_token=${encodeURIComponent(token)}`).then((r) => r.json());
  if (me.error) {
    await report(
      'Meta access token is DEAD — publishing will fail',
      `\`GET /me\` returned:\n\`\`\`\n${JSON.stringify(me.error, null, 2)}\n\`\`\`\nFollow the token refresh steps in the README, then update the \`META_ACCESS_TOKEN\` secret.`
    );
    process.exit(1);
  }
  console.log(`Token OK — acting as: ${me.name || me.id}`);

  // Expiry check (debug_token inspecting itself works for user/page tokens).
  const dbg = await fetch(
    `${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`
  ).then((r) => r.json());
  const expiresAt = dbg?.data?.expires_at;
  if (expiresAt === 0) {
    console.log('Token reports no expiry (never-expiring Page token). Nothing to do.');
    return;
  }
  if (expiresAt) {
    const daysLeft = Math.floor((expiresAt * 1000 - Date.now()) / 86400000);
    console.log(`Token expires in ${daysLeft} day(s).`);
    if (daysLeft <= WARN_DAYS) {
      await report(
        `Meta access token expires in ${daysLeft} day(s)`,
        `The \`META_ACCESS_TOKEN\` secret expires on ${new Date(expiresAt * 1000).toISOString().slice(0, 10)}. Follow the token refresh steps in the README and update the secret before then.`
      );
    }
  } else {
    console.log('Could not read expiry from debug_token — skipping expiry check.');
  }
}

async function report(title, body) {
  console.error(title);
  if (process.env.GITHUB_TOKEN) {
    await openIssue(title, body, ['automation', 'credentials']).catch((e) =>
      console.error(`Could not open issue: ${e.message}`)
    );
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
