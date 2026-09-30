#!/usr/bin/env node
/**
 * 렌더링 회귀 테스트 러너
 *
 * 빌드된 dist/ui.html 을 실제 플러그인 크기(400x580) iframe 에 띄우고,
 * dist/code.js 는 Figma API 목(test/figma-mock.js) 위에서 실행한다.
 * 케이스별 HTML 을 가져오기 → 생성된 Figma 노드 트리를 수치로 판정한다.
 *
 *   node test/run.mjs                 # 전체
 *   node test/run.mjs --grep shadow   # id/제목 필터
 *   node test/run.mjs --dist <dir>    # 다른 빌드 결과물로 실행 (수정 전 빌드와 비교)
 *   node test/run.mjs --grep br --dump  # 생성된 노드 트리를 요약 출력
 *   node test/run.mjs --html page.html --width 375   # 임의 HTML 파일을 가져와 트리만 출력
 *   node test/run.mjs --html page.html --autolayout  # Auto Layout 옵션을 켜고 가져오기
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { cases } from './cases.mjs';
import { createT } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const distDir = path.resolve(argOf('--dist') || path.join(here, '..', 'dist'));
const grep = argOf('--grep');
const dump = args.includes('--dump');

/** 노드 트리 요약: 종류·이름·위치·크기와 텍스트 속성 */
function summarize(n, depth = 0, out = []) {
  const r = (v) => Math.round(v * 10) / 10;
  let line = `${'  '.repeat(depth)}${n.type} "${n.name}" (${r(n.x)},${r(n.y)} ${r(n.width)}x${r(n.height)})`;
  if (n.layoutMode && n.layoutMode !== 'NONE') line += ` [${n.layoutMode} gap=${n.itemSpacing} ${n.primaryAxisAlignItems}/${n.counterAxisAlignItems}]`;
  if (n.type === 'TEXT') line += ` ${JSON.stringify(n.characters)} ${n.textAutoResize} ${n.textAlignHorizontal} ${n.fontName.family}/${n.fontName.style}`;
  if (n.type !== 'TEXT' && n.fills?.length) line += ` fills=[${n.fills.map((f) => f.type === 'IMAGE' ? `IMAGE:${f.scaleMode}` : f.type).join(',')}]`;
  if (n.svg) line += ` ${n.svg.length > 240 ? n.svg.slice(0, 240) + '…' : n.svg}`;
  out.push(line);
  for (const c of n.children || []) summarize(c, depth + 1, out);
  return out.join('\n');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url.startsWith('/dist/')) file = path.join(distDir, url.slice(6));
  else if (url.startsWith('/test/')) file = path.join(here, url.slice(6));
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const htmlFile = argOf('--html');
const selected = htmlFile
  ? [{
    id: path.basename(htmlFile),
    title: '임의 HTML 가져오기',
    width: Number(argOf('--width') || 1440),
    options: { autoLayout: args.includes('--autolayout') },
    html: fs.readFileSync(htmlFile, 'utf8'),
    check: (res) => console.log(res.roots.map((r) => summarize(r)).join('\n')),
  }]
  : cases.filter((c) => !grep || c.id.includes(grep) || c.title.includes(grep));
// 설치된 Chrome 을 우선 사용하고, 없으면 Playwright 브라우저(npx playwright install chromium)로 실행
const browser = await chromium
  .launch({ channel: 'chrome', headless: true })
  .catch(() => chromium.launch({ headless: true }));
const results = [];

async function freshPage() {
  const page = await browser.newPage({ viewport: { width: 420, height: 600 } });
  await page.goto(`${base}/test/harness.html`);
  const ready = await page.evaluate(() => window.uiReady());
  if (!ready) throw new Error('harness UI did not load');
  return page;
}

// 기본 폰트를 sans-serif 로 고정해 목의 글자 폭 측정과 DOM 측정을 맞춘다 (전체 문서는 그대로 둔다)
const withBaseFont = (html) =>
  /<html[\s>]|<!doctype/i.test(html) ? html : `<style>body{font-family:Inter,sans-serif}</style>${html}`;

let page = await freshPage();
for (const c of selected) {
  const t = createT();
  let error;
  try {
    const steps = c.sequence || (c.html ? [c] : []);
    let res = { roots: [], selected: [] };
    for (const { html, width, theme, options, selectFrame } of steps) {
      res = await page.evaluate((s) => window.runCase(s), { html: withBaseFont(html), width, theme, options, selectFrame });
    }
    // 가져오기 뒤 UI 동작 (새로 띄우기·파일 끌어놓기 등)
    if (c.uiAction) res.ui = await page.evaluate(({ name, args }) => window[name](...args), c.uiAction);
    if (dump) console.log(res.roots.map((r) => summarize(r)).join('\n'));
    c.check({ ...res, root: res.roots[0] }, t);
  } catch (e) {
    error = String(e && e.message ? e.message : e).split('\n')[0];
    // UI 가 죽었으면 다음 케이스를 위해 새로 띄운다
    await page.close().catch(() => {});
    page = await freshPage();
  }
  const pass = !error && t.fails.length === 0;
  results.push({ id: c.id, title: c.title, pass, detail: error || t.fails.join(' / ') });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(28)} ${c.title}${pass ? '' : `\n      → ${error || t.fails.join(' / ')}`}`);
}

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed  (dist: ${distDir})`);
process.exit(failed.length ? 1 : 0);
