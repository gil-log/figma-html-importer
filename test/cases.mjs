/**
 * 케이스 표 — 한 행 = 브라우저 렌더링과 Figma 결과가 같아야 하는 조건 하나.
 * check(result, t): result.root = 생성된 루트 노드(JSON), result.roots = 전체 루트, result.done = 완료 메시지
 */
import fs from 'node:fs';
import { find, all, findText, findTextIncl, texts, solid, hasSolid, gradientHandles } from './helpers.mjs';

const TW = '<script src="https://cdn.tailwindcss.com"></script>';
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SVG_IMG = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')}`;
const imageFill = (n) => (n?.fills || []).find((f) => f.type === 'IMAGE');
const frameBy = (root, pred) => find(root, (n) => n.type === 'FRAME' && pred(n));
const solidFrame = (root, rgb) => frameBy(root, (n) => hasSolid(n, rgb));

export const cases = [
  // ── 폰트 굵기 ──────────────────────────────────────────────
  {
    id: 'font-weight-400',
    title: '굵기 400 텍스트는 Regular, 300·600·700 은 각각 Light·Semi Bold·Bold 로 들어간다',
    width: 375,
    html: '<div><p style="font-weight:400">w400</p><p style="font-weight:300">w300</p><p style="font-weight:600">w600</p><p style="font-weight:700">w700</p></div>',
    check: ({ root }, t) => {
      t.eq(findText(root, 'w400')?.fontName?.style, 'Regular', 'w400');
      t.eq(findText(root, 'w300')?.fontName?.style, 'Light', 'w300');
      t.eq(findText(root, 'w600')?.fontName?.style, 'Semi Bold', 'w600');
      t.eq(findText(root, 'w700')?.fontName?.style, 'Bold', 'w700');
    },
  },
  {
    id: 'font-installed-family',
    title: 'Figma 에 설치된 폰트는 CSS font-family 이름 그대로 쓰고 굵기를 맞춘다',
    width: 375,
    html: '<div><p style="font-family:Roboto;font-weight:500">roboto</p></div>',
    check: ({ root }, t) => t.eq(findText(root, 'roboto')?.fontName, { family: 'Roboto', style: 'Medium' }, 'font'),
  },
  {
    id: 'font-family-fallback-list',
    title: 'font-family 목록의 앞쪽 폰트가 없으면 다음 폰트를 쓴다',
    width: 375,
    html: '<div><p style="font-family:\'Unknown Brand\', \'Open Sans\', sans-serif;font-weight:600">fallback</p></div>',
    check: ({ root }, t) => t.eq(findText(root, 'fallback')?.fontName, { family: 'Open Sans', style: 'SemiBold' }, 'font'),
  },
  {
    id: 'font-korean-system',
    title: '시스템 폰트로 지정된 한글은 한글 글꼴, 영문은 Inter 로 들어간다',
    width: 375,
    html: '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif"><p>한글 텍스트</p><p>Latin text</p></div>',
    check: ({ root }, t) => {
      t.eq(findText(root, '한글 텍스트')?.fontName?.family, 'Noto Sans KR', 'korean');
      t.eq(findText(root, 'Latin text')?.fontName?.family, 'Inter', 'latin');
    },
  },
  {
    id: 'font-weight-italic-combo',
    title: '굵기와 이탤릭이 함께 있으면 같은 조합의 스타일을 고른다 (600 이탤릭 → Semi Bold Italic)',
    width: 375,
    html: '<div><p style="font-weight:600;font-style:italic">combo</p><p style="font-family:\'Noto Sans KR\';font-weight:600">붙임</p></div>',
    check: ({ root }, t) => {
      t.eq(findText(root, 'combo')?.fontName?.style, 'Semi Bold Italic', 'inter semibold italic');
      t.eq(findText(root, '붙임')?.fontName?.style, 'SemiBold', 'compact style name');
    },
  },
  {
    id: 'font-italic-400',
    title: '굵기 400 이탤릭은 Italic 스타일로 들어간다',
    width: 375,
    html: '<div><em style="display:block">italic</em></div>',
    check: ({ root }, t) => t.eq(findText(root, 'italic')?.fontName?.style, 'Italic', 'style'),
  },

  // ── 그림자 ────────────────────────────────────────────────
  {
    id: 'shadow-single',
    title: 'box-shadow 는 같은 오프셋·blur·색의 드롭 섀도로 들어간다',
    width: 375,
    html: '<div style="padding:20px"><div style="width:80px;height:40px;background:#fff;box-shadow:0 4px 16px rgba(0,0,0,.2)"></div></div>',
    check: ({ root }, t) => {
      const f = frameBy(root, (n) => n.width === 80 && n.height === 40);
      const e = f?.effects?.[0];
      t.eq(e?.type, 'DROP_SHADOW', 'type');
      t.near(e?.offset?.y, 4, 0.01, 'offset.y');
      t.near(e?.radius, 16, 0.01, 'radius');
      t.near(e?.color?.a, 0.2, 0.01, 'alpha');
    },
  },
  {
    id: 'shadow-multi-inset',
    title: '여러 겹 그림자와 inset 그림자가 모두 들어간다',
    width: 375,
    html: '<div style="padding:20px"><div style="width:80px;height:40px;background:#fff;box-shadow:inset 0 0 0 1px red, 0 2px 4px rgba(0,0,0,.3)"></div></div>',
    check: ({ root }, t) => {
      const types = (frameBy(root, (n) => n.width === 80)?.effects || []).map((e) => e.type).sort();
      t.eq(types, ['DROP_SHADOW', 'INNER_SHADOW'], 'effect types');
    },
  },
  {
    id: 'shadow-tailwind',
    title: 'Tailwind shadow-lg 는 투명 링을 빼고 2겹 드롭 섀도로 들어간다',
    width: 375,
    html: `${TW}<div class="p-6"><div class="h-10 w-40 bg-white shadow-lg rounded-xl"></div></div>`,
    check: ({ root }, t) => {
      const effects = frameBy(root, (n) => n.width === 160)?.effects || [];
      t.eq(effects.map((e) => e.type), ['DROP_SHADOW', 'DROP_SHADOW'], 'types');
      t.eq(effects.map((e) => e.offset.y).sort((a, b) => a - b), [4, 10], 'offsets');
    },
  },

  {
    id: 'shadow-ring-transparent',
    title: '배경 없는 요소의 링 그림자(0 0 0 Npx)는 바깥 테두리로 들어간다',
    width: 375,
    html: '<div style="padding:10px"><div style="width:80px;height:30px;box-shadow:0 0 0 2px blue"></div></div>',
    check: ({ root }, t) => {
      const f = frameBy(root, (n) => n.width === 80);
      t.eq(f?.strokes?.[0]?.color?.b, 1, 'blue stroke');
      t.eq(f?.strokeWeight, 2, 'weight');
      t.eq(f?.strokeAlign, 'OUTSIDE', 'align');
    },
  },

  // ── 투명도 ────────────────────────────────────────────────
  {
    id: 'opacity-zero',
    title: 'opacity:0 요소는 투명도 0 으로 들어간다',
    width: 375,
    html: '<div><div style="opacity:0;width:50px;height:20px;background:red"></div><p>x</p></div>',
    check: ({ root }, t) => t.eq(solidFrame(root, [255, 0, 0])?.opacity, 0, 'opacity'),
  },
  {
    id: 'opacity-text',
    title: '텍스트에도 opacity 가 적용된다',
    width: 375,
    html: '<div><p style="opacity:.5">half</p></div>',
    check: ({ root }, t) => t.near(findText(root, 'half')?.opacity, 0.5, 0.001, 'opacity'),
  },

  // ── 텍스트 내용 ───────────────────────────────────────────
  {
    id: 'whitespace-collapse',
    title: 'HTML 소스의 줄바꿈·들여쓰기·연속 공백은 한 칸으로 합쳐진다',
    width: 375,
    html: '<div style="width:300px"><p>\n    Hello\n    world   again\n  </p></div>',
    check: ({ root }, t) => t.ok(findText(root, 'Hello world again'), `texts: ${JSON.stringify(texts(root).map((n) => n.characters))}`),
  },
  {
    id: 'whitespace-pre',
    title: 'pre 안의 줄바꿈과 들여쓰기는 유지된다',
    width: 375,
    html: '<div><pre style="margin:0">line1\n  line2</pre></div>',
    check: ({ root }, t) => t.ok(findText(root, 'line1\n  line2'), `texts: ${JSON.stringify(texts(root).map((n) => n.characters))}`),
  },
  {
    id: 'text-transform',
    title: 'text-transform:uppercase 는 대문자로 표시된다 (textCase UPPER)',
    width: 375,
    html: '<div><span style="text-transform:uppercase">upper me</span></div>',
    check: ({ root }, t) => {
      const n = findText(root, 'upper me');
      // 노드 전체 구간에 range 로 건 값은 Figma 에서 노드 속성과 같다
      const whole = n?.ranges?.some((r) => r.kind === 'textCase' && r.value === 'UPPER' && r.start === 0 && r.end === n.characters.length);
      t.ok(n?.textCase === 'UPPER' || whole, `textCase ${n?.textCase} ranges ${JSON.stringify(n?.ranges)}`);
    },
  },
  {
    id: 'hidden-inline-text',
    title: 'display:none 인 인라인 자식의 글자는 포함되지 않는다',
    width: 375,
    html: '<div style="width:300px"><p>Visible<span style="display:none"> hidden</span></p></div>',
    check: ({ root }, t) => t.ok(findText(root, 'Visible'), `texts: ${JSON.stringify(texts(root).map((n) => n.characters))}`),
  },
  {
    id: 'br-lines',
    title: '<br> 로 나눈 줄은 위아래로 유지된다',
    width: 375,
    html: '<div style="width:300px"><p>Line one<br>Line two</p></div>',
    check: ({ root }, t) => {
      const one = findTextIncl(root, 'Line one');
      const two = findTextIncl(root, 'Line two');
      t.ok(one && two, 'both lines exist');
      const same = one && two && one.characters === two.characters;
      if (one && two && !same) t.ok(two.ay > one.ay, 'second line below first');
      if (same) t.eq(one.characters, 'Line one\nLine two', 'merged lines');
    },
  },

  // ── 텍스트 위치·줄바꿈 ─────────────────────────────────────
  {
    id: 'center-wrap',
    title: '가운데 정렬 문단이 브라우저에서 여러 줄이면 같은 폭으로 줄바꿈된다',
    width: 1440,
    html: '<div style="width:200px"><p style="text-align:center;font-size:16px;line-height:24px">This is a centered paragraph that wraps onto several lines</p></div>',
    check: ({ root }, t) => {
      const n = findTextIncl(root, 'centered paragraph');
      t.eq(n?.textAutoResize, 'HEIGHT', 'autoResize');
      t.near(n?.width, 200, 1, 'width');
      t.eq(n?.textAlignHorizontal, 'CENTER', 'align');
    },
  },
  {
    id: 'padding-text',
    title: '배경 없는 요소의 padding 안쪽에 텍스트가 놓인다',
    width: 375,
    html: '<ul style="margin:0;padding:0;list-style:none;width:300px"><li style="padding:12px 16px;font-size:14px;line-height:20px">Item one</li></ul>',
    check: ({ root }, t) => {
      const n = findText(root, 'Item one');
      t.near(n?.ax, 16, 1, 'x');
      t.near(n && n.ay + n.height / 2, 22, 2, 'center y');
    },
  },
  {
    id: 'flex-center-text',
    title: 'flex items-center 로 세로 가운데 정렬된 텍스트는 가운데에 놓인다',
    width: 375,
    html: '<div style="width:300px"><div style="display:flex;align-items:center;height:48px;padding-left:16px;font-size:14px;line-height:20px">Item two</div></div>',
    check: ({ root }, t) => {
      const n = findText(root, 'Item two');
      t.near(n?.ax, 16, 1, 'x');
      t.near(n && n.ay + n.height / 2, 24, 2, 'center y');
    },
  },
  {
    id: 'align-end',
    title: 'text-align:end 는 오른쪽 끝에 붙는다',
    width: 375,
    html: '<div style="width:200px"><div style="text-align:end">Right</div></div>',
    check: ({ root }, t) => {
      const n = findText(root, 'Right');
      t.near(n && n.ax + n.width, 200, 1.5, 'right edge');
    },
  },
  {
    id: 'align-right-bg',
    title: '배경 있는 박스 안의 오른쪽 정렬 텍스트는 오른쪽 padding 안쪽에 붙는다',
    width: 375,
    html: '<div style="width:200px"><div style="text-align:right;background:#eee;padding:4px">Right in box</div></div>',
    check: ({ root }, t) => {
      const n = findText(root, 'Right in box');
      t.near(n && n.ax + n.width, 196, 1.5, 'right edge');
    },
  },
  {
    id: 'truncate',
    title: 'truncate(말줄임) 텍스트는 칸 폭에서 말줄임된다',
    width: 375,
    html: '<div style="width:120px"><p style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0">A very long product title that should be truncated</p></div>',
    check: ({ root }, t) => {
      const n = findTextIncl(root, 'A very long');
      t.eq(n?.textTruncation, 'ENDING', 'textTruncation');
      t.eq(n?.maxLines, 1, 'maxLines');
      t.near(n?.width, 120, 1, 'width');
    },
  },
  {
    id: 'wrap-block-text',
    title: '줄바꿈되는 블록 문단은 요소 폭으로 줄바꿈된다 (기존 동작 유지)',
    width: 375,
    html: '<div style="width:200px"><p style="margin:0;font-size:14px;line-height:20px">A long paragraph of text that certainly wraps across several lines here</p></div>',
    check: ({ root }, t) => {
      const n = findTextIncl(root, 'A long paragraph');
      t.eq(n?.textAutoResize, 'HEIGHT', 'autoResize');
      t.near(n?.width, 200, 1, 'width');
    },
  },
  {
    id: 'short-text-single-line',
    title: '넓은 블록 안의 짧은 한 줄 텍스트는 줄바꿈 없는 자동 폭이다 (기존 동작 유지)',
    width: 375,
    html: '<div style="width:300px"><p style="margin:0">방문일</p></div>',
    check: ({ root }, t) => t.eq(findText(root, '방문일')?.textAutoResize, 'WIDTH_AND_HEIGHT', 'autoResize'),
  },
  {
    id: 'text-decoration',
    title: 'text-decoration:underline 은 밑줄로 들어간다 (기존 동작 유지)',
    width: 375,
    html: '<div><a href="#" style="display:block;text-decoration:underline">link</a></div>',
    check: ({ root }, t) => t.eq(findText(root, 'link')?.textDecoration, 'UNDERLINE', 'decoration'),
  },

  // ── 단일 요소 ─────────────────────────────────────────────
  {
    id: 'root-text',
    title: '요소 하나만 붙여넣어도 그 안의 텍스트가 들어간다',
    width: 375,
    html: '<button style="padding:8px 16px;background:#333;color:#fff;border:0;border-radius:6px">Submit</button>',
    check: ({ root }, t) => t.ok(findText(root, 'Submit'), 'text Submit exists'),
  },
  {
    id: 'root-svg',
    title: 'SVG 하나만 붙여넣어도 벡터가 들어간다',
    width: 375,
    html: '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="red"/></svg>',
    check: ({ root }, t) => t.ok(find(root, (n) => (n.svg || '').includes('<circle')), 'svg node exists'),
  },
  {
    id: 'root-img',
    title: '이미지 하나만 붙여넣어도 이미지 크기의 레이어가 들어간다',
    width: 375,
    html: `<img src="${PNG_1PX}" style="width:40px;height:30px;display:block">`,
    check: ({ root }, t) => {
      const img = find(root, (n) => n.type === 'RECTANGLE');
      t.near(img?.width, 40, 0.5, 'width');
      t.near(img?.height, 30, 0.5, 'height');
    },
  },

  // ── Auto Layout (옵션) ────────────────────────────────────
  {
    id: 'autolayout-off-by-default',
    title: 'Auto Layout 옵션을 켜지 않으면 flex 도 절대 배치로 들어간다',
    width: 375,
    html: '<div style="display:flex;gap:8px;padding:10px;background:#eee;width:200px"><div style="width:40px;height:40px;background:red"></div><div style="width:40px;height:40px;background:red"></div></div>',
    check: ({ root }, t) => t.eq(root.layoutMode, 'NONE', 'layoutMode'),
  },
  {
    id: 'autolayout-row',
    title: '옵션을 켜면 gap·padding 이 맞는 flex 가로 줄은 Auto Layout(HORIZONTAL)이 된다',
    width: 375,
    options: { autoLayout: true },
    html: '<div style="padding:4px"><div style="display:flex;gap:8px;padding:10px;background:#eee;width:200px"><div style="width:40px;height:40px;background:red"></div><div style="width:40px;height:40px;background:lime"></div><div style="width:40px;height:40px;background:blue"></div></div></div>',
    check: ({ root }, t) => {
      const f = solidFrame(root, [238, 238, 238]);
      t.eq(f?.layoutMode, 'HORIZONTAL', 'layoutMode');
      t.eq(f?.itemSpacing, 8, 'itemSpacing');
      t.eq([f?.paddingLeft, f?.paddingTop], [10, 10], 'padding');
      t.eq(f?.children?.map((c) => JSON.stringify(solid(c))), ['[255,0,0]', '[0,255,0]', '[0,0,255]'], 'order');
    },
  },
  {
    id: 'autolayout-root',
    title: '붙여넣은 루트가 flex 줄이어도 Auto Layout 이 된다',
    width: 375,
    options: { autoLayout: true },
    html: '<div style="display:flex;gap:4px;padding:6px;background:#eee;width:120px"><div style="width:30px;height:30px;background:red"></div><div style="width:30px;height:30px;background:blue"></div></div>',
    check: ({ root }, t) => t.eq(root.layoutMode, 'HORIZONTAL', 'root layoutMode'),
  },
  {
    id: 'autolayout-column-center',
    title: '가운데 정렬된 flex 세로 배치는 VERTICAL + CENTER 정렬이 된다',
    width: 375,
    options: { autoLayout: true },
    html: '<div style="padding:4px"><div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:120px;height:120px;background:#eee"><div style="width:40px;height:20px;background:red"></div><div style="width:60px;height:20px;background:blue"></div></div></div>',
    check: ({ root }, t) => {
      const f = solidFrame(root, [238, 238, 238]);
      t.eq([f?.layoutMode, f?.primaryAxisAlignItems, f?.counterAxisAlignItems], ['VERTICAL', 'CENTER', 'CENTER'], 'layout');
    },
  },
  {
    id: 'autolayout-margin-fallback',
    title: 'margin(ml-auto 등)으로 배치된 flex 는 Auto Layout 으로 바꾸지 않고 브라우저 위치를 유지한다',
    width: 375,
    options: { autoLayout: true },
    html: '<div style="padding:4px"><div style="display:flex;gap:8px;width:200px;background:#eee"><div style="width:40px;height:40px;background:red"></div><div style="width:40px;height:40px;background:blue;margin-left:auto"></div></div></div>',
    check: ({ root }, t) => {
      const f = solidFrame(root, [238, 238, 238]);
      t.eq(f?.layoutMode, 'NONE', 'layoutMode');
      t.near(solidFrame(root, [0, 0, 255])?.x, 160, 0.5, 'right item stays at the right');
    },
  },
  {
    id: 'autolayout-absolute-child',
    title: 'Auto Layout 이 된 컨테이너의 절대위치 자식은 ABSOLUTE 로 제자리에 남는다',
    width: 375,
    options: { autoLayout: true },
    html: '<div style="padding:10px"><div style="position:relative;display:flex;gap:8px;background:#eee;width:120px"><div style="width:40px;height:40px;background:red"></div><div style="width:40px;height:40px;background:blue"></div><span style="position:absolute;top:-4px;right:-4px;width:8px;height:8px;background:lime"></span></div></div>',
    check: ({ root }, t) => {
      const f = solidFrame(root, [238, 238, 238]);
      t.eq(f?.layoutMode, 'HORIZONTAL', 'layoutMode');
      const badge = solidFrame(root, [0, 255, 0]);
      t.eq(badge?.layoutPositioning, 'ABSOLUTE', 'absolute badge');
      t.near(badge?.x, 116, 0.5, 'badge x');
    },
  },

  // ── 레이어 이름 ───────────────────────────────────────────
  {
    id: 'layer-names',
    title: '레이어 이름은 data-name·id·aria-label·alt·버튼 글자·의미 있는 클래스에서 정해지고 유틸리티 클래스는 쓰지 않는다',
    width: 375,
    html: `<div><section data-name="Hero Card" style="height:10px"></section><div id="main-nav" style="height:10px"></div><button aria-label="Close" style="width:10px;height:10px"></button><div class="product-card" style="height:10px"></div><div class="flex items-center p-4 md:p-6" style="height:10px"></div><img alt="Profile" src="${PNG_1PX}" style="width:10px;height:10px;display:block"><button style="background:#333;color:#fff">Submit</button></div>`,
    check: ({ root }, t) => {
      t.eq(root.children.map((c) => c.name), ['Hero Card', 'div#main-nav', 'button · Close', 'div.product-card', 'div', 'img · Profile', 'button · Submit'], 'names');
    },
  },
  {
    id: 'root-title-name',
    title: '문서 <title> 이 있으면 결과 프레임 이름이 된다',
    width: 375,
    html: '<!DOCTYPE html><html><head><title>예약 화면</title></head><body><div>a</div><div>b</div></body></html>',
    check: ({ root }, t) => t.eq(root.name, '예약 화면', 'root name'),
  },

  // ── 이미지 ───────────────────────────────────────────────
  {
    id: 'image-img',
    title: '<img> 는 실제 이미지 fill 로 들어간다',
    width: 375,
    html: `<div><img src="${PNG_1PX}" style="width:40px;height:30px;display:block"></div>`,
    check: ({ root }, t) => {
      const img = find(root, (n) => n.type === 'RECTANGLE');
      t.eq(imageFill(img)?.scaleMode, 'FILL', 'image fill');
    },
  },
  {
    id: 'image-object-fit-contain',
    title: 'object-fit:contain 이미지는 FIT 으로 들어간다',
    width: 375,
    html: `<div><img src="${PNG_1PX}" style="width:40px;height:30px;display:block;object-fit:contain"></div>`,
    check: ({ root }, t) => t.eq(imageFill(find(root, (n) => n.type === 'RECTANGLE'))?.scaleMode, 'FIT', 'scaleMode'),
  },
  {
    id: 'image-svg-converted',
    title: 'SVG 이미지(<img src=*.svg>)는 PNG 로 바꿔 이미지로 들어간다',
    width: 375,
    html: `<div><img src="${SVG_IMG}" style="width:20px;height:20px;display:block"></div>`,
    check: ({ root }, t) => t.ok(imageFill(find(root, (n) => n.type === 'RECTANGLE')), 'image fill'),
  },
  {
    id: 'image-bg-cover',
    title: 'background-image url() + cover 는 배경색 위의 이미지 fill(FILL)로 들어간다',
    width: 375,
    html: `<div><div style="width:100px;height:50px;background:#eee url(${PNG_1PX}) center/cover no-repeat"></div></div>`,
    check: ({ root }, t) => {
      const f = frameBy(root, (n) => n.width === 100);
      t.eq((f?.fills || []).map((p) => p.type), ['SOLID', 'IMAGE'], 'fills');
      t.eq(imageFill(f)?.scaleMode, 'FILL', 'scaleMode');
    },
  },
  {
    id: 'image-bg-tile',
    title: '반복되는 배경 이미지는 타일로 들어간다',
    width: 375,
    html: `<div><div style="width:100px;height:50px;background:url(${PNG_1PX}) repeat"></div></div>`,
    check: ({ root }, t) => t.eq(imageFill(frameBy(root, (n) => n.width === 100))?.scaleMode, 'TILE', 'scaleMode'),
  },
  {
    id: 'image-canvas',
    title: '스크립트로 그린 <canvas> 는 그려진 내용이 이미지로 들어간다',
    width: 375,
    html: '<div><canvas id="c" width="20" height="20" style="display:block"></canvas></div><script>document.getElementById("c").getContext("2d").fillRect(0,0,20,20)</script>',
    check: ({ root }, t) => t.ok(imageFill(find(root, (n) => n.type === 'RECTANGLE')), 'image fill'),
  },
  {
    id: 'image-unreachable',
    title: '불러올 수 없는 이미지는 크기가 같은 회색 자리표시로 들어간다',
    width: 375,
    html: '<div><img src="https://invalid.invalid/a.png" width="40" height="30" style="display:block"></div>',
    check: ({ root }, t) => {
      const img = find(root, (n) => n.type === 'RECTANGLE');
      t.eq(img?.fills?.[0]?.type, 'SOLID', 'placeholder');
      t.near(img?.width, 40, 0.5, 'width');
    },
  },

  // ── 렌더링 환경 ───────────────────────────────────────────
  {
    id: 'script-dom',
    title: 'DOM 을 수정하는 스크립트가 있어도 플러그인이 멈추지 않고 결과가 반영된다',
    width: 375,
    html: '<div><p id="js">static</p></div><script>document.getElementById("js").textContent = "from script";</script>',
    check: ({ root }, t) => t.ok(findText(root, 'from script'), `texts: ${JSON.stringify(texts(root).map((n) => n.characters))}`),
  },
  {
    id: 'script-alert',
    title: '붙여넣은 스크립트의 alert() 가 가져오기를 막지 않는다',
    width: 375,
    html: '<div><p>after alert</p></div><script>alert("blocked")</script>',
    check: ({ root }, t) => t.ok(findText(root, 'after alert'), 'text exists'),
  },
  {
    id: 'media-query',
    title: '미디어쿼리·vw·vh 는 선택한 렌더 폭(1440×900) 기준으로 계산된다',
    width: 1440,
    html: '<style>.box{background:blue;height:20px}@media (min-width:768px){.box{background:red}}</style><div><div class="box"></div><div style="width:100vw;height:10px;background:#0f0"></div><div style="height:100vh;width:10px;background:#00f"></div></div>',
    check: ({ root }, t) => {
      t.ok(solidFrame(root, [255, 0, 0]), 'media query applied (red box)');
      t.near(solidFrame(root, [0, 255, 0])?.width, 1440, 0.5, '100vw');
      t.near(frameBy(root, (n) => n.width === 10)?.height, 900, 0.5, '100vh');
    },
  },
  {
    id: 'tailwind-md',
    title: 'Tailwind md: 클래스가 1440 렌더 폭에서 적용된다',
    width: 1440,
    html: `${TW}<div class="p-4"><div class="h-6 w-40 bg-gray-300 md:bg-green-500"></div></div>`,
    check: ({ root }, t) => t.ok(solidFrame(root, [34, 197, 94]), 'green-500 frame'),
  },
  {
    id: 'tailwind-apply-head',
    title: '<head> 의 <style type="text/tailwindcss"> @apply 가 적용된다',
    width: 375,
    html: `<!DOCTYPE html><html><head>${TW}<style type="text/tailwindcss">.btn2 { @apply bg-red-500 text-white px-4 py-2; }</style></head><body><div class="p-4"><button class="btn2">Apply</button></div></body></html>`,
    check: ({ root }, t) => t.ok(solidFrame(root, [239, 68, 68]), 'red-500 button frame'),
  },
  {
    id: 'tailwind-config-isolation',
    title: '이전 가져오기의 tailwind.config 가 다음 가져오기에 남지 않는다',
    sequence: [
      { width: 375, html: `${TW}<script>tailwind.config={theme:{extend:{colors:{brand:'#ff0000'}}}}</script><div class="p-2"><div class="h-6 w-40 bg-brand"></div></div>` },
      { width: 375, html: `${TW}<div class="p-2"><div class="h-6 w-40 bg-brand"></div></div>` },
    ],
    check: ({ root }, t) => {
      const f = frameBy(root, (n) => n.width === 160);
      t.ok(f, 'frame exists');
      t.eq(solid(f), null, 'no brand color');
    },
  },
  {
    id: 'body-class-bg',
    title: '<body class="bg-..."> 배경이 결과에 반영된다',
    width: 375,
    html: `<!DOCTYPE html><html><head>${TW}</head><body class="bg-gray-100"><div class="p-6"><div class="bg-white h-10 w-40"></div></div></body></html>`,
    check: ({ root }, t) => t.eq(solid(root), [243, 244, 246], 'root fill'),
  },
  {
    id: 'body-bg-style',
    title: '<style> 의 body 배경이 결과에 반영된다 (기존 동작 유지)',
    width: 375,
    html: '<style>body{background:#f0f0f0}</style><div style="padding:10px"><p>content</p></div>',
    check: ({ root }, t) => t.eq(solid(root), [240, 240, 240], 'root fill'),
  },
  {
    id: 'dark-theme-bg',
    title: 'Figma 다크 모드여도 배경 없는 HTML 은 흰 배경으로 들어간다',
    width: 375,
    theme: { '--figma-color-bg': '#2c2c2c' },
    html: '<div><p>transparent fragment</p></div>',
    check: ({ root }, t) => t.eq(solid(root), [255, 255, 255], 'root fill'),
  },
  {
    id: 'fixed-bottom-bar',
    title: 'position:fixed 하단 바는 결과 맨 아래에 붙는다 (기존 동작 유지)',
    width: 375,
    html: '<div style="height:300px">content</div><nav style="position:fixed;bottom:0;left:0;right:0;height:50px;background:#333"></nav>',
    check: ({ root }, t) => {
      const nav = solidFrame(root, [51, 51, 51]);
      t.near(nav?.width, 375, 0.5, 'width');
      t.near(nav && nav.ay + nav.height, root.height, 1, 'bottom edge');
    },
  },

  // ── 그라디언트 ────────────────────────────────────────────
  {
    id: 'gradient-vertical',
    title: '방향 없는 linear-gradient 는 위→아래로 들어간다',
    width: 375,
    html: '<div><div style="width:100px;height:100px;background:linear-gradient(red, blue)"></div></div>',
    check: ({ root }, t) => {
      const g = frameBy(root, (n) => n.width === 100)?.fills?.find((f) => f.type === 'GRADIENT_LINEAR');
      if (!t.ok(g, 'gradient fill')) return;
      const h = gradientHandles(g);
      t.near(h.start[0], 0.5, 0.01, 'start.x'); t.near(h.start[1], 0, 0.01, 'start.y');
      t.near(h.end[0], 0.5, 0.01, 'end.x'); t.near(h.end[1], 1, 0.01, 'end.y');
    },
  },
  {
    id: 'gradient-diagonal-aspect',
    title: '비정사각형의 135deg 그라디언트는 CSS 와 같은 시작·끝 위치로 들어간다',
    width: 375,
    html: '<div><div style="width:200px;height:100px;background:linear-gradient(135deg, red, blue)"></div></div>',
    check: ({ root }, t) => {
      const g = frameBy(root, (n) => n.width === 200)?.fills?.find((f) => f.type === 'GRADIENT_LINEAR');
      if (!t.ok(g, 'gradient fill')) return;
      const h = gradientHandles(g);
      t.near(h.start[0], 0.125, 0.01, 'start.x'); t.near(h.start[1], -0.25, 0.01, 'start.y');
      t.near(h.end[0], 0.875, 0.01, 'end.x'); t.near(h.end[1], 1.25, 0.01, 'end.y');
    },
  },
  {
    id: 'gradient-horizontal',
    title: 'to right 그라디언트는 왼쪽→오른쪽으로 들어간다 (기존 동작 유지)',
    width: 375,
    html: '<div><div style="width:100px;height:40px;background:linear-gradient(to right, red, blue)"></div></div>',
    check: ({ root }, t) => {
      const g = frameBy(root, (n) => n.width === 100)?.fills?.find((f) => f.type === 'GRADIENT_LINEAR');
      if (!t.ok(g, 'gradient fill')) return;
      const h = gradientHandles(g);
      t.near(h.start[0], 0, 0.01, 'start.x'); t.near(h.end[0], 1, 0.01, 'end.x');
      t.near(h.start[1], h.end[1], 0.01, 'horizontal');
    },
  },
  {
    id: 'gradient-layers',
    title: '배경색 위에 겹친 그라디언트 여러 겹이 순서대로 들어간다',
    width: 375,
    html: '<div><div style="width:100px;height:40px;background:linear-gradient(rgba(0,0,0,.5),transparent),linear-gradient(to right,#00f,#0f0),#f00"></div></div>',
    check: ({ root }, t) => {
      const f = frameBy(root, (n) => n.width === 100);
      t.eq((f?.fills || []).map((p) => p.type), ['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_LINEAR'], 'fill order (bottom → top)');
      const top = f?.fills?.[2];
      t.near(top && gradientHandles(top).end[1], 1, 0.01, 'top layer is vertical');
    },
  },
  {
    id: 'gradient-px-stops',
    title: 'px 위치 컬러 스톱은 그라디언트 길이 비율로 들어간다',
    width: 375,
    html: '<div><div style="width:100px;height:40px;background:linear-gradient(to right, red 20px, blue 80px)"></div></div>',
    check: ({ root }, t) => {
      const g = frameBy(root, (n) => n.width === 100)?.fills?.find((f) => f.type === 'GRADIENT_LINEAR');
      t.eq(g?.gradientStops?.map((st) => Math.round(st.position * 100) / 100), [0.2, 0.8], 'positions');
    },
  },
  {
    id: 'bg-clip-text',
    title: 'background-clip:text 그라디언트는 프레임 배경이 되지 않는다 (기존 동작 유지)',
    width: 375,
    html: '<div><h1 style="background:linear-gradient(90deg,red,blue);-webkit-background-clip:text;background-clip:text;color:transparent;display:inline-block">Gradient</h1></div>',
    check: ({ root }, t) => t.ok(!find(root, (n) => n.type === 'FRAME' && (n.fills || []).some((f) => f.type.startsWith('GRADIENT'))), 'no gradient frame'),
  },

  // ── 효과 ─────────────────────────────────────────────────
  {
    id: 'effect-blur',
    title: 'filter:blur(4px) 는 반경 8 의 레이어 blur 로 들어간다 (Figma 반경 = CSS × 2)',
    width: 375,
    html: '<div style="padding:10px"><div style="width:50px;height:50px;background:red;filter:blur(4px)"></div></div>',
    check: ({ root }, t) => {
      const e = solidFrame(root, [255, 0, 0])?.effects?.[0];
      t.eq(e?.type, 'LAYER_BLUR', 'type');
      t.eq(e?.radius, 8, 'radius');
    },
  },
  {
    id: 'effect-backdrop-blur',
    title: 'backdrop-filter:blur(10px) 는 반경 20 의 배경 blur 로 들어간다',
    width: 375,
    html: '<div style="padding:10px"><div style="width:80px;height:40px;background:rgba(255,255,255,.5);backdrop-filter:blur(10px)"></div></div>',
    check: ({ root }, t) => {
      const e = frameBy(root, (n) => n.width === 80)?.effects?.find((x) => x.type === 'BACKGROUND_BLUR');
      t.eq(e?.radius, 20, 'radius');
    },
  },
  {
    id: 'effect-drop-shadow-filter',
    title: 'filter:drop-shadow() 는 드롭 섀도로 들어간다',
    width: 375,
    html: '<div style="padding:10px"><div style="width:50px;height:50px;background:red;filter:drop-shadow(0 2px 4px rgba(0,0,0,.3))"></div></div>',
    check: ({ root }, t) => {
      const e = solidFrame(root, [255, 0, 0])?.effects?.[0];
      t.eq(e?.type, 'DROP_SHADOW', 'type');
      t.eq(e?.offset?.y, 2, 'offset');
    },
  },
  {
    id: 'effect-blend-mode',
    title: 'mix-blend-mode 는 레이어 블렌드 모드로 들어간다',
    width: 375,
    html: '<div style="padding:10px"><div style="width:50px;height:50px;background:red;mix-blend-mode:multiply"></div></div>',
    check: ({ root }, t) => t.eq(solidFrame(root, [255, 0, 0])?.blendMode, 'MULTIPLY', 'blendMode'),
  },
  {
    id: 'text-gradient-clip',
    title: 'background-clip:text 그라디언트 글자는 텍스트 fill 이 그라디언트로 들어간다',
    width: 375,
    html: '<div><h1 style="margin:0;background:linear-gradient(90deg,red,blue);-webkit-background-clip:text;background-clip:text;color:transparent;display:inline-block">Gradient</h1></div>',
    check: ({ root }, t) => t.eq(findText(root, 'Gradient')?.fills?.[0]?.type, 'GRADIENT_LINEAR', 'text fill'),
  },
  {
    id: 'text-shadow',
    title: 'text-shadow 는 텍스트 드롭 섀도로 들어간다',
    width: 375,
    html: '<div><p style="text-shadow:0 1px 2px rgba(0,0,0,.5)">shadowed</p></div>',
    check: ({ root }, t) => {
      const e = findText(root, 'shadowed')?.effects?.[0];
      t.eq(e?.type, 'DROP_SHADOW', 'type');
      t.eq(e?.radius, 2, 'radius');
    },
  },
  {
    id: 'text-transparent',
    title: 'color:transparent 글자는 보이지 않는다 (검정으로 칠해지지 않는다)',
    width: 375,
    html: '<div><p style="color:transparent">invisible</p><p>visible</p></div>',
    check: ({ root }, t) => t.eq(findText(root, 'invisible')?.fills, [], 'no fill'),
  },
  {
    id: 'gradient-radial',
    title: 'radial-gradient 는 CSS 와 같은 중심·반지름의 원형 그라디언트로 들어간다',
    width: 375,
    html: '<div><div style="width:200px;height:100px;background:radial-gradient(circle at 25% 50%, red, blue)"></div></div>',
    check: ({ root }, t) => {
      const g = frameBy(root, (n) => n.width === 200)?.fills?.find((f) => f.type === 'GRADIENT_RADIAL');
      if (!t.ok(g, 'radial fill')) return;
      const h = gradientHandles(g);
      const r = Math.hypot(150, 50); // (50,50) 에서 가장 먼 모서리 (200,100) 까지
      t.near(h.center[0], 0.25, 0.01, 'center.x'); t.near(h.center[1], 0.5, 0.01, 'center.y');
      t.near(h.end[0], (50 + r) / 200, 0.01, 'x edge'); t.near(h.yEdge[1], (50 + r) / 100, 0.01, 'y edge');
    },
  },
  {
    id: 'gradient-conic',
    title: 'conic-gradient 는 시작 각도 방향을 기준으로 한 각도 그라디언트로 들어간다',
    width: 375,
    html: '<div><div style="width:100px;height:100px;background:conic-gradient(from 90deg, red, blue)"></div></div>',
    check: ({ root }, t) => {
      const g = frameBy(root, (n) => n.width === 100)?.fills?.find((f) => f.type === 'GRADIENT_ANGULAR');
      if (!t.ok(g, 'angular fill')) return;
      const h = gradientHandles(g);
      t.near(h.center[0], 0.5, 0.01, 'center.x');
      t.near(h.end[0], 1, 0.01, 'starts toward the right (from 90deg)'); t.near(h.end[1], 0.5, 0.01, 'start y');
    },
  },

  // ── 박스·레이아웃 ─────────────────────────────────────────
  {
    id: 'overflow-scroll',
    title: '가로 스크롤 영역은 원래 폭을 유지하고 넘치는 내용은 잘린다',
    width: 375,
    html: '<div style="padding:8px"><div style="width:200px;overflow-x:auto;display:flex;gap:8px;background:#eee"><div style="flex:none;width:150px;height:40px;background:#ccc"></div><div style="flex:none;width:150px;height:40px;background:#ccc"></div><div style="flex:none;width:150px;height:40px;background:#ccc"></div></div></div>',
    check: ({ root }, t) => {
      const f = solidFrame(root, [238, 238, 238]);
      t.near(f?.width, 200, 0.5, 'width');
      t.eq(f?.clipsContent, true, 'clipsContent');
    },
  },
  {
    id: 'abs-overflow-bg',
    title: '밖으로 튀어나온 절대위치 자식 때문에 부모 배경이 커지지 않는다',
    width: 375,
    html: '<style>.dot{position:relative;width:40px;height:40px;background:#ccc}.dot::after{content:"";position:absolute;right:-4px;top:-4px;width:8px;height:8px;background:red;border-radius:50%}</style><div style="padding:10px"><div class="dot"></div></div>',
    check: ({ root }, t) => {
      t.near(solidFrame(root, [204, 204, 204])?.width, 40, 0.5, 'width');
      const dot = solidFrame(root, [255, 0, 0]);
      t.near(dot?.x, 36, 0.5, 'badge x');
    },
  },
  {
    id: 'root-expand',
    title: '페이지 아래로 넘친 절대위치 요소까지 결과 프레임이 감싼다',
    width: 375,
    html: '<div style="height:100px">a</div><div style="position:absolute;top:150px;left:0;width:50px;height:50px;background:red"></div>',
    check: ({ root }, t) => {
      const red = solidFrame(root, [255, 0, 0]);
      t.ok(red, 'red box');
      t.ok(red && root.height >= red.ay + red.height - 0.5, `root height ${root.height}`);
    },
  },
  {
    id: 'z-index-order',
    title: '형제 레이어가 CSS 그리기 순서(음수 z → 일반 흐름 → positioned → 양수 z)로 쌓인다',
    width: 375,
    html: '<div style="position:relative;width:100px;height:100px"><div style="position:absolute;inset:0;background:red"></div><div style="background:blue;height:50px"></div><div style="position:absolute;top:0;left:0;width:10px;height:10px;background:lime;z-index:-1"></div><div style="position:relative;z-index:5;background:yellow;height:20px"></div></div>',
    check: ({ root }, t) => {
      const order = root.children.map((c) => JSON.stringify(solid(c)));
      t.eq(order, ['[0,255,0]', '[0,0,255]', '[255,0,0]', '[255,255,0]'].map(String), 'bottom → top');
    },
  },
  {
    id: 'zero-size-wrapper',
    title: '크기가 0 인 래퍼 안의 요소도 들어간다',
    width: 375,
    html: '<div style="position:relative;width:100px;height:100px;background:#eee"><div style="position:absolute;top:0;right:0"><div style="position:absolute;right:0;width:20px;height:20px;background:red"></div></div></div>',
    check: ({ root }, t) => {
      const red = solidFrame(root, [255, 0, 0]);
      t.near(red?.width, 20, 0.5, 'width');
      t.near(red?.ax, 80, 0.5, 'x');
    },
  },
  {
    id: 'display-contents',
    title: 'display:contents 요소의 자식이 들어간다',
    width: 375,
    html: '<div style="width:200px"><div style="display:contents"><p style="margin:0">inside contents</p></div><p style="margin:0">sibling</p></div>',
    check: ({ root }, t) => t.ok(findText(root, 'inside contents'), 'text exists'),
  },
  {
    id: 'hairline',
    title: '0.5px 구분선이 들어간다',
    width: 375,
    html: '<div style="width:200px"><div style="height:0.5px;background:#000"></div><p style="margin:0">x</p></div>',
    check: ({ root }, t) => t.near(solidFrame(root, [0, 0, 0])?.height, 0.5, 0.01, 'height'),
  },
  {
    id: 'radius-percent',
    title: '퍼센트 모서리 반경은 요소 크기 기준으로 계산된다',
    width: 375,
    html: '<div><div style="width:200px;height:200px;border-radius:10%;background:#ccc"></div></div>',
    check: ({ root }, t) => t.near(solidFrame(root, [204, 204, 204])?.cornerRadius, 20, 0.5, 'radius'),
  },
  {
    id: 'dashed',
    title: 'dashed 테두리는 점선으로 들어간다',
    width: 375,
    html: '<div><div style="width:100px;height:40px;border:2px dashed #999"></div></div>',
    check: ({ root }, t) => {
      const f = frameBy(root, (n) => (n.strokes || []).length > 0);
      t.eq(f?.dashPattern, [6, 6], 'dashPattern');
    },
  },
  {
    id: 'rotate',
    title: '회전된 요소는 원래 크기에 회전값을 가진 채로 들어간다',
    width: 375,
    html: '<div style="padding:40px"><div style="width:100px;height:20px;background:red;transform:rotate(45deg)"></div></div>',
    check: ({ root }, t) => {
      const f = solidFrame(root, [255, 0, 0]);
      t.near(f?.width, 100, 0.5, 'width');
      t.near(f?.height, 20, 0.5, 'height');
      const m = f?.relativeTransform;
      t.near(m?.[0]?.[0], Math.SQRT1_2, 0.001, 'cos');
      t.near(m?.[1]?.[0], Math.SQRT1_2, 0.001, 'sin');
      // 중심(50,10) 기준 45° 회전 → 왼쪽 위 모서리 = (40,40) + O − M·O
      t.near(m?.[0]?.[2], 40 + 50 - Math.SQRT1_2 * 40, 0.05, 'corner x');
      t.near(m?.[1]?.[2], 40 + 10 - Math.SQRT1_2 * 60, 0.05, 'corner y');
    },
  },
  {
    id: 'rotate-icon-180',
    title: '180° 회전한 아이콘(chevron 등)은 뒤집힌 방향으로 같은 자리에 들어간다',
    width: 375,
    html: '<div style="padding:10px"><svg style="transform:rotate(180deg);display:block" width="12" height="12" viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" fill="none" stroke="black"/></svg></div>',
    check: ({ root }, t) => {
      const icon = find(root, (n) => !!n.svg);
      const m = icon?.relativeTransform;
      t.near(m?.[0]?.[0], -1, 0.001, 'cos');
      // 중심 기준 180° → 왼쪽 위 모서리는 원래 오른쪽 아래(22,22)
      t.near(m?.[0]?.[2], 22, 0.05, 'corner x');
      t.near(m?.[1]?.[2], 22, 0.05, 'corner y');
    },
  },

  // ── 인라인 콘텐츠 ─────────────────────────────────────────
  {
    id: 'inline-block-span',
    title: 'display:block span 은 앞 글자와 다른 줄로 들어간다',
    width: 375,
    html: '<div style="width:300px"><div>Title <span style="display:block;color:gray">Subtitle below</span></div></div>',
    check: ({ root }, t) => {
      const a = findText(root, 'Title');
      const b = findText(root, 'Subtitle below');
      t.ok(a && b, `texts: ${JSON.stringify(texts(root).map((n) => n.characters))}`);
      if (a && b) t.ok(b.ay > a.ay, 'subtitle below');
    },
  },
  {
    id: 'inline-badge',
    title: '배경·패딩이 있는 인라인 배지는 박스와 함께 들어간다',
    width: 375,
    html: '<div style="width:300px"><p>Status: <span style="background:#dfd;padding:2px 6px;border-radius:4px">Active</span></p></div>',
    check: ({ root }, t) => {
      const badge = solidFrame(root, [221, 255, 221]);
      t.ok(badge, 'badge frame');
      t.ok(findText(root, 'Active'), 'badge text');
      t.ok(findTextIncl(root, 'Status:'), 'label text');
    },
  },
  {
    id: 'inline-icon',
    title: '문장 안의 인라인 SVG 아이콘이 들어간다',
    width: 375,
    html: '<div style="width:300px"><p>Go <a href="#"><svg width="12" height="12"><rect width="12" height="12" fill="red"/></svg> next</a></p></div>',
    check: ({ root }, t) => {
      t.ok(find(root, (n) => (n.svg || '').includes('<rect')), 'svg node');
      t.ok(findTextIncl(root, 'next'), 'text next');
    },
  },
  {
    id: 'inline-styles',
    title: '인라인 요소의 글자 크기·이탤릭·밑줄이 해당 구간에 적용된다',
    width: 375,
    html: '<div style="width:300px"><p>Price <span style="font-size:28px">$20</span> <em>only</em> <u>today</u></p></div>',
    check: ({ root }, t) => {
      const n = findText(root, 'Price $20 only today');
      if (!t.ok(n, `texts: ${JSON.stringify(texts(root).map((x) => x.characters))}`)) return;
      const has = (kind, start, end, pred) => n.ranges.some((r) => r.kind === kind && r.start === start && r.end === end && pred(r.value));
      t.ok(has('fontSize', 6, 9, (v) => v === 28), 'fontSize range on $20');
      t.ok(has('fontName', 10, 14, (v) => v.endsWith('Italic')), 'italic range on only');
      t.ok(has('textDecoration', 15, 20, (v) => v === 'UNDERLINE'), 'underline range on today');
    },
  },
  {
    id: 'inline-color-segment',
    title: '인라인 요소의 다른 글자색이 해당 구간에 적용된다 (기존 동작 유지)',
    width: 375,
    html: '<div style="width:300px"><p>Hello <span style="color:red">red</span> world</p></div>',
    check: ({ root }, t) => {
      const n = findText(root, 'Hello red world');
      if (!t.ok(n, 'merged text')) return;
      const r = n.ranges.find((x) => x.kind === 'fills' && x.start === 6 && x.end === 9);
      t.ok(r && Math.round(r.value[0].color.r * 255) === 255, 'red range');
    },
  },
  {
    id: 'list-marker',
    title: '목록 기호(•)가 항목 왼쪽에 들어간다',
    width: 375,
    html: '<ul style="list-style:disc;padding-left:20px;width:200px;margin:0"><li>One</li><li>Two</li></ul>',
    check: ({ root }, t) => {
      const bullets = texts(root).filter((n) => n.characters.trim() === '•');
      t.eq(bullets.length, 2, 'bullet count');
      const one = findText(root, 'One');
      if (bullets[0] && one) t.ok(bullets[0].ax < one.ax, 'bullet left of text');
    },
  },
  {
    id: 'pseudo-inline-text',
    title: '인라인 ::before 텍스트가 본문 왼쪽에 들어간다',
    width: 375,
    html: '<style>.bul::before{content:"•";margin-right:4px;color:red}</style><div style="width:300px"><p class="bul" style="margin:0">bullet text</p></div>',
    check: ({ root }, t) => {
      const b = texts(root).find((n) => n.characters === '•');
      const body = findText(root, 'bullet text');
      t.ok(b && hasSolid(b, [255, 0, 0]), 'red bullet');
      if (b && body) t.ok(b.ax < body.ax, 'bullet left of text');
    },
  },

  // ── 실제 화면 ─────────────────────────────────────────────
  {
    id: 'fixture-mobile-home',
    title: 'Tailwind 모바일 홈 화면이 배지·말줄임·가운데 문단·하단 바까지 브라우저와 같게 들어간다',
    width: 375,
    html: fixture('mobile-home.html'),
    check: ({ root }, t) => {
      t.eq(solid(root), [249, 250, 251], 'page background (bg-gray-50)');
      t.ok(solidFrame(root, [220, 252, 231]) && findText(root, '사용 가능'), 'green badge');
      t.eq(findText(root, '대회의실 A (12인 이상 대형)')?.textTruncation, 'ENDING', 'truncated title');
      const para = findTextIncl(root, '추천 공간');
      t.eq(para?.textAutoResize, 'HEIGHT', 'centered paragraph wraps');
      t.eq(para?.textAlignHorizontal, 'CENTER', 'centered paragraph align');
      t.ok(findText(root, '공간 이름을 입력하세요'), 'input placeholder');
      t.ok(find(root, (n) => n.type === 'FRAME' && (n.fills || []).some((f) => f.type === 'GRADIENT_LINEAR')), 'hero gradient');
      const nav = find(root, (n) => n.name === 'nav');
      t.near(nav && nav.ay + nav.height, root.height, 1, 'bottom nav at the bottom');
      t.eq(nav ? find(nav, (n) => n.type === 'TEXT' && n.characters === '예약') ? 1 : 0 : 0, 1, 'nav label');
    },
  },

  {
    id: 'list-ordered',
    title: '번호 목록은 start·value 를 반영한 번호가 들어간다',
    width: 375,
    html: '<ol start="3" style="padding-left:30px;margin:0;width:200px"><li>Three</li><li value="7">Seven</li><li>Eight</li></ol>',
    check: ({ root }, t) => {
      for (const n of ['3.', '7.', '8.']) t.ok(findText(root, n), `marker ${n}`);
      const m = findText(root, '3.');
      const three = findText(root, 'Three');
      if (m && three) t.ok(m.ax + m.width <= three.ax, 'marker left of text');
    },
  },
  {
    id: 'pseudo-after-required',
    title: '라벨 뒤 ::after 필수 표시(*)가 글자 바로 오른쪽에 들어간다',
    width: 375,
    html: '<style>.req::after{content:"*";color:red;margin-left:2px}</style><div style="width:300px"><label class="req" style="display:block">이름</label></div>',
    check: ({ root }, t) => {
      const star = findText(root, '*');
      const label = findText(root, '이름');
      t.ok(star && hasSolid(star, [255, 0, 0]), 'red star');
      if (star && label) t.near(star.ax, label.ax + label.width + 2, 3, 'star right after label');
    },
  },
  // ── 폼 ───────────────────────────────────────────────────
  {
    id: 'form-checkbox',
    title: '체크박스는 "on" 글자로 표시되지 않는다',
    width: 375,
    html: '<div style="width:300px"><label><input type="checkbox"> Remember</label></div>',
    check: ({ root }, t) => {
      t.ok(!findText(root, 'on'), 'no "on" text');
      t.ok(findTextIncl(root, 'Remember'), 'label text');
    },
  },
  {
    id: 'form-select',
    title: 'select 는 선택된 옵션의 라벨을 표시한다',
    width: 375,
    html: '<div style="width:300px"><select><option value="kr">대한민국</option></select></div>',
    check: ({ root }, t) => t.ok(findText(root, '대한민국'), `texts: ${JSON.stringify(texts(root).map((n) => n.characters))}`),
  },
  {
    id: 'form-password',
    title: '비밀번호 입력값은 가려서 표시된다',
    width: 375,
    html: '<div style="width:300px"><input type="password" value="secret12"></div>',
    check: ({ root }, t) => {
      t.ok(!findText(root, 'secret12'), 'no plain password');
      t.ok(findText(root, '••••••••'), 'masked');
    },
  },
  {
    id: 'form-native-controls',
    title: '기본 모양 체크박스·라디오·range·select 화살표가 벡터로 들어간다 (체크 상태 포함)',
    width: 375,
    html: '<div style="width:300px"><input type="checkbox" checked><input type="radio" checked><input type="range" value="30"><select><option>A</option></select></div>',
    check: ({ root }, t) => {
      const svgs = all(root, (n) => !!n.svg).map((n) => n.svg);
      t.ok(svgs.some((v) => v.includes('<path') && v.includes('<rect')), 'checked checkbox');
      t.ok(svgs.some((v) => (v.match(/<circle/g) || []).length === 2 && !v.includes('<rect')), 'checked radio');
      t.ok(svgs.some((v) => (v.match(/<rect/g) || []).length === 2 && v.includes('<circle')), 'range');
      t.ok(svgs.some((v) => v.includes('M1 1 L4 4 L7 1')), 'select chevron');
      t.ok(findText(root, 'A'), 'select label');
    },
  },
  {
    id: 'form-textarea',
    title: 'textarea 값의 줄바꿈이 유지된다',
    width: 375,
    html: '<div style="width:300px"><textarea rows="3">line1\nline2</textarea></div>',
    check: ({ root }, t) => t.ok(findText(root, 'line1\nline2'), `texts: ${JSON.stringify(texts(root).map((n) => n.characters))}`),
  },

  // ── SVG ──────────────────────────────────────────────────
  {
    id: 'svg-css-fill',
    title: 'CSS 로 색을 지정한 SVG 는 그 색으로 들어간다',
    width: 375,
    html: '<style>.ic path{fill:red}</style><div><svg class="ic" width="20" height="20" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg></div>',
    check: ({ root }, t) => t.ok(find(root, (n) => /fill="rgb\(255, 0, 0\)"/.test(n.svg || '')), 'fill inlined'),
  },
  {
    id: 'svg-no-viewbox',
    title: 'viewBox 없는 SVG 를 CSS 로 키워도 내용이 같이 커진다',
    width: 375,
    html: '<div><svg width="20" height="20" style="width:40px;height:40px"><rect width="20" height="20" fill="blue"/></svg></div>',
    check: ({ root }, t) => t.ok(find(root, (n) => (n.svg || '').includes('viewBox="0 0 20 20"')), 'viewBox added'),
  },
  {
    id: 'svg-sprite-defs',
    title: '아이콘 스프라이트(<use>+symbol)와 다른 SVG 에 정의된 그라디언트가 들어간다',
    width: 375,
    html: '<svg style="display:none"><defs><linearGradient id="g1"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><symbol id="ic" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></svg><div><svg width="20" height="20"><use href="#ic" width="20" height="20"/></svg><svg width="20" height="20"><rect width="20" height="20" fill="url(#g1)"/></svg></div>',
    check: ({ root }, t) => {
      const svgs = all(root, (n) => !!n.svg).map((n) => n.svg);
      t.ok(svgs.some((v) => /<g transform="scale\(2,2\)"><rect/.test(v)), `symbol inlined: ${svgs[0]}`);
      t.ok(svgs.some((v) => v.includes('<linearGradient id="g1"') && v.includes('url(#g1)')), 'external gradient copied');
    },
  },
  // ── 사용 편의 ─────────────────────────────────────────────
  {
    id: 'multi-width',
    title: '375 · 768 · 1440 을 한 번에 가져오면 폭별 프레임이 오른쪽으로 나란히 생긴다',
    width: 'multi',
    html: '<style>.box{height:20px;background:blue}@media (min-width:768px){.box{background:red}}</style><div class="box"></div><p>text</p>',
    check: ({ roots }, t) => {
      t.eq(roots.map((r) => r.name), ['HTML Import · 375', 'HTML Import · 768', 'HTML Import · 1440'], 'names');
      t.eq(roots.map((r) => r.width), [375, 768, 1440], 'widths');
      t.ok(roots[1]?.x > roots[0]?.x + 375 && roots[2]?.x > roots[1]?.x + 768, 'side by side');
      t.eq(roots.map((r) => r.y), [roots[0]?.y, roots[0]?.y, roots[0]?.y], 'top aligned');
      t.eq(roots.map((r) => (solidFrame(r, [255, 0, 0]) ? 'red' : 'blue')), ['blue', 'red', 'red'], 'breakpoint per width');
    },
  },
  {
    id: 'into-selection',
    title: '"선택한 프레임 안에 넣기" 를 켜면 선택한 프레임 안 왼쪽 위에 들어간다',
    width: 375,
    options: { intoSelection: true },
    selectFrame: { width: 500, height: 400 },
    html: '<div style="width:100px;height:40px;background:red"></div>',
    check: ({ roots, selected }, t) => {
      t.eq(roots.length, 0, 'not on the page');
      t.eq(selected.length, 1, 'inside the selected frame');
      t.eq([selected[0]?.x, selected[0]?.y], [0, 0], 'top-left');
    },
  },
  {
    id: 'into-selection-off',
    title: '옵션을 끄면 프레임을 선택해 둬도 페이지에 들어간다',
    width: 375,
    selectFrame: { width: 500, height: 400 },
    html: '<div style="width:100px;height:40px;background:red"></div>',
    check: ({ roots, selected }, t) => {
      t.eq(roots.length, 1, 'on the page');
      t.eq(selected.length, 0, 'selected frame untouched');
    },
  },
  {
    id: 'settings-restore',
    title: '다시 열면 마지막 입력 HTML·렌더 폭·옵션이 복원된다',
    width: 768,
    options: { autoLayout: true },
    html: '<div id="remember-me">x</div>',
    uiAction: { name: 'reloadUiState', args: [] },
    check: ({ ui }, t) => {
      t.ok(ui?.html.includes('remember-me'), 'html restored');
      t.eq(ui?.width, '768', 'width restored');
      t.eq(ui?.autoLayout, true, 'option restored');
    },
  },
  {
    id: 'file-drop',
    title: '.html 파일을 입력 영역에 끌어놓으면 내용이 채워진다',
    uiAction: { name: 'dropFile', args: ['page.html', '<p>dropped file</p>'] },
    check: ({ ui }, t) => t.eq(ui?.html, '<p>dropped file</p>', 'textarea'),
  },
  {
    id: 'progress-reported',
    title: '노드가 많으면 생성 중 진행률(처리 수 / 전체 수)을 알린다',
    width: 375,
    html: `<div>${'<div style="height:2px;background:#ccc"></div>'.repeat(120)}</div>`,
    check: ({ messages, done }, t) => {
      const progress = messages.filter((m) => m.type === 'import-progress');
      t.ok(progress.length >= 2, `progress messages ${progress.length}`);
      t.eq(progress[0]?.total, 121, 'total nodes (루트 div + 선 120개)');
      t.eq(done?.failedCount, 0, 'no failures');
    },
  },
  {
    id: 'failure-reported',
    title: '일부 요소를 만들지 못해도 나머지는 만들고, 실패 개수와 오류를 완료 화면에 보여준다',
    width: 375,
    failText: 'boom',
    html: '<div><p>ok text</p><p>boom</p><p>after</p></div>',
    check: ({ root, done, uiText }, t) => {
      t.eq(done?.failedCount, 1, 'failedCount');
      t.ok(findText(root, 'ok text') && findText(root, 'after'), 'other texts built');
      t.ok(uiText.includes('1개 요소를 만들지 못했습니다'), 'shown in UI');
    },
  },
  // ── 2차 점검 ─────────────────────────────────────────────
  {
    id: 'oklch-gradient-shadow',
    title: 'oklch 등 최신 색 표기의 그라디언트·그림자·테두리도 들어간다 (Tailwind v4 기본 색)',
    width: 375,
    html: '<div style="padding:20px"><div style="width:100px;height:40px;background:linear-gradient(to right, oklch(0.62 0.21 260), oklch(0.65 0.24 16));box-shadow:0 4px 8px oklch(0 0 0 / 0.3);border:2px solid oklch(0.7 0.15 150)"></div></div>',
    check: ({ root }, t) => {
      const f = frameBy(root, (n) => n.width === 104);
      t.eq(f?.fills?.[0]?.type, 'GRADIENT_LINEAR', 'gradient');
      t.eq(f?.effects?.[0]?.type, 'DROP_SHADOW', 'shadow');
      t.ok((f?.strokes || []).length === 1, 'border');
    },
  },
  {
    id: 'oklch-svg-fill',
    title: 'oklch 로 칠한 SVG 아이콘은 Figma 가 읽을 수 있는 rgb 로 들어간다',
    width: 375,
    html: '<div><svg width="20" height="20" viewBox="0 0 10 10" style="color:oklch(0.62 0.21 260)"><path d="M0 0h10v10H0z" fill="currentColor"/></svg></div>',
    check: ({ root }, t) => {
      const svg = find(root, (n) => !!n.svg)?.svg || '';
      t.ok(!/oklch|oklab|color\(/.test(svg), `no modern color syntax: ${svg.slice(0, 160)}`);
      t.ok(/fill="rgb/.test(svg), 'rgb fill');
    },
  },
  {
    id: 'tailwind-v4',
    title: 'Tailwind v4 브라우저 CDN 으로 만든 화면(oklch 색·그라디언트)이 들어간다',
    width: 375,
    html: '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script><div class="p-4"><div class="h-10 w-40 rounded-xl bg-gradient-to-r from-blue-500 to-pink-500 shadow-lg"></div><p class="mt-2 text-blue-600 font-semibold">v4 text</p></div>',
    check: ({ root }, t) => {
      const f = frameBy(root, (n) => n.width === 160);
      t.eq(f?.fills?.[0]?.type, 'GRADIENT_LINEAR', 'gradient');
      t.ok((f?.effects || []).length >= 1, 'shadow');
      const txt = findText(root, 'v4 text');
      t.ok(txt && solid(txt) && solid(txt)[2] > 150, `blue text ${JSON.stringify(txt && solid(txt))}`);
    },
  },
  {
    id: 'line-clamp-position',
    title: '여러 줄 말줄임(line-clamp)은 숨겨진 줄과 무관하게 content 위쪽에 놓인다',
    width: 375,
    html: '<div style="width:160px;padding:10px"><p style="margin:0;font-size:14px;line-height:20px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">This is a long description that will be clamped to exactly two lines even though it has many more words in it than fit</p></div>',
    check: ({ root }, t) => {
      const n = findTextIncl(root, 'long description');
      t.eq(n?.maxLines, 2, 'maxLines');
      t.near(n?.ay, 10, 2, 'top of content');
    },
  },
  {
    id: 'border-single-side-color',
    title: '한 면에만 준 테두리 색(border-bottom)은 다른 면의 currentColor 가 아니라 그 색으로 들어간다',
    width: 375,
    html: '<div style="color:#000"><div style="width:100px;height:30px;border-bottom:2px solid rgb(255, 0, 0)"></div></div>',
    check: ({ root }, t) => {
      const f = frameBy(root, (n) => (n.strokes || []).length > 0);
      t.eq(solid({ fills: f?.strokes }), [255, 0, 0], 'stroke color');
    },
  },
  {
    id: 'border-sides-different-colors',
    title: '면마다 색이 다른 테두리(왼쪽 강조선 등)는 각 면이 자기 색으로 들어간다',
    width: 375,
    html: '<div><div style="width:200px;height:40px;border:1px solid rgb(200, 200, 200);border-left:4px solid rgb(0, 0, 255)"></div></div>',
    check: ({ root }, t) => {
      const blue = find(root, (n) => hasSolid(n, [0, 0, 255]) || hasSolid({ fills: n.strokes }, [0, 0, 255]));
      const gray = find(root, (n) => hasSolid(n, [200, 200, 200]) || hasSolid({ fills: n.strokes }, [200, 200, 200]));
      t.ok(blue, 'blue left border');
      t.ok(gray, 'gray other borders');
    },
  },
  {
    id: 'autolayout-side-borders',
    title: 'Auto Layout 으로 바뀐 컨테이너의 면별 테두리 사각형은 배치에 끼지 않고 제자리에 남는다',
    width: 375,
    options: { autoLayout: true },
    html: '<div style="padding:10px"><div style="display:flex;gap:8px;padding:8px;width:120px;border-left:4px solid rgb(0, 0, 255);border-bottom:1px solid rgb(200, 200, 200)"><div style="width:30px;height:30px;background:red"></div><div style="width:30px;height:30px;background:red"></div></div></div>',
    check: ({ root }, t) => {
      const f = find(root, (n) => n.layoutMode === 'HORIZONTAL');
      t.ok(f, 'auto layout applied');
      const left = find(root, (n) => n.name === 'border-left');
      t.eq(left?.layoutPositioning, 'ABSOLUTE', 'border rect absolute');
      t.eq([left?.x, left?.y], [0, 0], 'border rect position');
    },
  },
  {
    id: 'root-canvas',
    title: 'canvas 하나만 붙여넣어도 그려진 내용이 이미지로 들어간다',
    width: 375,
    html: '<canvas id="c" width="30" height="20" style="display:block"></canvas><script>document.getElementById("c").getContext("2d").fillRect(0,0,30,20)</script>',
    check: ({ root }, t) => t.ok(imageFill(find(root, (n) => n.type === 'RECTANGLE')), 'image fill'),
  },
  {
    id: 'pseudo-attr-content',
    title: 'content: attr(data-count) 가상요소 글자(알림 숫자 배지)가 들어간다',
    width: 375,
    html: '<style>.badge{position:relative;width:30px;height:30px;background:#ddd}.badge::after{content:attr(data-count);position:absolute;top:-6px;right:-6px;min-width:16px;height:16px;padding:0 4px;background:red;color:#fff;font-size:10px;line-height:16px;border-radius:8px;text-align:center}</style><div style="padding:10px"><div class="badge" data-count="12"></div></div>',
    check: ({ root }, t) => t.ok(findText(root, '12'), `texts: ${JSON.stringify(texts(root).map((n) => n.characters))}`),
  },
  {
    id: 'repeating-gradient',
    title: 'repeating-linear-gradient 줄무늬는 반복된 색 정지점으로 들어간다',
    width: 375,
    html: '<div><div style="width:100px;height:20px;background:repeating-linear-gradient(90deg, red 0px, red 10px, blue 10px, blue 20px)"></div></div>',
    check: ({ root }, t) => {
      const g = frameBy(root, (n) => n.width === 100)?.fills?.find((f) => f.type === 'GRADIENT_LINEAR');
      t.ok(g && g.gradientStops.length >= 20, `stops ${g?.gradientStops?.length}`);
      // 90~100px 는 파란 줄 → 마지막 스톱(100%)은 파랑
      const last = g?.gradientStops?.[g.gradientStops.length - 1];
      t.eq(last && [last.position, Math.round(last.color.b * 255)], [1, 255], 'last stop blue at 100%');
    },
  },
  {
    id: 'repeating-radial-gradient',
    title: 'repeating-radial-gradient 동심원도 반복된 색 정지점으로 들어간다',
    width: 375,
    html: '<div><div style="width:100px;height:100px;background:repeating-radial-gradient(circle at center, red 0px, red 5px, blue 5px, blue 10px)"></div></div>',
    check: ({ root }, t) => {
      const g = frameBy(root, (n) => n.width === 100)?.fills?.find((f) => f.type === 'GRADIENT_RADIAL');
      t.ok(g && g.gradientStops.length >= 12, `stops ${g?.gradientStops?.length}`);
    },
  },
  {
    id: 'svg-style-attr-var',
    title: 'SVG style 속성의 CSS 변수(var())는 계산된 색으로 바뀐다',
    width: 375,
    html: '<style>:root{--brand:rgb(255, 0, 0)}</style><div><svg width="20" height="20" viewBox="0 0 10 10"><path d="M0 0h10v10H0z" style="fill:var(--brand)"/></svg></div>',
    check: ({ root }, t) => {
      const svg = find(root, (n) => !!n.svg)?.svg || '';
      t.ok(!svg.includes('var('), `no var(): ${svg}`);
      t.ok(svg.includes('rgb(255, 0, 0)'), 'resolved color');
    },
  },
  {
    id: 'table-collapse-borders',
    title: 'border-collapse 표의 칸 테두리가 두 겹으로 두꺼워지지 않는다',
    width: 375,
    html: '<table style="border-collapse:collapse"><tr><td style="border:1px solid rgb(0, 0, 0);width:50px;height:20px">a</td><td style="border:1px solid rgb(0, 0, 0);width:50px;height:20px">b</td></tr></table>',
    check: ({ root }, t) => {
      const cells = all(root, (n) => n.type === 'FRAME' && (n.strokes || []).length > 0);
      t.eq(cells.length, 2, 'two cells');
      // 칸 경계가 맞닿아 있고(Chrome 은 공유선의 절반씩을 칸에 포함) 선이 가운데 정렬이면 겹쳐 한 줄로 보인다
      const [a, b] = cells.sort((x, y) => x.ax - y.ax);
      t.near(a && b && b.ax - (a.ax + a.width), 0, 0.01, 'cells touch');
      t.eq(cells.map((c) => c.strokeAlign), ['CENTER', 'CENTER'], 'center aligned');
    },
  },
];
