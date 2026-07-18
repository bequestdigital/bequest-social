// Render a post package's branded graphic(s) to 1080x1080 JPEGs with
// Puppeteer, using the HTML/CSS templates in templates/ and brand.config.js.
// JPEG (not PNG) because Instagram's content publishing API only accepts JPEG.
//
// Usage: node src/generate-image.js <package.json> [more.json ...]
//        node src/generate-image.js --all-queue
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import brand from '../brand.config.js';
import { ROOT, QUEUE, readJSON, writeJSON, esc, findChrome } from './util.js';

const TPL_DIR = path.join(ROOT, 'templates');

function brandCss() {
  const c = brand.colors;
  return `:root {
  --forest-dark: ${c.forestDark}; --forest: ${c.forest}; --forest-light: ${c.forestLight};
  --gold: ${c.gold}; --gold-light: ${c.goldLight}; --gold-muted: ${c.goldMuted};
  --cream: ${c.cream}; --cream-dark: ${c.creamDark}; --ivory: ${c.ivory};
  --serif: ${brand.fonts.serif}; --sans: ${brand.fonts.sans};
}`;
}

let logoUriCache;
function logoUri() {
  if (!logoUriCache) {
    const p = path.join(TPL_DIR, 'assets', 'bequest-logo.png');
    logoUriCache = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  }
  return logoUriCache;
}

// The real logo (white script + gold shield, from mybequestdigital.com) reads
// on dark canvases; light canvases get a typeset forest-green wordmark.
const LOGO_IMG = () => `<img class="logo" src="${logoUri()}" alt="">`;
const WORDMARK_TEXT = () =>
  `<div class="brandline"><div class="rule"></div><div class="wordmark">${esc(brand.wordmark)}</div></div>`;

function fill(templateName, tokens) {
  let html = fs.readFileSync(path.join(TPL_DIR, `${templateName}.html`), 'utf8');
  const all = {
    FONTS: `@import url('${brand.fonts.googleImport}');`,
    BRAND_CSS: brandCss(),
    WORDMARK: esc(brand.wordmark),
    LOGO_URI: logoUri(),
    ...tokens,
  };
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => all[key] ?? '');
}

function sizeClass(len, tiers) {
  // tiers: [[maxLen, class], ...] in ascending order; last entry is the fallback
  for (const [max, cls] of tiers) if (len <= max) return cls;
  return tiers[tiers.length - 1][1];
}

function dotsHtml(total, active) {
  return Array.from({ length: total }, (_, i) => `<span class="dot${i === active ? ' on' : ''}"></span>`).join('');
}

// Each builder returns [{ suffix, html }] — one entry per rendered image.
const builders = {
  'quote-card'(pkg) {
    const d = pkg.image.data;
    return [
      {
        suffix: '',
        html: fill('quote-card', {
          EYEBROW: esc(d.eyebrow || pkg.weekTheme || ''),
          QUOTE: esc(d.quote),
          ATTRIBUTION: esc(d.attribution || ''),
          SIZE_CLASS: sizeClass(d.quote.length, [[80, 'q-xl'], [130, 'q-lg'], [190, 'q-md'], [Infinity, 'q-sm']]),
        }),
      },
    ];
  },

  'tip-card'(pkg) {
    const d = pkg.image.data;
    const items = d.items
      .map((t, i) => `<div class="item"><div class="num">${i + 1}</div><div class="text">${esc(t)}</div></div>`)
      .join('');
    return [
      {
        suffix: '',
        html: fill('tip-card', {
          EYEBROW: esc(d.eyebrow || pkg.weekTheme || ''),
          TITLE: esc(d.title),
          TITLE_CLASS: sizeClass(d.title.length, [[45, 't-lg'], [Infinity, 't-md']]),
          ITEMS: items,
          ITEMS_CLASS: sizeClass(d.items.length, [[4, 'i-lg'], [6, 'i-md'], [Infinity, 'i-sm']]),
        }),
      },
    ];
  },

  carousel(pkg) {
    const d = pkg.image.data;
    const total = d.slides.length + 2; // cover + items + end
    const eyebrow = esc(d.eyebrow || pkg.weekTheme || '');
    const out = [];
    out.push({
      suffix: '-1',
      html: fill('carousel', {
        MODE: 'cover',
        EYEBROW: eyebrow,
        BRANDMARK: LOGO_IMG(),
        DOTS: dotsHtml(total, 0),
        SLIDE_CONTENT: `<div class="cover-main"><div class="cover-title">${esc(d.cover.title)}</div><div class="cover-sub">${esc(d.cover.subtitle || '')}</div><div class="swipe">Swipe &rarr;</div></div>`,
      }),
    });
    d.slides.forEach((s, i) => {
      out.push({
        suffix: `-${i + 2}`,
        html: fill('carousel', {
          MODE: 'item',
          EYEBROW: eyebrow,
          BRANDMARK: WORDMARK_TEXT(),
          DOTS: dotsHtml(total, i + 1),
          SLIDE_CONTENT: `<div class="slide-num">${String(i + 1).padStart(2, '0')}</div><div class="slide-main"><div class="slide-title">${esc(s.title)}</div><div class="slide-body">${esc(s.body || '')}</div></div>`,
        }),
      });
    });
    out.push({
      suffix: `-${total}`,
      html: fill('carousel', {
        MODE: 'end',
        EYEBROW: eyebrow,
        BRANDMARK: LOGO_IMG(),
        DOTS: dotsHtml(total, total - 1),
        SLIDE_CONTENT: `<div class="end-main"><div class="end-title">${esc(d.end?.title || 'Your mission deserves marketing that works.')}</div><div class="end-sub">${esc(d.end?.subtitle || brand.url.replace('https://', ''))}</div></div>`,
      }),
    });
    return out;
  },

  diagram(pkg) {
    const d = pkg.image.data;
    const eyebrow = esc(d.eyebrow || pkg.weekTheme || '');
    let content;
    if (d.mode === 'circles') {
      const [inner, middle, outer] = d.circles;
      content = `<div class="circle-stage">
        <div class="ring outer"></div>
        <div class="ring middle"></div>
        <div class="ring inner"><div class="c-label">${esc(inner.label)}</div><div class="c-sub">${esc(inner.sub || '')}</div></div>
        <div class="band middle-band" style="top: 96px;"><div class="c-label">${esc(middle.label)}</div><div class="c-sub">${esc(middle.sub || '')}</div></div>
        <div class="band outer-band" style="top: -8px;"><div class="c-label">${esc(outer.label)}</div><div class="c-sub">${esc(outer.sub || '')}</div></div>
      </div>`;
    } else {
      const colHtml = (side, col) =>
        `<div class="col ${side}"><div class="label">${esc(col.label)}</div><div class="rows">${col.items
          .map((t) => `<div class="row"><div class="bullet"></div><div>${esc(t)}</div></div>`)
          .join('')}</div></div>`;
      content = `<div class="cols">${colHtml('left', d.columns.left)}${colHtml('right', d.columns.right)}<div class="vs">vs</div></div>`;
    }
    return [
      {
        suffix: '',
        html: fill('diagram', {
          MODE: d.mode,
          EYEBROW: eyebrow,
          TITLE: esc(d.title || ''),
          BRANDMARK: d.mode === 'circles' ? LOGO_IMG() : WORDMARK_TEXT(),
          DIAGRAM_CONTENT: content,
        }),
      },
    ];
  },

  'stat-card'(pkg) {
    const d = pkg.image.data;
    return [
      {
        suffix: '',
        html: fill('stat-card', {
          EYEBROW: esc(d.eyebrow || pkg.weekTheme || ''),
          STAT: esc(d.stat),
          STAT_CLASS: sizeClass(String(d.stat).length, [[4, 's-xl'], [8, 's-lg'], [Infinity, 's-md']]),
          LABEL: esc(d.label || ''),
          CONTEXT: esc(d.context),
        }),
      },
    ];
  },
};

async function renderPackage(browser, pkgPath) {
  const pkg = readJSON(pkgPath);
  const builder = builders[pkg.image.template];
  if (!builder) throw new Error(`${pkgPath}: unknown template "${pkg.image.template}"`);

  const dir = path.dirname(pkgPath);
  const base = path.basename(pkgPath, '.json');
  const files = [];

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });
  for (const { suffix, html } of builder(pkg)) {
    const file = `${base}${suffix}.jpg`;
    // 'networkidle0' can hang on repeated setContent with @imported webfonts;
    // instead wait for load, force the brand fonts, then wait for fonts.ready.
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load('600 40px "Cormorant Garamond"'),
        document.fonts.load('700 40px "Cormorant Garamond"'),
        document.fonts.load('400 30px "Source Sans 3"'),
        document.fonts.load('600 30px "Source Sans 3"'),
      ]);
      await document.fonts.ready;
    });
    await page.screenshot({ path: path.join(dir, file), type: 'jpeg', quality: 92 });
    files.push(file);
    console.log(`  rendered ${path.relative(ROOT, path.join(dir, file))}`);
  }
  await page.close();

  pkg.image.files = files;
  writeJSON(pkgPath, pkg);
}

async function main() {
  let targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (process.argv.includes('--all-queue')) {
    targets = fs
      .readdirSync(QUEUE)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(QUEUE, f));
  }
  if (!targets.length) {
    console.error('Usage: node src/generate-image.js <package.json>... | --all-queue');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb', '--hide-scrollbars'],
  });
  try {
    for (const t of targets) await renderPackage(browser, path.resolve(t));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
