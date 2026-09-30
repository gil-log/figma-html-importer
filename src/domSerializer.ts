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
  'template', 'canvas', 'video', 'audio',
  // hr은 제거 — 구분선으로 직접 렌더링
  // br 은 텍스트 흐름 안에서 줄바꿈으로 처리
]);

// 글자 흐름 안에 있어도 텍스트로 합칠 수 없는 요소 (자체 박스·그림을 가진다)
const REPLACED_TAGS = new Set([
  'svg', 'img', 'canvas', 'video', 'audio', 'iframe', 'input', 'select', 'textarea', 'button',
  'object', 'embed', 'picture', 'math', 'hr', 'progress', 'meter',
]);

const FORM_TAGS = new Set(['input', 'textarea', 'select']);

/** 요소가 속한 문서(렌더 iframe)의 window */
function winOf(el: Element): Window {
  return el.ownerDocument.defaultView as Window;
}

function pf(val: string): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

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

/**
 * borderColor / borderStyle 단축 속성은 개별 면 값이 다를 때
 * "rgba(0,0,0,0) rgba(0,0,0,0) rgb(x,y,z) rgba(0,0,0,0)" 같은 4값 문자열로 반환된다.
 * → 파싱 실패를 막기 위해 개별 면에서 non-empty/non-none/non-transparent 값을 우선 추출.
 */
function effectiveBorderColor(cs: CSSStyleDeclaration): string {
  const sides = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
  for (const v of sides) {
    const n = normalizeCssColor(v);
    if (n && n !== 'transparent') return n;
  }
  return normalizeCssColor(cs.borderColor);
}

function effectiveBorderStyle(cs: CSSStyleDeclaration): string {
  const sides = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  for (const v of sides) {
    if (v && v !== 'none') return v;
  }
  return cs.borderStyle;
}

/**
 * CSS ::before / ::after 의사 요소를 가상 자식 노드로 추출.
 * position:absolute인 경우 부모 기준 위치를 계산한다.
 */
function extractPseudoElement(
  el: Element,
  pseudo: '::before' | '::after',
): DomNodeData | null {
  try {
    const pcs = winOf(el).getComputedStyle(el, pseudo);
    const content = pcs.content;
    if (!content || content === 'none' || content === 'normal') return null;
    if (pcs.display === 'none') return null;

    const w = pf(pcs.width);
    const h = pf(pcs.height);
    if (w < 1 || h < 1) return null;

    let x = 0;
    let y = 0;
    if (pcs.position === 'absolute' || pcs.position === 'fixed') {
      const elCs = winOf(el).getComputedStyle(el);
      const bl = pf(elCs.borderLeftWidth);
      const bt = pf(elCs.borderTopWidth);
      x = bl + (pcs.left !== 'auto' ? pf(pcs.left) : 0);
      y = bt + (pcs.top !== 'auto' ? pf(pcs.top) : 0);
    }

    // CSS content 속성에서 텍스트 추출 (예: content: "•")
    let text: string | undefined;
    const textMatch = content.match(/^"(.*)"$/);
    if (textMatch && textMatch[1]) {
      text = textMatch[1];
    }

    return {
      tagName: pseudo,
      text: text || undefined,
      rect: {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(w),
        height: Math.round(h),
      },
      visible: true,
      style: extractStyle(pcs),
      children: [],
    };
  } catch {
    return null;
  }
}

function extractStyle(cs: CSSStyleDeclaration): DomStyleData {
  return {
    backgroundColor: normalizeCssColor(cs.backgroundColor),
    backgroundImage: (() => {
      // background-clip: text → 그라디언트가 텍스트 색상용이므로 배경에서 제외
      const bgClip = (cs as any).webkitBackgroundClip || cs.backgroundClip;
      if (bgClip === 'text') return '';
      return cs.backgroundImage || '';
    })(),
    color: textColor(cs),
    fontSize: pf(cs.fontSize) || 14,
    fontWeight: cs.fontWeight,
    fontFamily: cs.fontFamily,
    fontStyle: cs.fontStyle,
    lineHeight: cs.lineHeight,
    textAlign: cs.textAlign,
    letterSpacing: cs.letterSpacing,
    textDecoration: cs.textDecorationLine || cs.textDecoration,
    textTransform: cs.textTransform,
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
    borderStyle: effectiveBorderStyle(cs),
    // opacity:0 도 그대로 살려야 하므로 pf() || 1 로 쓰지 않는다
    opacity: cs.opacity === '' ? 1 : parseFloat(cs.opacity),
    boxShadow: cs.boxShadow,
    overflow: cs.overflow,
    display: cs.display,
    flexDirection: cs.flexDirection,
    alignItems: cs.alignItems,
    justifyContent: cs.justifyContent,
    rowGap: pf(cs.rowGap),
    columnGap: pf(cs.columnGap),
    paddingTop: pf(cs.paddingTop),
    paddingRight: pf(cs.paddingRight),
    paddingBottom: pf(cs.paddingBottom),
    paddingLeft: pf(cs.paddingLeft),
    position: cs.position,
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
  return Array.from(el.children).every((c) => isMergeableInline(c, win));
}

type Run = { kind: 'text'; nodes: Node[] } | { kind: 'element'; el: Element };

/**
 * 자식 노드를 "합칠 수 있는 글자 흐름(text run)" 과 "독립 요소" 로 나눈다.
 * 예) <p>Status: <span class="badge">Active</span></p> → [text "Status: "], [element span]
 */
function collectRuns(el: Element, win: Window): Run[] {
  const runs: Run[] = [];
  let cur: Node[] = [];
  const flush = () => {
    if (cur.some((n) => (n.textContent ?? '').trim().length > 0)) runs.push({ kind: 'text', nodes: cur });
    cur = [];
  };
  for (const node of Array.from(el.childNodes)) {
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
  'fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'color', 'textDecoration', 'textTransform', 'letterSpacing',
];

/** text-decoration 은 상속되지 않지만 자손 글자에도 그려진다 → 조상까지 합쳐서 판단 */
function effectiveDecoration(el: Element, win: Window): string {
  const lines = new Set<string>();
  for (let e: Element | null = el; e; e = e.parentElement) {
    const line = win.getComputedStyle(e).textDecorationLine || '';
    if (line.includes('underline')) lines.add('underline');
    if (line.includes('line-through')) lines.add('line-through');
  }
  return Array.from(lines).join(' ') || 'none';
}

function segStyleOf(el: Element, win: Window): SegStyle {
  const cs = win.getComputedStyle(el);
  return {
    fontFamily: cs.fontFamily,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    fontSize: pf(cs.fontSize) || 14,
    color: textColor(cs),
    textDecoration: effectiveDecoration(el, win),
    textTransform: cs.textTransform,
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
    const parent = node.parentElement;
    if (!parent) return;
    b.appendText((node as Text).data, win.getComputedStyle(parent), segStyleOf(parent, win));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') {
    if (el.parentElement) b.appendBreak(segStyleOf(el.parentElement, win));
    return;
  }
  if (SKIP_TAGS.has(tag) || win.getComputedStyle(el).display === 'none') return;
  for (const child of Array.from(el.childNodes)) walkInline(child, b, win);
}

// ─── 텍스트 위치 측정 (Range) ─────────────────────────────────

interface Measured {
  box: { left: number; top: number; right: number; bottom: number };
  lines: number;
}

/** Range 가 그려진 줄 상자들의 합집합과 줄 수 (세로로 겹치는 상자는 같은 줄) */
function measureRange(range: Range): Measured | null {
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
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

const round2 = (v: number) => Math.round(v * 100) / 100;

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
    borderStyle: 'none',
    boxShadow: 'none',
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

  const range = parent.ownerDocument.createRange();
  range.setStartBefore(nodes[0]);
  range.setEndAfter(nodes[nodes.length - 1]);
  const m = measureRange(range);
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
    style: plainTextStyle(parentCs),
    children: [],
  };
  const cb = contentBox(parentCs, parentRect);
  const origin = { left: m.box.left, top: m.box.top };
  fillText(node, built, m, origin, { x: parentRect.left + cb.x - m.box.left, width: cb.width }, undefined);
  return node;
}

/** input·textarea·select 의 표시 글자 (Range 로 잴 수 없어 content box 기준으로 배치) */
function fillFormText(el: Element, cs: CSSStyleDeclaration, rect: DOMRect, node: DomNodeData): boolean {
  const inputEl = el as HTMLInputElement;
  const val = inputEl.value?.trim();
  const ph = el.getAttribute('placeholder')?.trim();
  const text = val || ph;
  if (!text) return false;
  node.text = text;
  const cb = contentBox(cs, rect);
  const isTextarea = el.tagName.toLowerCase() === 'textarea';
  const lineH = parseFloat(cs.lineHeight) || (pf(cs.fontSize) || 14) * 1.2;
  const lines = isTextarea ? text.split('\n').length : 1;
  // input 글자는 세로 가운데, textarea 는 위쪽부터 채워진다
  const height = isTextarea ? Math.min(lines * lineH, cb.height || lines * lineH) : cb.height;
  node.textBox = { x: round2(cb.x), y: round2(cb.y), width: round2(cb.width), height: round2(height) };
  node.wrapBox = { x: round2(cb.x), width: round2(cb.width) };
  node.lineCount = lines;
  if (!val && ph) {
    try {
      const phColor = normalizeCssColor(winOf(el).getComputedStyle(el, '::placeholder').color);
      if (phColor && phColor !== 'transparent') node.style.color = phColor;
    } catch { /* ::placeholder not supported */ }
  }
  return true;
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

  const rect = el.getBoundingClientRect();
  // 크기가 0이면 렌더링 안 된 요소
  if (rect.width < 1 || rect.height < 1) return null;

  const relRect = {
    x: Math.round(rect.left - parentRect.left),
    y: Math.round(rect.top - parentRect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };

  // SVG: outerHTML을 직렬화하여 Figma에서 createNodeFromSvg로 재현
  if (tag === 'svg') {
    return {
      tagName: 'svg',
      svgHtml: serializeSvg(el as SVGElement, cs),
      rect: relRect,
      visible: true,
      style: extractStyle(cs),
      children: [],
    };
  }

  const node: DomNodeData = { tagName: tag, rect: relRect, visible: true, style: extractStyle(cs), children: [] };

  if (FORM_TAGS.has(tag)) {
    fillFormText(el, cs, rect, node);
    return node;
  }
  if (tag === 'img') {
    node.imageUrl = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || undefined;
    return node;
  }

  // ── 글자 흐름 / 자식 요소 분리 ──────────────────────
  const runs = collectRuns(el, win);
  // 수치 기준점: 노드 rect 는 반올림되므로 반올림된 원점 기준으로 텍스트 위치를 잰다
  const origin = { left: parentRect.left + relRect.x, top: parentRect.top + relRect.y };
  if (runs.length === 1 && runs[0].kind === 'text') {
    // 텍스트 리프: 요소 전체가 하나의 글자 흐름
    const b = new TextBuilder();
    for (const n of Array.from(el.childNodes)) walkInline(n, b, win);
    const built = b.finish(segStyleOf(el, win));
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const m = built.text.trim() ? measureRange(range) : null;
    if (m) {
      const truncate = truncationOf(cs);
      const cb = contentBox(cs, rect);
      // 인라인 요소는 content box 가 사각형이 아니므로 실제 글자 폭을 줄바꿈 기준으로 쓴다
      const wrap = cs.display === 'inline' && !truncate
        ? { x: m.box.left - origin.left, width: m.box.right - m.box.left }
        : { x: rect.left + cb.x - origin.left, width: cb.width };
      fillText(node, built, m, origin, wrap, truncate);
    }
  } else {
    for (const run of runs) {
      const child = run.kind === 'text'
        ? textRunNode(el, cs, new DOMRect(origin.left, origin.top, rect.width, rect.height), run.nodes)
        : serializeDom(run.el, new DOMRect(origin.left, origin.top, rect.width, rect.height));
      if (child) node.children.push(child);
    }
  }

  // ::before / ::after 의사 요소 추출
  const pseudoBefore = extractPseudoElement(el, '::before');
  if (pseudoBefore) node.children.unshift(pseudoBefore);
  const pseudoAfter = extractPseudoElement(el, '::after');
  if (pseudoAfter) node.children.push(pseudoAfter);

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

/**
 * SVG 요소를 Figma createNodeFromSvg에 넘길 수 있는 완전한 SVG 문자열로 변환.
 *
 * 처리 내용:
 * 1. <use href="#id"> → 해당 <symbol>/<defs> 내용으로 인라인 치환
 * 2. currentColor → 실제 computed color 값으로 치환
 * 3. 명시적 width/height/viewBox 보장
 */
function serializeSvg(svgEl: SVGElement, cs: CSSStyleDeclaration): string {
  const clone = svgEl.cloneNode(true) as SVGElement;

  // <use> 참조 인라인 처리
  const useEls = Array.from(clone.querySelectorAll('use'));
  for (const useEl of useEls) {
    const href =
      useEl.getAttribute('href') ||
      useEl.getAttribute('xlink:href') ||
      '';
    if (!href.startsWith('#')) continue;
    const symbolEl = svgEl.ownerDocument.getElementById(href.slice(1));
    if (!symbolEl) continue;

    const g = svgEl.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
    // symbol의 viewBox를 transform으로 반영
    const vb = symbolEl.getAttribute('viewBox');
    if (vb) {
      const [, , vw, vh] = vb.split(/\s+/).map(Number);
      const uw = parseFloat(useEl.getAttribute('width') || '0') || vw;
      const uh = parseFloat(useEl.getAttribute('height') || '0') || vh;
      if (vw && vh && uw && uh) {
        const sx = uw / vw, sy = uh / vh;
        g.setAttribute('transform', `scale(${sx},${sy})`);
      }
    }
    g.innerHTML = symbolEl.innerHTML;
    useEl.parentNode?.replaceChild(g, useEl);
  }

  // currentColor → 실제 색상 치환
  const computedColor = cs.color || 'black';
  let svgHtml = clone.outerHTML.replace(/currentColor/gi, computedColor);

  // width/height를 항상 DOM 실제 픽셀값으로 교체
  // (width="100%", width="1em" 등 상대값이면 Figma가 잘못 해석)
  const domR = svgEl.getBoundingClientRect();
  const pw = Math.round(domR.width) || 24;
  const ph = Math.round(domR.height) || 24;
  svgHtml = svgHtml.replace(/^<svg([^>]*)>/i, (_, attrs: string) => {
    const cleanAttrs = attrs
      .replace(/\s+width\s*=\s*["'][^"']*["']/gi, '')
      .replace(/\s+height\s*=\s*["'][^"']*["']/gi, '');
    return `<svg${cleanAttrs} width="${pw}" height="${ph}">`;
  });

  return svgHtml;
}
