/**
 * Text contrast, measured the way the browser paints it (tools/contrast.js).
 *
 *   node tools/contrast.js                       # all ten panels, both themes
 *   node tools/contrast.js --panels=editor --themes=light
 *
 * axe-core cannot answer this question for this build. Most of the surfaces are
 * `color-mix()` layers, which Chrome serialises as `color(srgb r g b / a)`, and
 * axe declines to resolve a translucent background against what is under it - so
 * it returns roughly 1,370 `color-contrast` results as *incomplete* and the
 * violation count stays at zero whether the text reads or not. That is the gap
 * this tool closes: it composites every translucent layer from the root down to
 * the element, exactly as the renderer does, and judges the result.
 *
 * Two rules it applies and one it refuses:
 *   - 4.5:1 for ordinary text, 3:1 at 24px or at 18.66px bold (WCAG's large-text
 *     bar), because that is the floor the token ramp is documented against;
 *   - it skips text whose own colour is translucent, because a half-alpha ink
 *     is a deliberate wash and compositing it against one ground would invent a
 *     number the design never claimed.
 *
 * The defects it was written for were real and are named in LOAD_CHAOS.md: a
 * code surface that borrowed its card's background painted mint on paper in the
 * daylight theme (1.57:1), and a theme-relative `--dim` span inside a status
 * strip that stays dark in both themes painted dark on dark (2.6:1).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Browser, parseArgs, startProjectServer } from './cdp.js';

const args = parseArgs();
const PORT = Number(args.port || 5233);
const OUT = String(args.out || 'docs/reports/contrast.json');
const PANELS = String(args.panels || 'dashboard,editor,compiler,engine,e2ee,mesh,offline,a11y,hardening,assistant').split(',');
const THEMES = String(args.themes || 'light,dark').split(',');
const WIDTH = Number(args.width || 1440);
const HEIGHT = Number(args.height || 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const parse = (c) => {
    const str = String(c);
    const nums = (str.match(/[\\d.eE+-]+/g) || ['0', '0', '0', '0']).map(Number);
    let r = nums[0], g = nums[1], b = nums[2], a = nums.length > 3 ? nums[3] : 1;
    // Chrome serialises color-mix() results as color(srgb r g b / a) with 0..1
    // channels; reading those as 0..255 makes every colour look black.
    if (/color\\(srgb/.test(str)) { r *= 255; g *= 255; b *= 255; }
    if (Number.isNaN(a)) a = 1;
    return [r, g, b, Math.min(1, Math.max(0, a))];
  };
  const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])];
  const lum = (rgb) => {
    const f = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const ground = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) chain.unshift(n);
    let acc = [255, 255, 255];
    for (const n of chain) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) acc = over(c, acc); }
    return acc;
  };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (el.className && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
  const fails = [];
  let judged = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg')) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const fg = parse(cs.color);
    if (fg[3] < 1) continue;
    judged += 1;
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const bg = ground(el);
    const r = ratio(fg, bg);
    if (r < need) fails.push({ selector: name(el), text: el.textContent.trim().slice(0, 60), px, need, ratio: Math.round(r * 100) / 100, color: cs.color, ground: bg.map(Math.round).join(',') });
  }
  fails.sort((a, b) => a.ratio - b.ratio);
  return { judged, fails: fails.slice(0, 20) };
})()`;

const { proc, origin } = await startProjectServer({ port: PORT });
const browser = await Browser.launch({ width: WIDTH, height: HEIGHT, scale: 1 });
const session = await browser.newSession('about:blank');
const report = {
  measuredAt: new Date().toISOString(),
  url: origin + '/',
  viewport: { width: WIDTH, height: HEIGHT },
  note: 'every element that renders its own text node, both themes, every panel; translucent backgrounds composited from the root down the way the renderer does; text whose own colour is translucent is not judged',
  threshold: { normal: 4.5, large: 3, largeAt: '24px, or 18.66px at weight 700' },
  surfaces: [],
};

for (const theme of THEMES) {
  for (const panel of PANELS) {
    await session.navigate(`${origin}/?theme=${theme}#${panel}`);
    await session.waitFor('document.querySelectorAll("#tabs [role=tab]").length > 0', { timeoutMs: 90000 });
    await sleep(4500);
    const out = await session.evaluate(PROBE);
    report.surfaces.push({ theme, panel, judged: out.judged, failures: out.fails });
    console.log(`${out.fails.length ? 'FAIL' : 'ok  '} | ${theme} #${panel} | ${out.judged} text elements judged | ${out.fails.length} below AA`);
    for (const f of out.fails) console.log(`       ${f.ratio} (need ${f.need}) at ${f.px}px  ${f.selector}  "${f.text}"  ${f.color} on ${f.ground}`);
  }
}

report.totalFailures = report.surfaces.reduce((n, s) => n + s.failures.length, 0);
report.worst = report.surfaces.flatMap((s) => s.failures.map((f) => ({ theme: s.theme, panel: s.panel, ...f }))).sort((a, b) => a.ratio - b.ratio)[0] || null;
console.log(`\n# judged ${report.surfaces.reduce((n, s) => n + s.judged, 0)} text elements across ${report.surfaces.length} surfaces`);
console.log(`# ${report.totalFailures} below the floor${report.worst ? `; worst ${report.worst.ratio}:1 at ${report.worst.theme} #${report.worst.panel} ${report.worst.selector}` : ''}`);

mkdirSync(OUT.split('/').slice(0, -1).join('/') || '.', { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(`# report -> ${OUT}`);
await browser.close();
proc && proc.kill();
if (report.totalFailures > 0) process.exitCode = 1;
