/**
 * domSerializer.ts — 브라우저(플러그인 UI) 컨텍스트에서 실행
 *
 * 렌더링된 DOM을 순회하며 getBoundingClientRect + getComputedStyle로
 * 실제 레이아웃과 스타일을 추출해 DomNodeData 트리를 만든다.
 * code.ts(Figma 샌드박스)로는 DOM API가 없으므로 이쪽에서만 실행된다.
 *
 * 대상 DOM 은 렌더 iframe(render.ts) 안에 있으므로 getComputedStyle·Range 등은
 * 항상 요소가 속한 문서의 window 로 호출한다 (미디어쿼리·vw 가 렌더 폭 기준으로 계산되도록).
 */
import type { DomNodeData, DomStyleData, TextSegment } from './types';

const SKIP_TAGS = new Set([
  'script', 'style', 'meta', 'link', 'head', 'noscript', 'title', 'base',
  'template', 'audio',
  // hr은 제거 — 구분선으로 직접 렌더링
  // br 은 텍스트 흐름 안에서 줄바꿈으로 처리
]);

// 글자 흐름 안에 있어도 텍스트로 합칠 수 없는 요소 (자체 박스·그림을 가진다)
const REPLACED_TAGS = new Set([
  'svg', 'img', 'canvas', 'video', 'audio', 'iframe', 'input', 'select', 'textarea', 'button',
  'object', 'embed', 'picture', 'math', 'hr', 'progress', 'meter',
]);

const FORM_TAGS = new Set(['input', 'textarea', 'select']);

// 이미지로 가져오는 요소: <img>, 그려진 내용을 쓰는 <canvas>, 포스터를 쓰는 <video>,
// 내용을 읽을 수 없는 임베드(<iframe>·<embed>·<object>)는 같은 크기의 자리표시
const MEDIA_TAGS = new Set(['img', 'canvas', 'video', 'iframe', 'embed', 'object']);

function mediaImageUrl(el: Element, tag: string): string | undefined {
  if (tag === 'img') return (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || undefined;
  if (tag === 'video') return (el as HTMLVideoElement).poster || undefined;
  if (tag !== 'canvas') return undefined;
  try {
    return (el as HTMLCanvasElement).toDataURL('image/png');
  } catch {
    return undefined; // 다른 출처 이미지를 그린 canvas 는 읽을 수 없다
  }
}

/** 요소가 속한 문서(렌더 iframe)의 window */
function winOf(el: Element): Window {
  return el.ownerDocument.defaultView as Window;
}

/**
 * 실제로 그려지는 자식: shadow root 가 있으면 그 자식, <slot> 은 할당된 노드(없으면 기본 내용).
 * 웹 컴포넌트의 내용은 light DOM 자식이 아니라 shadow tree 에 있다.
 */
function composedChildren(el: Element): Node[] {
  if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
  if (el.tagName.toLowerCase() === 'slot') {
    const assigned = (el as HTMLSlotElement).assignedNodes();
    if (assigned.length) return assigned;
  }
  return Array.from(el.childNodes);
}

/** 글자 스타일을 물려주는 요소 (shadow root 바로 아래 글자는 host) */
function styleParent(node: Node): Element | null {
  return node.parentElement ?? ((node.parentNode as ShadowRoot | null)?.host ?? null);
}

function pf(val: string): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

/** 좌표·크기는 소수 둘째 자리까지 유지 (정수 반올림은 자식이 부모를 1px 넘기거나 얇은 선이 사라지게 만든다) */
const round2 = (v: number) => Math.round(v * 100) / 100;

// ─── CSS 색상 정규화 (Canvas API) ─────────────────────────────
// 어떤 CSS 색상 포맷이든 (oklch, color(srgb), 공백구분 rgb 등)
// 항상 legacy `rgb(r, g, b)` / `rgba(r, g, b, a)` 형태로 변환

const _colorCanvas = document.createElement('canvas');
_colorCanvas.width = _colorCanvas.height = 1;
const _colorCtx = _colorCanvas.getContext('2d')!;

function normalizeCssColor(css: string): string {
  if (!css || css === 'transparent' || css === 'none') return css;
  // 이미 legacy 포맷이면 그대로 반환 (성능 최적화)
  if (/^rgba?\(\s*\d+\s*,/.test(css)) return css;
  try {
    _colorCtx.clearRect(0, 0, 1, 1);
    _colorCtx.fillStyle = 'rgba(0,0,0,0)';
    _colorCtx.fillStyle = css;
    _colorCtx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = _colorCtx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return 'transparent';
    return a === 255
      ? `rgb(${r}, ${g}, ${b})`
      : `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
  } catch {
    return css;
  }
}

// 계산값에 그대로 남는 최신 색 표기 (Tailwind v4 는 oklch·oklab 을 기본으로 쓴다)
const COLOR_FN = /\b(oklch|oklab|lab|lch|hwb|color-mix|color|rgba?|hsla?)\(/gi;
const NEEDS_COLOR_NORMALIZE = /\b(oklch|oklab|lab|lch|hwb|color-mix|color)\(|\brgba?\(\s*[\d.]+%?\s+[\d.]/i;

/**
 * 그라디언트·그림자·필터 문자열 안의 색 함수를 legacy rgb()/rgba() 로 바꾼다.
 * Figma 쪽 파서와 SVG 파서는 oklch·color(display-p3 …) 등을 읽지 못한다.
 */
function normalizeColorsIn(value: string): string {
  if (!value || !NEEDS_COLOR_NORMALIZE.test(value)) return value;
  let out = '';
  let last = 0;
  COLOR_FN.lastIndex = 0;
  for (let m = COLOR_FN.exec(value); m; m = COLOR_FN.exec(value)) {
    // 괄호 짝을 맞춰 함수 전체를 잘라낸다 (color-mix 안의 oklch 처럼 중첩될 수 있다)
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++;
      else if (value[end] === ')' && --depth === 0) break;
    }
    const fn = value.slice(m.index, end + 1);
    out += value.slice(last, m.index) + normalizeCssColor(fn);
    last = end + 1;
    COLOR_FN.lastIndex = last;
  }
  return out + value.slice(last);
}

/**
 * borderColor / borderStyle 단축 속성은 개별 면 값이 다를 때
 * "rgba(0,0,0,0) rgba(0,0,0,0) rgb(x,y,z) rgba(0,0,0,0)" 같은 4값 문자열로 반환된다.
 * → 파싱 실패를 막기 위해 개별 면에서 non-empty/non-none/non-transparent 값을 우선 추출.
 */
function effectiveBorderColor(cs: CSSStyleDeclaration): string {
  // 폭이 있는 면 중 가장 두꺼운 면의 색 (폭 0 인 면의 color 는 초기값 currentColor 라 의미가 없다)
  const sides = [
    [cs.borderTopWidth, cs.borderTopColor], [cs.borderRightWidth, cs.borderRightColor],
    [cs.borderBottomWidth, cs.borderBottomColor], [cs.borderLeftWidth, cs.borderLeftColor],
  ].map(([w, c]) => ({ w: pf(w), c: normalizeCssColor(c) }))
    .filter((side) => side.w > 0 && side.c && side.c !== 'transparent')
    .sort((a, b) => b.w - a.w);
  return sides[0]?.c ?? normalizeCssColor(cs.borderColor);
}

function effectiveBorderStyle(cs: CSSStyleDeclaration): string {
  const sides = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  for (const v of sides) {
    if (v && v !== 'none') return v;
  }
  return cs.borderStyle;
}

// ─── 가상 요소 (::before / ::after / ::marker) ─────────────────

/** content 계산값의 따옴표 문자열만 이어 붙인다 ("a" "b" → ab). counter()·attr() 등은 undefined */
function contentText(content: string): string | undefined {
  const parts = content.match(/"(?:[^"\\]|\\.)*"/g);
  if (!parts || parts.join(' ').length !== content.trim().length) return undefined;
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
}

// 아이콘 폰트 글리프(사설 영역)는 Figma 글꼴로 그릴 수 없다
const isIconGlyph = (text: string) => /[\uE000-\uF8FF]/.test(text);

const _measureCanvas = document.createElement('canvas').getContext('2d')!;
function measureTextWidth(text: string, cs: CSSStyleDeclaration): number {
  _measureCanvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return _measureCanvas.measureText(text).width + Math.max(0, text.length - 1) * pf(cs.letterSpacing);
}

interface LineBox { left: number; right: number; top: number; bottom: number }

/** 요소 안 실제 글자의 첫 줄·마지막 줄 상자 (가상 요소는 Range 에 잡히지 않는다) */
function textLines(el: Element): { first: LineBox; last: LineBox } | null {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
  if (rects.length === 0) return null;
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const firstRow = rects.filter((r) => r.top < top + r.height / 2);
  const lastRow = rects.filter((r) => r.bottom > bottom - r.height / 2);
  const box = (row: DOMRect[]): LineBox => ({
    left: Math.min(...row.map((r) => r.left)),
    right: Math.max(...row.map((r) => r.right)),
    top: Math.min(...row.map((r) => r.top)),
    bottom: Math.max(...row.map((r) => r.bottom)),
  });
  return { first: box(firstRow), last: box(lastRow) };
}

/** 가상 요소 글자 → 정렬 기준점(before 는 오른쪽 끝, after 는 왼쪽 끝)에 맞춰 배치되는 텍스트 노드 */
function pseudoTextNode(
  tagName: string, text: string, pcs: CSSStyleDeclaration, anchorX: number, centerY: number, align: 'right' | 'left',
): DomNodeData {
  const w = measureTextWidth(text, pcs);
  const h = parseFloat(pcs.lineHeight) || (pf(pcs.fontSize) || 14) * 1.2;
  const x = align === 'right' ? anchorX - w : anchorX;
  return {
    tagName,
    text,
    textBox: { x: 0, y: 0, width: round2(w), height: round2(h) },
    lineCount: 1,
    rect: { x: round2(x), y: round2(centerY - h / 2), width: round2(w), height: round2(h) },
    visible: true,
    style: { ...plainTextStyle(pcs), textAlign: align },
    children: [],
  };
}

/** 이동만 있는 transform(translate(-50%, -50%) 가운데 정렬 등)의 이동량 */
function translationOf(transform: string): [number, number] {
  const m = parseMatrix(transform);
  return m ? [m[4], m[5]] : [0, 0];
}

/**
 * CSS ::before / ::after 의사 요소를 가상 자식 노드로 추출 (좌표는 호스트 border box 기준).
 * - position:absolute/fixed → left/top(+ translate) 으로 배치된 박스
 * - 인라인 글자(불릿·화살표·필수 표시 *) → 호스트 글자의 첫 줄 앞 / 마지막 줄 뒤
 * - 그 외 크기 있는 박스 → content box 시작점
 */
function extractPseudoElement(
  el: Element,
  pseudo: '::before' | '::after',
): DomNodeData | null {
  try {
    const win = winOf(el);
    const pcs = win.getComputedStyle(el, pseudo);
    const content = pcs.content;
    if (!content || content === 'none' || content === 'normal') return null;
    if (pcs.display === 'none') return null;

    const text = contentText(content);
    if (text && isIconGlyph(text)) return null;
    const hostRect = el.getBoundingClientRect();
    const hostCs = win.getComputedStyle(el);
    const positioned = pcs.position === 'absolute' || pcs.position === 'fixed';
    const inline = !positioned && pcs.display.startsWith('inline');

    if (inline && text && text.trim() && pcs.display === 'inline') {
      const lines = textLines(el);
      const cb = contentBox(hostCs, hostRect);
      const marginAfterBefore = pf(pcs.marginRight);
      const marginBeforeAfter = pf(pcs.marginLeft);
      if (pseudo === '::before') {
        const anchor = lines ? lines.first.left - hostRect.left - marginAfterBefore : cb.x + measureTextWidth(text, pcs);
        const cy = lines ? (lines.first.top + lines.first.bottom) / 2 - hostRect.top : cb.y + cb.height / 2;
        return pseudoTextNode(pseudo, text, pcs, anchor, cy, 'right');
      }
      const anchor = lines ? lines.last.right - hostRect.left + marginBeforeAfter : cb.x;
      const cy = lines ? (lines.last.top + lines.last.bottom) / 2 - hostRect.top : cb.y + cb.height / 2;
      return pseudoTextNode(pseudo, text, pcs, anchor, cy, 'left');
    }

    const w = pf(pcs.width);
    const h = pf(pcs.height);
    if (w < 0.01 || h < 0.01) return null;

    let x = 0;
    let y = 0;
    if (positioned) {
      const bl = pf(hostCs.borderLeftWidth);
      const bt = pf(hostCs.borderTopWidth);
      const [tx, ty] = translationOf(pcs.transform);
      x = bl + (pcs.left !== 'auto' ? pf(pcs.left) : 0) + tx;
      y = bt + (pcs.top !== 'auto' ? pf(pcs.top) : 0) + ty;
    } else if (inline) {
      // 크기 있는 인라인 박스(점·아이콘 자리): 글자 첫 줄 앞 / 마지막 줄 뒤, 세로 가운데
      const lines = textLines(el);
      const cb = contentBox(hostCs, hostRect);
      if (pseudo === '::before') {
        x = lines ? lines.first.left - hostRect.left - pf(pcs.marginRight) - w : cb.x;
        y = lines ? (lines.first.top + lines.first.bottom) / 2 - hostRect.top - h / 2 : cb.y;
      } else {
        x = lines ? lines.last.right - hostRect.left + pf(pcs.marginLeft) : cb.x;
        y = lines ? (lines.last.top + lines.last.bottom) / 2 - hostRect.top - h / 2 : cb.y;
      }
    } else {
      const cb = contentBox(hostCs, hostRect);
      x = cb.x;
      y = cb.y;
    }

    const style = extractStyle(pcs);
    applyRadii(style, pcs, w, h);
    const node: DomNodeData = {
      tagName: pseudo,
      text: text || undefined,
      rect: {
        x: round2(x),
        y: round2(y),
        width: round2(w),
        height: round2(h),
      },
      visible: true,
      style,
      children: [],
    };
    if (text) {
      // 박스 안 글자(숫자 배지 등)는 content box 안에 정렬
      const pad = contentBox(pcs, new DOMRect(0, 0, w, h));
      node.textBox = { x: round2(pad.x), y: round2(pad.y), width: round2(pad.width), height: round2(pad.height) };
      node.lineCount = 1;
    }
    return node;
  } catch {
    return null;
  }
}

// disclosure-* 는 <summary> 의 펼침 삼각형
const MARKER_GLYPHS: Record<string, string> = {
  disc: '•', circle: '◦', square: '▪', 'disclosure-open': '▾', 'disclosure-closed': '▸',
};

function toRoman(n: number): string {
  const table: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

function toAlpha(n: number): string {
  let out = '';
  while (n > 0) { n--; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}

/** <li> 의 번호 (ol start·reversed, li value 반영) */
function listOrdinal(el: Element, win: Window): number {
  const list = el.parentElement;
  const items = list
    ? Array.from(list.children).filter((c) => win.getComputedStyle(c).display === 'list-item')
    : [el];
  const reversed = list?.tagName.toLowerCase() === 'ol' && list.hasAttribute('reversed');
  const startAttr = list?.getAttribute('start');
  let n = startAttr !== null && startAttr !== undefined ? parseInt(startAttr, 10) : reversed ? items.length : 1;
  for (const item of items) {
    const value = item.getAttribute('value');
    if (value !== null && item.tagName.toLowerCase() === 'li') n = parseInt(value, 10);
    if (item === el) return n;
    n += reversed ? -1 : 1;
  }
  return n;
}

function markerText(type: string, n: number): string | undefined {
  if (type.startsWith('"')) return contentText(type)?.trim();
  if (MARKER_GLYPHS[type]) return MARKER_GLYPHS[type];
  switch (type) {
    case 'decimal-leading-zero': return `${n < 10 ? '0' : ''}${n}.`;
    case 'lower-alpha':
    case 'lower-latin': return `${toAlpha(n)}.`;
    case 'upper-alpha':
    case 'upper-latin': return `${toAlpha(n).toUpperCase()}.`;
    case 'lower-roman': return `${toRoman(n)}.`;
    case 'upper-roman': return `${toRoman(n).toUpperCase()}.`;
    default: return `${n}.`; // decimal 및 그 외 번호 체계
  }
}

/**
 * 목록 기호(::marker) → 텍스트 노드.
 * outside 는 content box 왼쪽 바깥, inside 는 첫 줄 글자 앞에 오른쪽 끝을 맞춘다 (기호 뒤 공백만큼 띄움).
 */
function extractListMarker(el: Element, cs: CSSStyleDeclaration): DomNodeData | null {
  if (cs.display !== 'list-item' || cs.listStyleType === 'none' || (cs.listStyleImage && cs.listStyleImage !== 'none')) {
    return null;
  }
  const win = winOf(el);
  const text = markerText(cs.listStyleType, listOrdinal(el, win));
  if (!text) return null;
  const mcs = win.getComputedStyle(el, '::marker');
  const hostRect = el.getBoundingClientRect();
  const cb = contentBox(cs, hostRect);
  const lines = textLines(el);
  const gap = measureTextWidth(' ', mcs);
  const anchor = cs.listStylePosition === 'inside' && lines
    ? lines.first.left - hostRect.left - gap
    : cb.x - gap;
  const cy = lines ? (lines.first.top + lines.first.bottom) / 2 - hostRect.top : cb.y + (parseFloat(cs.lineHeight) || 16) / 2;
  return pseudoTextNode('::marker', text, mcs, anchor, cy, 'right');
}

/**
 * border-*-radius 계산값("10px", "50%", "10px 20px") → px.
 * %는 가로=폭·세로=높이 기준이고, 가로·세로가 다른 타원 모서리는 Figma 가 표현하지 못하므로 작은 쪽을 쓴다.
 */
function resolveRadius(value: string, width: number, height: number): number {
  const parts = (value || '0').trim().split(/\s+/);
  const toPx = (v: string, base: number) => (v.endsWith('%') ? (parseFloat(v) / 100) * base : pf(v));
  const rx = toPx(parts[0], width);
  const ry = toPx(parts[1] ?? parts[0], height);
  return round2(Math.min(rx, ry));
}

function applyRadii(style: DomStyleData, cs: CSSStyleDeclaration, width: number, height: number): void {
  style.borderTopLeftRadius = resolveRadius(cs.borderTopLeftRadius, width, height);
  style.borderTopRightRadius = resolveRadius(cs.borderTopRightRadius, width, height);
  style.borderBottomRightRadius = resolveRadius(cs.borderBottomRightRadius, width, height);
  style.borderBottomLeftRadius = resolveRadius(cs.borderBottomLeftRadius, width, height);
}

/**
 * clip-path 중 Figma 모서리 반경으로 똑같이 표현되는 것만 반영한다 (내용도 잘리도록 overflow 를 hidden 으로).
 * - 정사각형을 가운데 기준으로 꽉 차게 자르는 circle()/ellipse() → 반지름 = 변의 절반
 * - 여백 없는 inset(0 round R) → 반경 R
 * polygon() 이나 박스보다 작게 자르는 경우는 표현할 수 없어 그대로 둔다.
 */
function applyClipPath(style: DomStyleData, cs: CSSStyleDeclaration, width: number, height: number): void {
  const clip = (cs as any).clipPath as string | undefined;
  if (!clip || clip === 'none') return;
  let radius: number | null = null;
  const centered = (at: string | undefined) => !at || /^(50% 50%|center|center center)$/.test(at.trim());
  const shape = clip.match(/^(circle|ellipse)\(\s*([^)]*?)\s*(?:at\s+([^)]*))?\)$/);
  if (shape && Math.abs(width - height) < 1 && centered(shape[3])) {
    const half = width / 2;
    const sizes = (shape[2] || 'closest-side').split(/\s+/).filter(Boolean);
    const full = sizes.every((v) => v === 'closest-side' || v === 'farthest-side' || v === '50%' ||
      (v.endsWith('px') && Math.abs(parseFloat(v) - half) < 1) ||
      // circle() 의 % 는 √(w²+h²)/√2 기준 → 정사각형에서는 변 길이 기준과 같다
      (v.endsWith('%') && Math.abs((parseFloat(v) / 100) * width - half) < 1));
    if (full) radius = half;
  }
  const inset = clip.match(/^inset\(\s*([^)]*?)\s*round\s+([\d.]+)px[^)]*\)$/);
  if (inset && inset[1].split(/\s+/).every((v) => pf(v) === 0)) radius = parseFloat(inset[2]);
  if (radius === null) return;
  style.borderTopLeftRadius = style.borderTopRightRadius = style.borderBottomRightRadius = style.borderBottomLeftRadius = round2(radius);
  style.overflowX = style.overflowY = style.overflow = 'hidden';
}

function extractStyle(cs: CSSStyleDeclaration): DomStyleData {
  return {
    backgroundColor: normalizeCssColor(cs.backgroundColor),
    backgroundImage: (() => {
      // background-clip: text → 그라디언트가 텍스트 색상용이므로 배경에서 제외
      const bgClip = (cs as any).webkitBackgroundClip || cs.backgroundClip;
      if (bgClip === 'text') return '';
      return normalizeColorsIn(cs.backgroundImage || '');
    })(),
    textFillImage: (() => {
      const bgClip = (cs as any).webkitBackgroundClip || cs.backgroundClip;
      return bgClip === 'text' && cs.backgroundImage !== 'none' ? normalizeColorsIn(cs.backgroundImage) : '';
    })(),
    backgroundSize: cs.backgroundSize,
    backgroundRepeat: cs.backgroundRepeat,
    objectFit: cs.objectFit,
    color: textColor(cs),
    fontSize: pf(cs.fontSize) || 14,
    fontWeight: cs.fontWeight,
    fontFamily: cs.fontFamily,
    fontStyle: cs.fontStyle,
    lineHeight: cs.lineHeight,
    textAlign: cs.textAlign,
    letterSpacing: cs.letterSpacing,
    textDecoration: cs.textDecorationLine || cs.textDecoration,
    textDecorationStyle: cs.textDecorationStyle,
    textDecorationColor: normalizeCssColor(cs.textDecorationColor),
    textDecorationThickness: cs.textDecorationThickness,
    textUnderlineOffset: cs.textUnderlineOffset,
    textStrokeWidth: pf((cs as any).webkitTextStrokeWidth),
    textStrokeColor: normalizeCssColor((cs as any).webkitTextStrokeColor || ''),
    textTransform: cs.textTransform,
    fontVariantCaps: cs.fontVariantCaps,
    direction: cs.direction,
    borderTopLeftRadius: pf(cs.borderTopLeftRadius),
    borderTopRightRadius: pf(cs.borderTopRightRadius),
    borderBottomRightRadius: pf(cs.borderBottomRightRadius),
    borderBottomLeftRadius: pf(cs.borderBottomLeftRadius),
    borderTopWidth: pf(cs.borderTopWidth),
    borderRightWidth: pf(cs.borderRightWidth),
    borderBottomWidth: pf(cs.borderBottomWidth),
    borderLeftWidth: pf(cs.borderLeftWidth),
    borderColor: effectiveBorderColor(cs),
    borderTopColor: normalizeCssColor(cs.borderTopColor),
    borderRightColor: normalizeCssColor(cs.borderRightColor),
    borderBottomColor: normalizeCssColor(cs.borderBottomColor),
    borderLeftColor: normalizeCssColor(cs.borderLeftColor),
    borderStyle: effectiveBorderStyle(cs),
    borderCollapse: cs.borderCollapse,
    // opacity:0 도 그대로 살려야 하므로 pf() || 1 로 쓰지 않는다
    opacity: cs.opacity === '' ? 1 : parseFloat(cs.opacity),
    boxShadow: normalizeColorsIn(cs.boxShadow),
    textShadow: normalizeColorsIn(cs.textShadow),
    filter: normalizeColorsIn(cs.filter),
    backdropFilter: (cs as any).backdropFilter || (cs as any).webkitBackdropFilter || 'none',
    mixBlendMode: cs.mixBlendMode,
    overflow: cs.overflow,
    overflowX: cs.overflowX,
    overflowY: cs.overflowY,
    display: cs.display,
    flexDirection: cs.flexDirection,
    flexWrap: cs.flexWrap,
    alignItems: cs.alignItems,
    justifyContent: cs.justifyContent,
    rowGap: pf(cs.rowGap),
    columnGap: pf(cs.columnGap),
    paddingTop: pf(cs.paddingTop),
    paddingRight: pf(cs.paddingRight),
    paddingBottom: pf(cs.paddingBottom),
    paddingLeft: pf(cs.paddingLeft),
    position: cs.position,
    zIndex: cs.zIndex,
  };
}

/** 텍스트 색: -webkit-text-fill-color 가 따로 지정돼 있으면 그 색이 실제로 칠해진다 */
function textColor(cs: CSSStyleDeclaration): string {
  const fill = (cs as any).webkitTextFillColor as string | undefined;
  if (fill && !isClearColor(fill)) return normalizeCssColor(fill);
  return normalizeCssColor(cs.color);
}

/** 완전 투명 색인가 (normalizeCssColor 는 legacy rgba() 를 그대로 돌려주므로 alpha 0 도 확인) */
function isClearColor(css: string): boolean {
  const c = normalizeCssColor(css);
  return !c || c === 'transparent' || /^rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(c);
}

/** 배경·테두리·그림자처럼 자체 박스를 그리는 스타일이 있는가 */
function hasBoxDecoration(cs: CSSStyleDeclaration): boolean {
  if (!isClearColor(cs.backgroundColor)) return true;
  const bgClip = (cs as any).webkitBackgroundClip || cs.backgroundClip;
  if (cs.backgroundImage && cs.backgroundImage !== 'none' && bgClip !== 'text') return true;
  const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
  for (const side of sides) {
    const w = pf((cs as any)[`border${side}Width`]);
    const style = (cs as any)[`border${side}Style`];
    if (w > 0 && style !== 'none' && style !== 'hidden' && !isClearColor((cs as any)[`border${side}Color`])) return true;
  }
  return !!cs.boxShadow && cs.boxShadow !== 'none';
}

function hasPseudoContent(el: Element, win: Window): boolean {
  for (const pseudo of ['::before', '::after']) {
    const pcs = win.getComputedStyle(el, pseudo);
    if (pcs.content && pcs.content !== 'none' && pcs.content !== 'normal' && pcs.display !== 'none') return true;
  }
  return false;
}

/**
 * 앞뒤 글자와 하나의 텍스트 노드로 합쳐도 되는 인라인 요소인가.
 * <strong>/<em>/<a>/<span> 처럼 글자 스타일만 바꾸는 display:inline 요소만 합친다.
 * 배경·테두리가 있는 배지, 아이콘(svg·img), inline-block/block 요소, 가상요소가 있는 요소는
 * 별도 노드로 남겨야 박스·위치가 보존된다.
 */
function isMergeableInline(el: Element, win: Window): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return true;
  if (REPLACED_TAGS.has(tag)) return false;
  if (SKIP_TAGS.has(tag)) return true;
  const cs = win.getComputedStyle(el);
  if (cs.display === 'none') return true;
  if (cs.display !== 'inline') return false;
  if (cs.position === 'absolute' || cs.position === 'fixed') return false;
  if (hasBoxDecoration(cs) || hasPseudoContent(el, win)) return false;
  if (el.shadowRoot) return false;
  return composedChildren(el).every((c) => c.nodeType !== Node.ELEMENT_NODE || isMergeableInline(c as Element, win));
}

type Run = { kind: 'text'; nodes: Node[] } | { kind: 'element'; el: Element };

/**
 * 자식 노드를 "합칠 수 있는 글자 흐름(text run)" 과 "독립 요소" 로 나눈다.
 * 예) <p>Status: <span class="badge">Active</span></p> → [text "Status: "], [element span]
 */
function collectRuns(el: Element, win: Window): Run[] {
  const runs: Run[] = [];
  let cur: Node[] = [];
  // 안쪽이 그려지지 않는 요소: content-visibility:hidden, 닫힌 <details> 의 <summary> 밖 내용
  // (Chrome 은 이 안의 요소에도 레이아웃 값을 돌려주므로 직접 걸러야 한다)
  if (win.getComputedStyle(el).contentVisibility === 'hidden') return runs;
  if (el.tagName.toLowerCase() === 'details' && !el.hasAttribute('open')) {
    const summary = Array.from(el.children).find((c) => c.tagName.toLowerCase() === 'summary');
    return summary ? [{ kind: 'element', el: summary }] : runs;
  }
  const flush = () => {
    if (cur.some((n) => (n.textContent ?? '').trim().length > 0)) runs.push({ kind: 'text', nodes: cur });
    cur = [];
  };
  for (const node of composedChildren(el)) {
    if (node.nodeType === Node.TEXT_NODE) {
      cur.push(node);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (tag === 'br') {
      cur.push(child);
      continue;
    }
    if (SKIP_TAGS.has(tag)) continue;
    if (win.getComputedStyle(child).display === 'none') continue;
    if (isMergeableInline(child, win)) {
      cur.push(child);
    } else {
      flush();
      runs.push({ kind: 'element', el: child });
    }
  }
  flush();
  return runs;
}

// ─── 텍스트 내용 (white-space 규칙 + 스타일 구간) ──────────────

type WsMode = 'collapse' | 'preserve-breaks' | 'preserve';

function wsMode(cs: CSSStyleDeclaration): WsMode {
  const collapse = (cs as any).whiteSpaceCollapse as string | undefined;
  if (collapse === 'preserve' || collapse === 'break-spaces') return 'preserve';
  if (collapse === 'preserve-breaks') return 'preserve-breaks';
  if (collapse === 'collapse') return 'collapse';
  const ws = cs.whiteSpace;
  if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') return 'preserve';
  if (ws === 'pre-line') return 'preserve-breaks';
  return 'collapse';
}

type SegStyle = Omit<TextSegment, 'text'>;
const SEG_KEYS: (keyof SegStyle)[] = [
  'fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'color', 'textDecoration', 'textDecorationStyle',
  'textDecorationColor', 'textDecorationThickness', 'textUnderlineOffset', 'textTransform', 'fontVariantCaps',
  'letterSpacing',
];

type Decoration = Pick<TextSegment, 'textDecoration' | 'textDecorationStyle' | 'textDecorationColor' |
  'textDecorationThickness' | 'textUnderlineOffset'>;

/**
 * text-decoration 은 상속되지 않지만 자손 글자에도 그려진다 → 조상까지 합쳐서 판단.
 * 선 종류는 조상들을 합치고, 모양·색·굵기·간격은 선을 선언한 가장 가까운 요소 것을 쓴다.
 */
function decorationOf(el: Element, win: Window): Decoration {
  const lines = new Set<string>();
  let owner: CSSStyleDeclaration | null = null;
  for (let e: Element | null = el; e; e = e.parentElement) {
    const cs = win.getComputedStyle(e);
    const line = cs.textDecorationLine || '';
    if (line.includes('underline')) lines.add('underline');
    if (line.includes('line-through')) lines.add('line-through');
    if (!owner && (line.includes('underline') || line.includes('line-through'))) owner = cs;
  }
  return {
    textDecoration: Array.from(lines).join(' ') || 'none',
    textDecorationStyle: owner?.textDecorationStyle ?? 'solid',
    textDecorationColor: owner ? normalizeCssColor(owner.textDecorationColor) : '',
    textDecorationThickness: owner?.textDecorationThickness ?? 'auto',
    textUnderlineOffset: owner?.textUnderlineOffset ?? 'auto',
  };
}

function segStyleOf(el: Element, win: Window): SegStyle {
  const cs = win.getComputedStyle(el);
  return {
    fontFamily: cs.fontFamily,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    fontSize: pf(cs.fontSize) || 14,
    color: textColor(cs),
    ...decorationOf(el, win),
    textTransform: cs.textTransform,
    fontVariantCaps: cs.fontVariantCaps,
    letterSpacing: cs.letterSpacing,
  };
}

class TextBuilder {
  text = '';
  private segs: { text: string; style: SegStyle }[] = [];

  private push(s: string, style: SegStyle): void {
    if (!s) return;
    const last = this.segs[this.segs.length - 1];
    if (last && SEG_KEYS.every((k) => last.style[k] === style[k])) last.text += s;
    else this.segs.push({ text: s, style });
    this.text += s;
  }

  appendText(raw: string, cs: CSSStyleDeclaration, style: SegStyle): void {
    const mode = wsMode(cs);
    let s = raw;
    if (mode === 'collapse') s = s.replace(/[ \t\n\r\f]+/g, ' ');
    else if (mode === 'preserve-breaks') s = s.replace(/[ \t\r\f]+/g, ' ').replace(/ ?\n ?/g, '\n');
    else s = s.replace(/\r\n?/g, '\n');
    // 접히는 공백은 줄 첫머리·앞 공백 뒤에서 사라진다
    if (mode !== 'preserve' && s.startsWith(' ') && (this.text === '' || /[ \n]$/.test(this.text))) s = s.slice(1);
    this.push(s, style);
  }

  appendBreak(style: SegStyle): void {
    this.trimTrailingSpace();
    this.push('\n', style);
  }

  private trimTrailingSpace(): void {
    while (this.text.endsWith(' ')) {
      this.text = this.text.slice(0, -1);
      const last = this.segs[this.segs.length - 1];
      last.text = last.text.slice(0, -1);
      if (!last.text) this.segs.pop();
    }
  }

  /** 끝 공백과 마지막 <br> 이 만든 빈 줄을 정리하고, 기본 스타일과 다른 필드만 남긴 구간을 돌려준다 */
  finish(base: SegStyle): { text: string; segments?: TextSegment[] } {
    this.trimTrailingSpace();
    if (this.text.endsWith('\n')) {
      this.text = this.text.slice(0, -1);
      const last = this.segs[this.segs.length - 1];
      last.text = last.text.slice(0, -1);
      if (!last.text) this.segs.pop();
    }
    const segments = this.segs.map((seg) => {
      const out: TextSegment = { text: seg.text };
      for (const k of SEG_KEYS) {
        if (seg.style[k] !== base[k]) (out as any)[k] = seg.style[k];
      }
      return out;
    });
    const styled = segments.some((seg) => Object.keys(seg).length > 1);
    return { text: this.text, segments: styled ? segments : undefined };
  }
}

function walkInline(node: Node, b: TextBuilder, win: Window): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = styleParent(node);
    if (!parent) return;
    b.appendText((node as Text).data, win.getComputedStyle(parent), segStyleOf(parent, win));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') {
    const parent = styleParent(el);
    if (parent) b.appendBreak(segStyleOf(parent, win));
    return;
  }
  if (SKIP_TAGS.has(tag) || win.getComputedStyle(el).display === 'none') return;
  for (const child of composedChildren(el)) walkInline(child, b, win);
}

// ─── 텍스트 위치 측정 (Range) ─────────────────────────────────

interface Measured {
  box: { left: number; top: number; right: number; bottom: number };
  lines: number;
}

/**
 * 노드들이 그려진 줄 상자들의 합집합과 줄 수 (세로로 겹치는 상자는 같은 줄).
 * 노드마다 Range 로 재서 합치므로 slot 에 할당된 light DOM 노드처럼 트리가 다른 노드도 함께 잴 수 있다.
 */
function measureNodes(nodes: Node[]): Measured | null {
  const rects: DOMRect[] = [];
  const collect = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE && ((node as Element).tagName.toLowerCase() === 'slot' || (node as Element).shadowRoot)) {
      composedChildren(node as Element).forEach(collect);
      return;
    }
    const range = (node.ownerDocument as Document).createRange();
    if (node.nodeType === Node.TEXT_NODE) range.selectNodeContents(node);
    else range.selectNode(node);
    rects.push(...Array.from(range.getClientRects()));
  };
  nodes.forEach(collect);
  return measureRects(rects);
}

function measureRects(all: DOMRect[]): Measured | null {
  const rects = all.filter((r) => r.width > 0.5 && r.height > 0.5);
  if (rects.length === 0) return null;
  rects.sort((a, b) => a.top - b.top);
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  let lines = 0;
  let lineBottom = -Infinity;
  let lineHeight = 0;
  for (const r of rects) {
    box.left = Math.min(box.left, r.left);
    box.top = Math.min(box.top, r.top);
    box.right = Math.max(box.right, r.right);
    box.bottom = Math.max(box.bottom, r.bottom);
    if (r.top >= lineBottom - Math.min(r.height, lineHeight) * 0.5) {
      lines++;
      lineBottom = r.bottom;
      lineHeight = r.height;
    } else {
      lineBottom = Math.max(lineBottom, r.bottom);
    }
  }
  return { box, lines };
}

/** content box (border·padding 안쪽) — 요소 rect 기준 */
function contentBox(cs: CSSStyleDeclaration, rect: DOMRect): { x: number; y: number; width: number; height: number } {
  const x = pf(cs.borderLeftWidth) + pf(cs.paddingLeft);
  const y = pf(cs.borderTopWidth) + pf(cs.paddingTop);
  return {
    x,
    y,
    width: Math.max(rect.width - x - pf(cs.borderRightWidth) - pf(cs.paddingRight), 0),
    height: Math.max(rect.height - y - pf(cs.borderBottomWidth) - pf(cs.paddingBottom), 0),
  };
}

/** text-overflow:ellipsis(한 줄) / -webkit-line-clamp(N 줄) 말줄임 */
function truncationOf(cs: CSSStyleDeclaration): { maxLines: number } | undefined {
  const clamp = parseInt((cs as any).webkitLineClamp, 10);
  if (clamp > 0) return { maxLines: clamp };
  const clips = cs.overflowX !== 'visible' || cs.overflow !== 'visible';
  const nowrap = cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre' || (cs as any).textWrapMode === 'nowrap';
  if (cs.textOverflow === 'ellipsis' && clips && nowrap) return { maxLines: 1 };
  return undefined;
}

/** 텍스트 노드가 가진 글자·스타일 구간·측정값을 채운다 */
function fillText(
  target: DomNodeData,
  built: { text: string; segments?: TextSegment[] },
  measured: Measured,
  origin: { left: number; top: number },
  wrap: { x: number; width: number },
  truncate: { maxLines: number } | undefined,
): void {
  target.text = built.text;
  target.textSegments = built.segments;
  target.textBox = {
    x: round2(measured.box.left - origin.left),
    y: round2(measured.box.top - origin.top),
    width: round2(measured.box.right - measured.box.left),
    height: round2(measured.box.bottom - measured.box.top),
  };
  target.wrapBox = { x: round2(wrap.x), width: round2(wrap.width) };
  target.lineCount = measured.lines;
  if (truncate) target.truncate = truncate;
}

/** 배경·테두리·여백을 뺀 순수 글자 스타일 (부모 프레임이 박스를 이미 그린다) */
function plainTextStyle(cs: CSSStyleDeclaration): DomStyleData {
  return {
    ...extractStyle(cs),
    backgroundColor: 'transparent',
    backgroundImage: '',
    borderTopWidth: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
    borderColor: 'transparent',
    borderTopColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent',
    borderStyle: 'none',
    boxShadow: 'none',
    filter: 'none',
    backdropFilter: 'none',
    mixBlendMode: 'normal',
    // 글자는 부모의 일반 흐름 콘텐츠로 그려진다 (부모의 position/z-index 를 물려받지 않는다)
    position: 'static',
    zIndex: 'auto',
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    opacity: 1,
  };
}

/** 여러 요소 사이에 흐르는 글자 묶음 → 가상 #text 자식 노드 */
function textRunNode(parent: Element, parentCs: CSSStyleDeclaration, parentRect: DOMRect, nodes: Node[]): DomNodeData | null {
  const win = winOf(parent);
  const b = new TextBuilder();
  for (const n of nodes) walkInline(n, b, win);
  const built = b.finish(segStyleOf(parent, win));
  if (!built.text.trim()) return null;

  const m = measureNodes(nodes);
  if (!m) return null;

  const node: DomNodeData = {
    tagName: '#text',
    rect: {
      x: round2(m.box.left - parentRect.left),
      y: round2(m.box.top - parentRect.top),
      width: round2(m.box.right - m.box.left),
      height: round2(m.box.bottom - m.box.top),
    },
    visible: true,
    style: { ...plainTextStyle(parentCs), ...decorationOf(parent, win) },
    children: [],
  };
  const cb = contentBox(parentCs, parentRect);
  const origin = { left: m.box.left, top: m.box.top };
  fillText(node, built, m, origin, { x: parentRect.left + cb.x - m.box.left, width: cb.width }, undefined);
  return node;
}

// ─── 폼 컨트롤 ────────────────────────────────────────────────

const SVG_NS_ATTR = 'xmlns="http://www.w3.org/2000/svg"';
const NATIVE_BORDER = '#767676';

/** accent-color (auto 면 Chrome 기본 파랑) */
function accentOf(cs: CSSStyleDeclaration): string {
  const accent = (cs as any).accentColor as string | undefined;
  return accent && accent !== 'auto' ? normalizeCssColor(accent) : 'rgb(0, 117, 255)';
}

/** appearance:auto 인 체크박스·라디오·range·color 는 CSS 로 그려지지 않으므로 기본 모양을 SVG 로 그린다 */
function nativeControlSvg(type: string, el: HTMLInputElement, cs: CSSStyleDeclaration, w: number, h: number): string | null {
  const accent = accentOf(cs);
  const open = `<svg ${SVG_NS_ATTR} width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  if (type === 'checkbox') {
    const box = el.checked
      ? `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="${accent}" stroke="${accent}"/>` +
        `<path d="M${w * 0.24} ${h * 0.52} L${w * 0.42} ${h * 0.7} L${w * 0.76} ${h * 0.3}" fill="none" stroke="#ffffff" ` +
        `stroke-width="${round2(Math.max(1.5, w * 0.14))}" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="#ffffff" stroke="${NATIVE_BORDER}"/>`;
    return open + box + '</svg>';
  }
  if (type === 'radio') {
    const r = Math.min(w, h) / 2;
    const ring = `<circle cx="${w / 2}" cy="${h / 2}" r="${r - 0.5}" fill="#ffffff" stroke="${el.checked ? accent : NATIVE_BORDER}"/>`;
    const dot = el.checked ? `<circle cx="${w / 2}" cy="${h / 2}" r="${round2(r * 0.55)}" fill="${accent}"/>` : '';
    return open + ring + dot + '</svg>';
  }
  if (type === 'range') {
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '100');
    const ratio = max > min ? Math.min(1, Math.max(0, (parseFloat(el.value) - min) / (max - min))) : 0.5;
    const thumbR = Math.min(h / 2, 8);
    const cx = thumbR + (w - thumbR * 2) * ratio;
    const ty = h / 2 - 2;
    return open +
      `<rect x="0" y="${ty}" width="${w}" height="4" rx="2" fill="#efefef" stroke="#b2b2b2" stroke-width="0.5"/>` +
      `<rect x="0" y="${ty}" width="${round2(cx)}" height="4" rx="2" fill="${accent}"/>` +
      `<circle cx="${round2(cx)}" cy="${h / 2}" r="${thumbR}" fill="${accent}"/></svg>`;
  }
  if (type === 'color') {
    return open +
      `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="#efefef" stroke="${NATIVE_BORDER}"/>` +
      `<rect x="4" y="4" width="${Math.max(w - 8, 1)}" height="${Math.max(h - 8, 1)}" fill="${el.value || '#000000'}"/></svg>`;
  }
  return null;
}

/**
 * 기본 모양 <progress>·<meter> → 값만큼 채운 막대 SVG.
 * progress 는 accent-color, meter 는 low/high 범위 밖이면 노랑, 안이면 초록 (Chrome 기본 모양).
 * 값이 없는 progress(진행 중 표시)는 빈 트랙만 그린다.
 */
function meterSvg(el: Element, cs: CSSStyleDeclaration, w: number, h: number): string {
  const tag = el.tagName.toLowerCase();
  let ratio = 0;
  let color = accentOf(cs);
  if (tag === 'progress') {
    const p = el as HTMLProgressElement;
    ratio = p.hasAttribute('value') && p.max > 0 ? Math.min(1, Math.max(0, p.value / p.max)) : 0;
  } else {
    const m = el as HTMLMeterElement;
    ratio = m.max > m.min ? Math.min(1, Math.max(0, (m.value - m.min) / (m.max - m.min))) : 0;
    const outOfRange = (el.hasAttribute('low') && m.value < m.low) || (el.hasAttribute('high') && m.value > m.high);
    color = outOfRange ? 'rgb(255, 185, 0)' : 'rgb(16, 124, 16)';
  }
  const r = round2(Math.min(h / 2, 4));
  return `<svg ${SVG_NS_ATTR} width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${r}" fill="#efefef" stroke="#b2b2b2" stroke-width="0.5"/>` +
    (ratio > 0 ? `<rect x="0.5" y="0.5" width="${round2((w - 1) * ratio)}" height="${h - 1}" rx="${r}" fill="${color}"/>` : '') +
    '</svg>';
}

const DEFAULT_BUTTON_LABEL: Record<string, string> = { submit: 'Submit', reset: 'Reset' };

/**
 * input·textarea·select.
 * 표시 글자는 Range 로 잴 수 없어 content box 기준으로 배치한다 (input 은 세로 가운데, textarea 는 위부터).
 */
function serializeFormControl(el: Element, cs: CSSStyleDeclaration, rect: DOMRect, node: DomNodeData): DomNodeData {
  const tag = el.tagName.toLowerCase();
  const input = el as HTMLInputElement;
  const type = tag === 'input' ? (input.type || 'text').toLowerCase() : tag;
  const native = ((cs as any).appearance || (cs as any).webkitAppearance || 'auto') !== 'none';

  if (['checkbox', 'radio', 'range', 'color'].includes(type)) {
    // 값("on" 등)은 글자로 보이지 않는다. appearance:none 이면 CSS 로 꾸민 박스를 그대로 쓴다
    const svg = native ? nativeControlSvg(type, input, cs, round2(rect.width), round2(rect.height)) : null;
    return svg ? { ...node, tagName: 'svg', svgHtml: svg } : node;
  }
  if (type === 'file' || type === 'image' || type === 'hidden') return node;

  let text: string | undefined;
  let isPlaceholder = false;
  if (tag === 'select') {
    text = (el as HTMLSelectElement).selectedOptions[0]?.text?.trim() || undefined;
  } else {
    const val = tag === 'textarea' ? input.value.replace(/\s+$/, '') : input.value?.trim();
    if (val) text = type === 'password' ? '•'.repeat(input.value.length) : val;
    else if (['submit', 'reset'].includes(type)) text = DEFAULT_BUTTON_LABEL[type];
    else {
      text = el.getAttribute('placeholder')?.trim() || undefined;
      isPlaceholder = !!text;
    }
  }

  if (text) {
    node.text = text;
    const cb = contentBox(cs, rect);
    const lineH = parseFloat(cs.lineHeight) || (pf(cs.fontSize) || 14) * 1.2;
    const lines = tag === 'textarea' ? text.split('\n').length : 1;
    const height = tag === 'textarea' ? Math.min(lines * lineH, cb.height || lines * lineH) : cb.height;
    node.textBox = { x: round2(cb.x), y: round2(cb.y), width: round2(cb.width), height: round2(height) };
    node.wrapBox = { x: round2(cb.x), width: round2(cb.width) };
    node.lineCount = lines;
    if (isPlaceholder) {
      try {
        const phColor = normalizeCssColor(winOf(el).getComputedStyle(el, '::placeholder').color);
        if (phColor && phColor !== 'transparent') node.style.color = phColor;
      } catch { /* ::placeholder not supported */ }
    }
  }

  // 기본 모양 select 는 오른쪽에 펼침 화살표가 있다 → 글자와 화살표를 자식으로 둔다
  if (tag === 'select' && native) {
    const aw = 8;
    const ah = 5;
    const color = normalizeCssColor(cs.color);
    const chevron: DomNodeData = {
      tagName: 'svg',
      svgHtml: `<svg ${SVG_NS_ATTR} width="${aw}" height="${ah}" viewBox="0 0 8 5"><path d="M1 1 L4 4 L7 1" fill="none" ` +
        `stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      rect: { x: round2(rect.width - pf(cs.borderRightWidth) - 4 - aw), y: round2(rect.height / 2 - ah / 2), width: aw, height: ah },
      visible: true,
      style: plainTextStyle(cs),
      children: [],
    };
    if (node.text && node.textBox) {
      const box = node.textBox;
      node.children.push({
        tagName: '#text',
        text: node.text,
        textBox: { x: 0, y: 0, width: box.width, height: box.height },
        wrapBox: { x: 0, width: box.width },
        lineCount: 1,
        rect: { ...box },
        visible: true,
        style: { ...plainTextStyle(cs), color: node.style.color },
        children: [],
      });
      for (const k of ['text', 'textBox', 'wrapBox', 'lineCount'] as const) delete node[k];
    }
    node.children.push(chevron);
  }
  return node;
}

// ─── 회전 ─────────────────────────────────────────────────────

type Matrix = [number, number, number, number, number, number];

function parseMatrix(transform: string): Matrix | null {
  if (!transform || transform === 'none') return null;
  const m2 = transform.match(/^matrix\(([^)]+)\)$/);
  if (m2) {
    const v = m2[1].split(',').map(Number);
    return v.length === 6 && v.every(isFinite) ? (v as Matrix) : null;
  }
  const m3 = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (m3) {
    const v = m3[1].split(',').map(Number);
    return v.length === 16 && v.every(isFinite) ? [v[0], v[1], v[4], v[5], v[12], v[13]] : null;
  }
  return null;
}

/** p' = A·(B·p) */
function multiply([a1, b1, c1, d1, e1, f1]: Matrix, [a2, b2, c2, d2, e2, f2]: Matrix): Matrix {
  return [
    a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * 회전이 들어간 transform 을 찾아 풀어낸다.
 * getBoundingClientRect 는 회전된 외접 사각형을 돌려주므로, 회전을 풀고 원래 크기·로컬 좌표로 잰 뒤
 * Figma 에서 relativeTransform 으로 다시 회전시킨다. 렌더 iframe 은 캡처 후 버리므로 되돌리지 않는다.
 * 순수 이동·확대는 외접 사각형이 곧 결과이므로 그대로 두고, 뒤집기·기울이기는 Figma 회전으로 표현할 수 없어 둔다.
 */
function extractRotation(el: Element, cs: CSSStyleDeclaration): DomNodeData['transform'] | undefined {
  let m = parseMatrix(cs.transform);
  const rotateProp = (cs as any).rotate as string | undefined; // CSS 개별 속성 (Tailwind v4 rotate-*)
  if (rotateProp && rotateProp !== 'none') {
    const deg = rotateProp.match(/^(-?[\d.]+)deg$/);
    if (!deg) return undefined;
    const r = (parseFloat(deg[1]) * Math.PI) / 180;
    const rot: Matrix = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
    m = m ? multiply(rot, m) : rot;
  }
  if (!m) return undefined;
  const scaleProp = (cs as any).scale as string | undefined;
  if (scaleProp && scaleProp !== 'none') return undefined;
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  const angle = (Math.atan2(b, a) * 180) / Math.PI;
  if (Math.abs(angle) < 0.01 || det <= 0 || Math.abs(a * c + b * d) > 1e-3 * det) return undefined;

  const [ox, oy] = (cs.transformOrigin || '0 0').split(/\s+/).map(pf);
  const style = (el as HTMLElement).style;
  style.setProperty('transform', 'none', 'important');
  style.setProperty('rotate', 'none', 'important');
  const r2 = (v: number) => Math.round(v * 1e6) / 1e6;
  return { a: r2(a), b: r2(b), c: r2(c), d: r2(d), e: round2(e), f: round2(f), ox: round2(ox), oy: round2(oy) };
}

// ─── 레이어 이름 ──────────────────────────────────────────────

// Tailwind 등 유틸리티 클래스는 레이어 이름으로 의미가 없다
const UTILITY_CLASS = new RegExp(
  '^(-?(m|p)[trblxyse]?|w|h|size|min-w|min-h|max-w|max-h|gap|space-[xy]|inset|top|right|bottom|left|z|order|' +
  'col|row|basis|grow|shrink|text|font|leading|tracking|bg|from|via|to|border|rounded|ring|shadow|outline|' +
  'opacity|blur|backdrop|fill|stroke|items|justify|content|self|place|object|overflow|translate|rotate|scale|' +
  'skew|origin|transition|duration|ease|delay|animate|cursor|select|pointer-events|decoration|underline-offset|' +
  'line-clamp|columns|aspect|divide|accent|caret|flex|grid|display)(-|$)|^(flex|grid|block|inline|inline-block|' +
  'inline-flex|hidden|contents|absolute|relative|fixed|sticky|static|container|truncate|uppercase|lowercase|' +
  'capitalize|italic|underline|sr-only|visible|invisible|grow|shrink|mx-auto|group|peer)$|[:\\[\\]/!]',
);

/** data-name → id → aria-label → img alt → 버튼·링크 글자 → 의미 있는 클래스 순으로 레이어 이름을 정한다 */
function layerName(el: Element, tag: string): string | undefined {
  const explicit = el.getAttribute('data-name') || el.getAttribute('data-figma-name');
  if (explicit) return explicit.trim();
  if (el.id) return `${tag}#${el.id}`;
  const label = el.getAttribute('aria-label');
  if (label) return `${tag} · ${label.trim()}`;
  if (tag === 'img' && el.getAttribute('alt')) return `img · ${el.getAttribute('alt')!.trim()}`;
  if (tag === 'button' || tag === 'a') {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return `${tag} · ${text.length > 24 ? text.slice(0, 24) + '…' : text}`;
  }
  const cls = Array.from(el.classList).find((c) => c.length >= 3 && /[a-z]/i.test(c) && !UTILITY_CLASS.test(c));
  return cls ? `${tag}.${cls}` : undefined;
}

/**
 * 형제 레이어를 CSS 그리기 순서로 정렬 (뒤에 올수록 위에 그려진다).
 * 음수 z-index → 일반 흐름 요소·글자 → z-index auto/0 인 positioned 요소 → 양수 z-index, 같은 층은 DOM 순서.
 * flex·grid 자식은 position 이 없어도 z-index 가 적용된다.
 */
function sortByPaintOrder(children: DomNodeData[], parentDisplay: string): DomNodeData[] {
  const flexOrGrid = /flex|grid/.test(parentDisplay);
  const layerOf = (c: DomNodeData): [number, number] => {
    const z = parseInt(c.style.zIndex, 10);
    const positioned = c.style.position !== 'static';
    if (!positioned && !(flexOrGrid && !isNaN(z))) return [1, 0];
    if (isNaN(z) || z === 0) return positioned ? [2, 0] : [1, 0];
    return z < 0 ? [0, z] : [3, z];
  };
  return children
    .map((c, i) => ({ c, i, k: layerOf(c) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i)
    .map((x) => x.c);
}

/**
 * @param el 직렬화할 DOM 요소 (position:fixed 는 render.ts prepareForCapture 에서 absolute 로 바뀐 상태)
 * @param parentRect 부모의 getBoundingClientRect (상대 좌표 계산용)
 */
export function serializeDom(el: Element, parentRect: DOMRect): DomNodeData | null {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return null;

  const win = winOf(el);
  const cs = win.getComputedStyle(el);
  if (cs.display === 'none') return null;
  if (cs.visibility === 'hidden') return null;

  const transform = extractRotation(el, cs);
  const rect = el.getBoundingClientRect();
  // display:contents 는 박스가 없고, 크기 0 인 박스(절대위치 래퍼 등)도 자식은 보이므로 자식만 살린다
  const isContents = cs.display === 'contents';
  const collapsed = isContents || rect.width < 0.01 || rect.height < 0.01;

  const relRect = isContents
    ? { x: 0, y: 0, width: 0, height: 0 }
    : {
      x: round2(rect.left - parentRect.left),
      y: round2(rect.top - parentRect.top),
      width: round2(rect.width),
      height: round2(rect.height),
    };

  // 크기 0 인 그림·폼 요소는 보이는 것이 없다
  if (collapsed && (tag === 'svg' || MEDIA_TAGS.has(tag) || FORM_TAGS.has(tag) || tag === 'progress' || tag === 'meter')) {
    return null;
  }

  // SVG: outerHTML을 직렬화하여 Figma에서 createNodeFromSvg로 재현
  if (tag === 'svg') {
    return {
      tagName: 'svg',
      name: layerName(el, tag),
      svgHtml: serializeSvg(el as SVGElement, cs),
      rect: relRect,
      visible: true,
      transform,
      style: extractStyle(cs),
      children: [],
    };
  }

  const node: DomNodeData = { tagName: tag, rect: relRect, visible: true, style: extractStyle(cs), children: [] };
  if (transform) node.transform = transform;
  const name = layerName(el, tag);
  if (name) node.name = name;
  applyRadii(node.style, cs, rect.width, rect.height);
  applyClipPath(node.style, cs, rect.width, rect.height);

  if (FORM_TAGS.has(tag)) return serializeFormControl(el, cs, rect, node);
  if (tag === 'progress' || tag === 'meter') {
    const native = ((cs as any).appearance || (cs as any).webkitAppearance || 'auto') !== 'none';
    return native ? { ...node, tagName: 'svg', svgHtml: meterSvg(el, cs, round2(rect.width), round2(rect.height)) } : node;
  }
  if (MEDIA_TAGS.has(tag)) {
    node.imageUrl = mediaImageUrl(el, tag);
    return node;
  }

  // ── 글자 흐름 / 자식 요소 분리 ──────────────────────
  const runs = collectRuns(el, win);
  // 자식 좌표의 기준점 (display:contents 는 부모 원점)
  const origin = { left: parentRect.left + relRect.x, top: parentRect.top + relRect.y };
  const childBase = isContents
    ? parentRect
    : new DOMRect(origin.left, origin.top, rect.width, rect.height);
  if (runs.length === 1 && runs[0].kind === 'text') {
    // 텍스트 리프: 요소 전체가 하나의 글자 흐름
    const b = new TextBuilder();
    const kids = composedChildren(el);
    for (const n of kids) walkInline(n, b, win);
    const built = b.finish(segStyleOf(el, win));
    const m = built.text.trim() ? measureNodes(kids) : null;
    if (m) {
      const truncate = truncationOf(cs);
      // display:contents 는 자기 박스가 없으므로 부모 박스 폭에서 줄바꿈된다
      const box = isContents ? parentRect : rect;
      const cb = contentBox(cs, box);
      // 인라인 요소는 content box 가 사각형이 아니므로 실제 글자 폭을 줄바꿈 기준으로 쓴다
      const wrap = cs.display === 'inline' && !truncate
        ? { x: m.box.left - origin.left, width: m.box.right - m.box.left }
        : { x: box.left + cb.x - origin.left, width: cb.width };
      fillText(node, built, m, origin, wrap, truncate);
      Object.assign(node.style, decorationOf(el, win));
      // 여러 줄 말줄임: Range 는 잘려 숨은 줄까지 잡으므로 보이는 줄만큼을 content 위쪽부터 글자 영역으로 쓴다
      if (truncate && truncate.maxLines > 1 && node.textBox) {
        const lineH = parseFloat(cs.lineHeight) || (m.box.bottom - m.box.top) / m.lines;
        node.textBox = {
          ...node.textBox,
          y: round2(box.top + cb.y - origin.top),
          height: round2(lineH * Math.min(truncate.maxLines, m.lines)),
        };
      }
    }
  } else {
    for (const run of runs) {
      const child = run.kind === 'text'
        ? textRunNode(el, cs, childBase, run.nodes)
        : serializeDom(run.el, childBase);
      if (child) node.children.push(child);
    }
  }

  // ::marker / ::before / ::after 가상 요소 추출 (display:contents 는 기준이 될 박스가 없다)
  if (!isContents) {
    const pseudoBefore = extractPseudoElement(el, '::before');
    if (pseudoBefore) node.children.unshift(pseudoBefore);
    const marker = extractListMarker(el, cs);
    if (marker) node.children.unshift(marker);
    const pseudoAfter = extractPseudoElement(el, '::after');
    if (pseudoAfter) node.children.push(pseudoAfter);
  }

  node.children = sortByPaintOrder(node.children, cs.display);

  if (collapsed) {
    if (node.children.length === 0 && !node.text) return null;
    node.collapsed = true;
    if (isContents) node.contents = true;
  }

  // 텍스트와 의사 요소가 공존하면 텍스트를 측정된 위치의 #text 자식 노드로 옮긴다
  // (buildTree 에서 text+children 동시 처리 불가)
  if (node.text && node.children.length > 0 && node.textBox) {
    const box = node.textBox;
    node.children.push({
      tagName: '#text',
      text: node.text,
      textSegments: node.textSegments,
      textBox: { x: 0, y: 0, width: box.width, height: box.height },
      wrapBox: node.wrapBox ? { x: round2(node.wrapBox.x - box.x), width: node.wrapBox.width } : undefined,
      lineCount: node.lineCount,
      truncate: node.truncate,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      visible: true,
      style: plainTextStyle(cs),
      children: [],
    });
    for (const k of ['text', 'textSegments', 'textBox', 'wrapBox', 'lineCount', 'truncate'] as const) delete node[k];
  }

  return node;
}

// ─── SVG ──────────────────────────────────────────────────────

// Figma SVG 파서는 CSS(class·<style>·상속된 color)를 모르므로, 계산된 표현 속성을 속성으로 옮긴다
const SVG_PAINT_PROPS: [cssProp: string, attr: string, initial: string][] = [
  ['fill', 'fill', 'rgb(0, 0, 0)'],
  ['fillOpacity', 'fill-opacity', '1'],
  ['fillRule', 'fill-rule', 'nonzero'],
  ['stroke', 'stroke', 'none'],
  ['strokeWidth', 'stroke-width', '1'],
  ['strokeOpacity', 'stroke-opacity', '1'],
  ['strokeLinecap', 'stroke-linecap', 'butt'],
  ['strokeLinejoin', 'stroke-linejoin', 'miter'],
  ['strokeDasharray', 'stroke-dasharray', 'none'],
  ['strokeMiterlimit', 'stroke-miterlimit', '4'],
  ['opacity', 'opacity', '1'],
  ['stopColor', 'stop-color', 'rgb(0, 0, 0)'],
  ['stopOpacity', 'stop-opacity', '1'],
];
// 상속되지 않는 속성은 부모 값이 아니라 초기값과 비교한다
const SVG_NON_INHERITED = new Set(['opacity', 'stopColor', 'stopOpacity']);
const SVG_COLOR_PROPS = new Set(['fill', 'stroke', 'stopColor']);

function svgValue(cssProp: string, v: string): string {
  // stroke-width 는 단위 없는 숫자로 (Figma 는 "2px" 를 해석하지 못할 수 있다)
  if (cssProp === 'strokeWidth' || cssProp === 'strokeMiterlimit') return String(pf(v));
  // oklch 등은 Figma SVG 파서가 읽지 못하므로 rgb 로
  if (SVG_COLOR_PROPS.has(cssProp) && v && v !== 'none' && !v.startsWith('url(')) return normalizeCssColor(v);
  return v;
}

/**
 * 원본 SVG 트리와 복제본을 같이 순회하며 계산된 fill·stroke 등을 속성으로 옮긴다.
 * 부모에서 그대로 상속된 값은 쓰지 않고, 달라지는 지점에만 적는다 (url(#…) 페인트는 원래 속성 유지).
 */
function inlineSvgStyles(orig: Element, clone: Element, win: Window, parentValues: Record<string, string> | null): void {
  const cs = win.getComputedStyle(orig);
  if (cs.display === 'none') {
    clone.remove();
    return;
  }
  const values: Record<string, string> = {};
  for (const [prop, attr, initial] of SVG_PAINT_PROPS) {
    const v = svgValue(prop, (cs as any)[prop] as string);
    values[prop] = v;
    if (!v || v.startsWith('url(')) continue;
    const base = SVG_NON_INHERITED.has(prop) || !parentValues ? svgValue(prop, initial) : parentValues[prop];
    if (v !== base || (clone.hasAttribute(attr) && clone.getAttribute(attr) !== v)) clone.setAttribute(attr, v);
  }
  const origKids = Array.from(orig.children);
  const cloneKids = Array.from(clone.children);
  for (let i = 0; i < origKids.length && i < cloneKids.length; i++) {
    inlineSvgStyles(origKids[i], cloneKids[i], win, values);
  }
}

const SVG_INLINED_ATTRS = new Set(SVG_PAINT_PROPS.map(([, attr]) => attr));
const SVG_COLOR_ATTRS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color'];

/**
 * Figma SVG 파서가 읽지 못하는 값 정리.
 * - style 속성: 계산값을 이미 속성으로 옮긴 선언과 var() 선언은 지우고, 나머지 색은 rgb 로
 * - 색 속성(<use> 로 복사해 온 내용 등): var() 는 지우고 oklch 등은 rgb 로
 */
function cleanSvgValues(root: Element): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const style = el.getAttribute('style');
    if (style !== null) {
      const kept = style.split(';').map((d) => d.trim()).filter(Boolean).flatMap((decl) => {
        const i = decl.indexOf(':');
        if (i < 0) return [];
        const prop = decl.slice(0, i).trim().toLowerCase();
        const value = decl.slice(i + 1).trim();
        if (SVG_INLINED_ATTRS.has(prop) || value.includes('var(')) return [];
        return [`${prop}:${prop === 'color' ? normalizeCssColor(value) : normalizeColorsIn(value)}`];
      });
      if (kept.length) el.setAttribute('style', kept.join(';'));
      else el.removeAttribute('style');
    }
    for (const attr of SVG_COLOR_ATTRS) {
      const v = el.getAttribute(attr);
      if (v === null) continue;
      if (v.includes('var(')) el.removeAttribute(attr);
      else if (NEEDS_COLOR_NORMALIZE.test(v)) el.setAttribute(attr, normalizeColorsIn(v));
    }
  }
}

/**
 * SVG 요소를 Figma createNodeFromSvg에 넘길 수 있는 완전한 SVG 문자열로 변환.
 *
 * 처리 내용:
 * 1. CSS 로 지정된 fill·stroke 등 → 속성 (currentColor 도 이 과정에서 실제 색이 된다)
 * 2. <use href="#id"> → 참조 대상으로 인라인 치환 (x/y, symbol viewBox 반영)
 * 3. SVG 밖 <defs> 의 그라디언트·클립 등 url(#id) 참조 대상 복사
 * 4. viewBox 보장 + width/height 를 실제 렌더 픽셀값으로
 */
function serializeSvg(svgEl: SVGElement, cs: CSSStyleDeclaration): string {
  const doc = svgEl.ownerDocument;
  const win = winOf(svgEl);
  const NS = 'http://www.w3.org/2000/svg';
  const clone = svgEl.cloneNode(true) as SVGElement;
  inlineSvgStyles(svgEl, clone, win, null);

  // <use> 참조 인라인 처리
  const useEls = Array.from(clone.querySelectorAll('use'));
  for (const useEl of useEls) {
    const href =
      useEl.getAttribute('href') ||
      useEl.getAttribute('xlink:href') ||
      '';
    if (!href.startsWith('#')) continue;
    const target = doc.getElementById(href.slice(1));
    if (!target) continue;

    const g = doc.createElementNS(NS, 'g');
    const transforms: string[] = [];
    const ux = parseFloat(useEl.getAttribute('x') || '0');
    const uy = parseFloat(useEl.getAttribute('y') || '0');
    if (ux || uy) transforms.push(`translate(${ux},${uy})`);
    if (target.tagName.toLowerCase() === 'symbol') {
      // symbol 의 viewBox → use 크기에 맞춘 scale + 원점 이동
      const vb = target.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      if (vb && vb.length === 4 && vb[2] && vb[3]) {
        const uw = parseFloat(useEl.getAttribute('width') || '0') || vb[2];
        const uh = parseFloat(useEl.getAttribute('height') || '0') || vb[3];
        transforms.push(`scale(${uw / vb[2]},${uh / vb[3]})`);
        if (vb[0] || vb[1]) transforms.push(`translate(${-vb[0]},${-vb[1]})`);
      }
      g.innerHTML = target.innerHTML;
    } else {
      const copy = target.cloneNode(true) as Element;
      copy.removeAttribute('id');
      g.appendChild(copy);
    }
    if (transforms.length) g.setAttribute('transform', transforms.join(' '));
    for (const attr of ['fill', 'stroke', 'stroke-width', 'opacity', 'class', 'style']) {
      const v = useEl.getAttribute(attr);
      if (v !== null) g.setAttribute(attr, v);
    }
    useEl.parentNode?.replaceChild(g, useEl);
  }

  // SVG 밖 <defs> 에 정의된 url(#id) 참조 대상을 복사 (아이콘 스프라이트의 그라디언트 등)
  const missing = new Set<string>();
  const refPattern = /url\(\s*["']?#([^"')\s]+)["']?\s*\)/g;
  for (const el of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      for (const m of attr.value.matchAll(refPattern)) {
        if (!clone.querySelector(`[id="${CSS.escape(m[1])}"]`)) missing.add(m[1]);
      }
    }
  }
  if (missing.size > 0) {
    const defs = doc.createElementNS(NS, 'defs');
    for (const id of missing) {
      const def = doc.getElementById(id);
      if (def) defs.appendChild(def.cloneNode(true));
    }
    if (defs.childNodes.length) clone.insertBefore(defs, clone.firstChild);
  }

  // viewBox 가 없으면 원래 좌표계(width/height 속성, 없으면 렌더 크기)를 viewBox 로 고정해
  // CSS 로 크기를 바꿔도 내용이 같이 커지게 한다
  const domR = svgEl.getBoundingClientRect();
  const pw = round2(domR.width) || 24;
  const ph = round2(domR.height) || 24;
  if (!clone.hasAttribute('viewBox')) {
    const attrLen = (name: string, fallback: number) => {
      const v = clone.getAttribute(name);
      return v && /^[\d.]+(px)?$/.test(v.trim()) ? parseFloat(v) : fallback;
    };
    clone.setAttribute('viewBox', `0 0 ${attrLen('width', pw)} ${attrLen('height', ph)}`);
  }

  cleanSvgValues(clone);

  // currentColor → 실제 색상 치환 (<use> 로 가져온 symbol 내용 등 계산 스타일이 없는 부분)
  const computedColor = normalizeCssColor(cs.color || 'black');
  let svgHtml = clone.outerHTML.replace(/currentColor/gi, computedColor);

  // width/height를 항상 DOM 실제 픽셀값으로 교체
  // (width="100%", width="1em" 등 상대값이면 Figma가 잘못 해석)
  svgHtml = svgHtml.replace(/^<svg([^>]*)>/i, (_, attrs: string) => {
    const cleanAttrs = attrs
      .replace(/\s+width\s*=\s*["'][^"']*["']/gi, '')
      .replace(/\s+height\s*=\s*["'][^"']*["']/gi, '');
    return `<svg${cleanAttrs} width="${pw}" height="${ph}">`;
  });

  return svgHtml;
}
