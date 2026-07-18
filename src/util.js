import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONTENT = path.join(ROOT, 'content');
export const QUEUE = path.join(CONTENT, 'queue');
export const APPROVED = path.join(CONTENT, 'approved');
export const PUBLISHED = path.join(CONTENT, 'published');

export function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// ---- dates (all scheduling decisions happen in America/New_York) ----

export function isoDateET(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function todayET() {
  return isoDateET(new Date());
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 0=Sun .. 6=Sat for a YYYY-MM-DD calendar date
export function weekdayOf(iso) {
  return new Date(iso + 'T12:00:00Z').getUTCDay();
}

// The Monday of the week containing (or starting after) the given date.
// From a Sunday this returns the next day's Monday — i.e. the coming week.
export function nextMonday(iso) {
  let d = iso;
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

// ---- resilience ----

export async function retry(fn, { attempts = 3, baseMs = 2000, label = 'operation' } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (i < attempts) {
        const wait = baseMs * 2 ** (i - 1);
        console.warn(`[retry] ${label}: attempt ${i} failed (${e.message}); retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw last;
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// X counts URLs as 23 chars regardless of length; everything else ~1 per code point.
export function xLength(text) {
  const t = String(text).replace(/https?:\/\/\S+/g, 'x'.repeat(23));
  return Array.from(t).length;
}

// ---- Chrome for Puppeteer (local Mac or GitHub Actions ubuntu runner) ----

export function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const found = execSync(
      'which google-chrome google-chrome-stable chromium chromium-browser 2>/dev/null | head -1',
      { encoding: 'utf8' }
    ).trim();
    if (found) return found;
  } catch {
    /* fall through */
  }
  throw new Error('Chrome not found. Set PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium binary.');
}

// ---- GitHub REST (used by notify.js; needs GITHUB_TOKEN + GITHUB_REPOSITORY) ----

export async function ghApi(pathname, { method = 'GET', body } = {}) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN must be set');
  const res = await fetch(`https://api.github.com${pathname.replace('{repo}', repo)}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'bequest-social',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${pathname} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}
