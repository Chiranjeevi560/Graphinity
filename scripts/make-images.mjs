// Draws the PNG icons and the link-preview image from the SVG logo, using
// the Chromium that Playwright already installed. Run after changing the
// logo, then commit the files in apps/web/public:
//
//   node scripts/make-images.mjs
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const out = new URL('../apps/web/public/', import.meta.url);
const logo = readFileSync(new URL('icon.svg', out), 'utf8');
// The three people and their links, without the squircle behind them.
const glyph =
  '<path d="M19 23 L45 23 L32 45" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>' +
  '<circle cx="19" cy="23" r="6" fill="#fff"/><circle cx="45" cy="23" r="6" fill="#fff"/><circle cx="32" cy="45" r="6" fill="#fff"/>';
// Full-bleed square: iOS and Android cut their own shape. The glyph is
// nudged to the visual centre and kept inside the maskable safe zone.
const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#5856d6"/><g transform="translate(0 -2)">${glyph}</g></svg>`;

const page = await (await chromium.launch()).newPage();
async function shot(file, width, height, body, transparent = false) {
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;width:${width}px;height:${height}px}svg{display:block;width:100%;height:100%}</style>${body}`,
  );
  await page.screenshot({ path: new URL(file, out).pathname, omitBackground: transparent });
  console.log(`wrote ${file} (${width}x${height})`);
}

await shot('apple-touch-icon.png', 180, 180, square);
await shot('icon-maskable-512.png', 512, 512, square);
await shot('icon-192.png', 192, 192, logo, true);
await shot('icon-512.png', 512, 512, logo, true);
await shot(
  'og.png',
  1200,
  630,
  `
  <div style="width:1200px;height:630px;background:#f5f5f7;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif">
    <div style="width:168px;height:168px">${logo}</div>
    <div style="margin-top:44px;font-size:80px;font-weight:600;letter-spacing:-0.02em;color:#1d1d1f">Graphinity</div>
    <div style="margin-top:14px;font-size:38px;color:#6e6e73;letter-spacing:-0.01em">Ask once. Reach people who’ve done it.</div>
  </div>`,
);
await page.context().browser().close();
