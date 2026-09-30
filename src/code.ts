/**
 * code.ts — Figma 플러그인 메인 스레드 (샌드박스)
 *
 * UI로부터 DomNodeData 트리를 받아 Figma API로 노드를 재귀 생성한다.
 * DOM API 없음, Figma API만 사용 가능.
 */
import type { DomNodeData, DomStyleData, UIToMainMessage, MainToUIMessage } from './types';

figma.showUI(__html__, { width: 400, height: 580, themeColors: true });

// ─── 색상 유틸리티 ─────────────────────────────────────────────

interface ParsedColor {
  rgb: RGB;
  a: number;
}

function parseColor(css: string): ParsedColor | null {
  if (!css || css === 'transparent' || css === 'none') return null;

  // Legacy: rgb(243, 243, 243) / rgba(243, 243, 243, 0.5)
  let m = css.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (m) {
    return {
      rgb: {
        r: parseFloat(m[1]) / 255,
        g: parseFloat(m[2]) / 255,
        b: parseFloat(m[3]) / 255,
      },
      a: m[4] !== undefined ? parseFloat(m[4]) : 1,
    };
  }

  // Modern CSS Color Level 4: rgb(243 243 243) / rgb(243 243 243 / 0.5)
  m = css.match(/^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) {
      a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    return {
      rgb: {
        r: parseFloat(m[1]) / 255,
        g: parseFloat(m[2]) / 255,
        b: parseFloat(m[3]) / 255,
      },
      a,
    };
  }

  // color(srgb 0.953 0.953 0.953) / color(srgb 0.953 0.953 0.953 / 0.5)
  m = css.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) {
      a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    return {
      rgb: {
        r: parseFloat(m[1]),  // sRGB: 이미 0~1 범위
        g: parseFloat(m[2]),
        b: parseFloat(m[3]),
      },
      a,
    };
  }

  return null;
}

function isTransparent(css: string): boolean {
  if (!css || css === 'transparent' || css === 'none' || css === '') return true;
  const c = parseColor(css);
  return c !== null && c.a < 0.01;
}

function toSolidPaint(css: string): SolidPaint | null {
  const c = parseColor(css);
  if (!c || c.a < 0.01) return null;
  return { type: 'SOLID', color: c.rgb, opacity: c.a };
}

// ─── 폰트 유틸리티 ────────────────────────────────────────────

// CSS 폰트 패밀리 → Figma에서 사용 가능한 폰트 이름으로 매핑
const FONT_MAP: Record<string, string> = {
  'inter': 'Inter',
  'roboto': 'Roboto',
  'open sans': 'Open Sans',
  'noto sans': 'Noto Sans',
  'lato': 'Lato',
  'montserrat': 'Montserrat',
  'poppins': 'Poppins',
  'nunito': 'Nunito',
  'raleway': 'Raleway',
  'ubuntu': 'Ubuntu',
  'source sans pro': 'Source Sans Pro',
  'playfair display': 'Playfair Display',
  'merriweather': 'Merriweather',
  'georgia': 'Georgia',
  'times new roman': 'Times New Roman',
  'courier new': 'Courier New',
  'roboto mono': 'Roboto Mono',
  'source code pro': 'Source Code Pro',
  'fira code': 'Fira Code',
  'jetbrains mono': 'JetBrains Mono',
  // 한국어 폰트
  'pretendard': 'Pretendard',
  'pretendard variable': 'Pretendard',
  'noto sans kr': 'Noto Sans KR',
  'noto sans cjk kr': 'Noto Sans KR',
  'apple sd gothic neo': 'Noto Sans KR',
  'malgun gothic': 'Noto Sans KR',
  'nanumgothic': 'Noto Sans KR',
  'nanum gothic': 'Noto Sans KR',
  // 시스템 폰트 → Inter로 통일
  'sans-serif': 'Inter',
  'serif': 'Merriweather',
  'monospace': 'Roboto Mono',
  'system-ui': 'Inter',
  '-apple-system': 'Inter',
  'blinkmacsystemfont': 'Inter',
  'segoe ui': 'Inter',
  'helvetica neue': 'Inter',
  'helvetica': 'Inter',
  'arial': 'Inter',
  'apple system': 'Inter',
};

function mapFontFamily(cssFontFamily: string): string {
  const families = cssFontFamily.split(',').map((f) => f.trim().replace(/['"]/g, '').toLowerCase());
  for (const fam of families) {
    if (FONT_MAP[fam]) return FONT_MAP[fam];
  }
  return 'Inter';
}

// CSS font-weight → Figma 스타일 접미사
function weightToFigmaStyle(weight: string, italic: boolean): string {
  const w = parseInt(weight) || 400;
  let style = 'Regular';
  if (w >= 900) style = 'Black';
  else if (w >= 800) style = 'ExtraBold';
  else if (w >= 700) style = 'Bold';
  else if (w >= 600) style = 'SemiBold';
  else if (w >= 500) style = 'Medium';
  else if (w >= 400) style = 'Regular';
  else if (w >= 300) style = 'Light';
  else if (w >= 200) style = 'ExtraLight';
  else if (w >= 100) style = 'Thin';
  // 400 이탤릭은 Figma 폰트 대부분이 'Regular Italic' 이 아니라 'Italic' 으로 부른다
  if (italic) return style === 'Regular' ? 'Italic' : style + ' Italic';
  return style;
}

// Figma에 없는 폰트 스타일은 가까운 것으로 폴백
// 한국어 폰트는 Noto Sans KR을 중간 폴백으로 시도
const KOREAN_FAMILIES = new Set([
  'Pretendard', 'Noto Sans KR', 'Apple SD Gothic Neo',
  'Malgun Gothic', 'NanumGothic',
]);

async function loadBestFont(family: string, style: string): Promise<FontName> {
  const candidates: FontName[] = [
    { family, style },
  ];

  // Figma 폰트 스타일 네이밍은 'SemiBold' / 'Semi Bold' 두 가지 관례가 혼재
  // → 두 변형 모두 시도하여 폰트 로딩 실패 방지
  const spaced = style
    .replace('SemiBold', 'Semi Bold')
    .replace('ExtraBold', 'Extra Bold')
    .replace('ExtraLight', 'Extra Light');
  if (spaced !== style) candidates.push({ family, style: spaced });
  const compact = style
    .replace('Semi Bold', 'SemiBold')
    .replace('Extra Bold', 'ExtraBold')
    .replace('Extra Light', 'ExtraLight');
  if (compact !== style) candidates.push({ family, style: compact });
  if (style === 'Italic') candidates.push({ family, style: 'Regular Italic' });

  candidates.push(
    { family, style: style === 'Italic' ? 'Regular' : style.replace(' Italic', '') },
    { family, style: 'Regular' },
  );

  // 한국어 폰트 → Noto Sans KR 폴백 (Inter보다 한글 표시가 나음)
  if (family !== 'Noto Sans KR' && KOREAN_FAMILIES.has(family)) {
    candidates.push(
      { family: 'Noto Sans KR', style },
      { family: 'Noto Sans KR', style: style.replace(' Italic', '') },
      { family: 'Noto Sans KR', style: 'Regular' },
    );
  }

  candidates.push({ family: 'Inter', style: 'Regular' });

  for (const fn of candidates) {
    try {
      await figma.loadFontAsync(fn);
      return fn;
    } catch {
      // 다음 후보 시도
    }
  }
  throw new Error('Cannot load any font');
}

// ─── Box Shadow 파싱 ───────────────────────────────────────────

interface ParsedShadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: ParsedColor;
}

/**
 * computed box-shadow 목록 파싱.
 * Chrome 은 "rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, ..." 처럼 색을 앞에 두고 여러 겹을 쉼표로 잇는다.
 * (Tailwind shadow-* 는 투명 링 2겹 + 실제 그림자 1~2겹)
 */
function parseShadows(css: string): ParsedShadow[] {
  if (!css || css === 'none') return [];
  const out: ParsedShadow[] = [];
  for (const part of splitTopLevelCommas(css)) {
    let s = part;
    const inset = /\binset\b/.test(s);
    s = s.replace(/\binset\b/, ' ');
    const colorMatch = s.match(/rgba?\([^)]*\)|color\([^)]*\)|#[\da-fA-F]{3,8}\b/);
    if (!colorMatch) continue;
    const color = parseColor(colorMatch[0]) ?? parseHexColor(colorMatch[0]);
    if (!color || color.a < 0.01) continue;
    const lens = s.replace(colorMatch[0], ' ').trim().split(/\s+/).map((v) => parseFloat(v));
    if (lens.length < 2 || lens.some((v) => isNaN(v))) continue;
    out.push({ inset, x: lens[0], y: lens[1], blur: lens[2] ?? 0, spread: lens[3] ?? 0, color });
  }
  return out;
}

// ─── 그라디언트 파싱 ───────────────────────────────────────────

/** 최상위 괄호 레벨에서 쉼표로 분리 (중첩 괄호 안의 쉼표는 무시) */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts;
}

/** CSS 각도 문자열(deg/turn/rad/grad) → deg. 각도가 아니면 null */
function parseAngle(s: string): number | null {
  const m = s.trim().match(/^(-?[\d.]+)(deg|turn|rad|grad)$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case 'turn': return v * 360;
    case 'rad': return (v * 180) / Math.PI;
    case 'grad': return v * 0.9;
    default: return v;
  }
}

/**
 * 컬러 스톱 목록 → [0..1] 위치가 채워진 스톱.
 * CSS 규칙대로 첫/끝 기본값 0%/100%, 뒤 스톱이 앞보다 작으면 앞 위치로 올리고,
 * 위치 없는 스톱은 앞뒤 사이를 균등 분배한다. px 위치는 그라디언트 길이로 나눈다.
 */
function parseColorStops(parts: string[], lengthPx: number): { position: number; color: RGBA }[] {
  const raw: { color: RGBA; pos: number | null }[] = [];
  for (const part of parts) {
    const colorMatch = part.match(/^(rgba?\([^)]*\)|color\([^)]*\)|#[\da-fA-F]{3,8}|transparent)\s*(.*)$/i);
    if (!colorMatch) continue; // 전이 힌트(단독 위치값) 등은 무시
    const parsed = colorMatch[1].toLowerCase() === 'transparent'
      ? { rgb: { r: 0, g: 0, b: 0 }, a: 0 }
      : parseColor(colorMatch[1]) ?? parseHexColor(colorMatch[1]);
    if (!parsed) continue;
    const color = { ...parsed.rgb, a: parsed.a };
    const positions = colorMatch[2].trim().split(/\s+/).filter(Boolean).map((p) =>
      p.endsWith('%') ? parseFloat(p) / 100 : p.endsWith('px') && lengthPx > 0 ? parseFloat(p) / lengthPx : NaN);
    if (positions.length === 0) raw.push({ color, pos: null });
    for (const p of positions) raw.push({ color, pos: isNaN(p) ? null : p });
  }
  if (raw.length < 2) return [];

  if (raw[0].pos === null) raw[0].pos = 0;
  if (raw[raw.length - 1].pos === null) raw[raw.length - 1].pos = 1;
  let maxSoFar = raw[0].pos as number;
  for (const r of raw) {
    if (r.pos !== null) {
      if (r.pos < maxSoFar) r.pos = maxSoFar;
      maxSoFar = r.pos;
    }
  }
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].pos !== null) continue;
    let j = i;
    while (raw[j].pos === null) j++;
    const from = raw[i - 1].pos as number;
    const to = raw[j].pos as number;
    for (let k = i; k < j; k++) raw[k].pos = from + ((to - from) * (k - i + 1)) / (j - i + 1);
  }
  return raw.map((r) => ({ position: r.pos as number, color: r.color }));
}

/** 2x3 아핀 행렬 역행렬 */
function invertTransform([[a, b, tx], [c, d, ty]]: Transform): Transform {
  const det = a * d - b * c || 1e-9;
  return [
    [d / det, -b / det, (b * ty - d * tx) / det],
    [-c / det, a / det, (c * tx - a * ty) / det],
  ];
}

/**
 * CSS linear-gradient() → Figma GradientPaint
 * 예: "linear-gradient(49.89deg, rgb(234, 39, 194) 0%, rgb(225, 0, 163) 100%)"
 *
 * CSS: 그라디언트 선은 박스 중심을 지나고 길이는 |w·sinθ| + |h·cosθ| (각 모서리가 0%/100% 선에 닿는다).
 * Figma: gradientTransform 은 레이어(0..1 정규화) 좌표 → 그라디언트 공간 변환이고,
 *        그라디언트 공간의 (0, 0.5)→(1, 0.5) 가 시작→끝이다. 그래서 시작/끝점으로 만든 행렬의 역행렬을 넣는다.
 */
function parseLinearGradient(css: string, w: number, h: number): GradientPaint | null {
  const m = css.trim().match(/^linear-gradient\(([\s\S]+)\)$/i);
  if (!m) return null;
  const parts = splitTopLevelCommas(m[1]);
  if (parts.length < 2) return null;

  const W = Math.max(w, 1);
  const H = Math.max(h, 1);
  let angleDeg = 180; // 방향 생략 = to bottom (Chrome 은 기본 방향을 computed 값에서 생략한다)
  let stopParts = parts;
  const first = parts[0].trim().toLowerCase();
  const angle = parseAngle(first);
  if (angle !== null) {
    angleDeg = angle;
    stopParts = parts.slice(1);
  } else if (first.startsWith('to ')) {
    const corner = (Math.atan2(H, W) * 180) / Math.PI; // 모서리 방향은 박스 비율에 따라 달라진다
    const dirs: Record<string, number> = {
      'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
      'to top right': corner, 'to right top': corner,
      'to bottom right': 180 - corner, 'to right bottom': 180 - corner,
      'to bottom left': 180 + corner, 'to left bottom': 180 + corner,
      'to top left': 360 - corner, 'to left top': 360 - corner,
    };
    angleDeg = dirs[first.replace(/\s+/g, ' ')] ?? 180;
    stopParts = parts.slice(1);
  }

  const rad = (angleDeg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const length = Math.abs(W * sin) + Math.abs(H * cos);
  const stops = parseColorStops(stopParts, length);
  if (stops.length < 2) return null;

  // 픽셀 좌표의 시작·끝점 (y 는 아래로 증가하므로 방향 벡터는 (sinθ, -cosθ))
  let sx = W / 2 - (sin * length) / 2;
  let sy = H / 2 + (cos * length) / 2;
  let ex = W / 2 + (sin * length) / 2;
  let ey = H / 2 - (cos * length) / 2;

  // 0~1 밖의 스톱은 시작·끝점을 늘려서 표현 (Figma 스톱 위치는 0~1 만 허용)
  const tMin = Math.min(0, stops[0].position);
  const tMax = Math.max(1, stops[stops.length - 1].position);
  if (tMin < 0 || tMax > 1) {
    const dx = ex - sx;
    const dy = ey - sy;
    [sx, sy, ex, ey] = [sx + dx * tMin, sy + dy * tMin, sx + dx * tMax, sy + dy * tMax];
    for (const st of stops) st.position = (st.position - tMin) / (tMax - tMin);
  }

  // 그라디언트 공간 → 레이어 정규화 좌표 행렬 M: (0,0.5)→시작, (1,0.5)→끝, 세로축은 수직 방향
  const ux = (ex - sx) / W;
  const uy = (ey - sy) / H;
  const vx = (cos * length) / W;
  const vy = (sin * length) / H;
  const M: Transform = [
    [ux, vx, sx / W - 0.5 * vx],
    [uy, vy, sy / H - 0.5 * vy],
  ];

  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: invertTransform(M),
    gradientStops: stops.map((st) => ({ position: Math.min(1, Math.max(0, st.position)), color: st.color })),
    opacity: 1,
  };
}

/**
 * background-color + background-image(여러 겹) → Figma fills.
 * CSS 는 첫 번째 레이어가 맨 위, Figma fills 는 마지막이 맨 위이므로 뒤집는다.
 */
function backgroundPaints(s: DomStyleData, w: number, h: number): Paint[] {
  const paints: Paint[] = [];
  const solid = toSolidPaint(s.backgroundColor);
  if (solid) paints.push(solid);
  if (s.backgroundImage && s.backgroundImage !== 'none') {
    const layers = splitTopLevelCommas(s.backgroundImage).reverse();
    for (const layer of layers) {
      const grad = parseLinearGradient(layer, w, h);
      if (grad) paints.push(grad);
    }
  }
  return paints;
}

/** #hex 색상 파싱 보조 */
function parseHexColor(hex: string): ParsedColor | null {
  const m = hex.trim().match(/^#([\da-fA-F]{3,8})$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if (h.length === 6) h += 'ff';
  if (h.length !== 8) return null;
  return {
    rgb: {
      r: parseInt(h.slice(0,2), 16) / 255,
      g: parseInt(h.slice(2,4), 16) / 255,
      b: parseInt(h.slice(4,6), 16) / 255,
    },
    a: parseInt(h.slice(6,8), 16) / 255,
  };
}

// ─── 스타일 적용 헬퍼 ─────────────────────────────────────────

function applyFills(node: GeometryMixin, bgColor: string): void {
  const paint = toSolidPaint(bgColor);
  (node as any).fills = paint ? [paint] : [];
}

function applyCornerRadius(frame: FrameNode | RectangleNode, s: DomStyleData): void {
  const { borderTopLeftRadius: tl, borderTopRightRadius: tr,
          borderBottomRightRadius: br, borderBottomLeftRadius: bl } = s;
  if (tl === tr && tr === br && br === bl) {
    if (tl > 0) (frame as any).cornerRadius = Math.round(tl);
  } else {
    (frame as FrameNode).topLeftRadius = Math.round(tl);
    (frame as FrameNode).topRightRadius = Math.round(tr);
    (frame as FrameNode).bottomRightRadius = Math.round(br);
    (frame as FrameNode).bottomLeftRadius = Math.round(bl);
  }
}

function applyStrokes(frame: FrameNode, s: DomStyleData): void {
  const maxW = Math.max(s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth);
  if (maxW <= 0 || s.borderStyle === 'none' || isTransparent(s.borderColor)) return;
  const paint = toSolidPaint(s.borderColor);
  if (!paint) return;
  frame.strokes = [paint];
  frame.strokeAlign = 'INSIDE';

  const isUniform =
    s.borderTopWidth === s.borderRightWidth &&
    s.borderRightWidth === s.borderBottomWidth &&
    s.borderBottomWidth === s.borderLeftWidth;

  if (isUniform) {
    frame.strokeWeight = maxW;
  } else {
    // 개별 면 설정 (border-bottom만 있는 구분선 등)
    frame.strokeTopWeight = s.borderTopWidth;
    frame.strokeRightWeight = s.borderRightWidth;
    frame.strokeBottomWeight = s.borderBottomWidth;
    frame.strokeLeftWeight = s.borderLeftWidth;
  }
}

/**
 * box-shadow → Figma DROP_SHADOW / INNER_SHADOW.
 * Figma 는 spread 를 사각형·타원, 또는 fill 이 보이고 clipsContent 가 켜진 프레임에만 허용한다.
 * - 프레임에 fill 이 있고 자식이 경계 안에 있으면 clipsContent 를 켜서 spread 를 살린다 (보이는 결과는 같다)
 * - 그래도 안 되면 blur·offset 없는 링(Tailwind ring-*)은 stroke 로, 나머지는 spread 를 빼고 넣는다
 */
function applyEffects(node: FrameNode | RectangleNode, s: DomStyleData): void {
  const shadows = parseShadows(s.boxShadow);
  if (shadows.length === 0) return;

  const hasVisibleFill = Array.isArray(node.fills) && node.fills.length > 0;
  let spreadOk = node.type === 'RECTANGLE';
  if (!spreadOk && node.type === 'FRAME' && hasVisibleFill && shadows.some((sh) => sh.spread !== 0)) {
    const fits = node.children.every((c) =>
      c.x >= -0.5 && c.y >= -0.5 && c.x + c.width <= node.width + 0.5 && c.y + c.height <= node.height + 0.5);
    if (node.clipsContent || fits) {
      node.clipsContent = true;
      spreadOk = true;
    }
  }

  const effects: Effect[] = [];
  for (const sh of shadows) {
    const isRing = sh.x === 0 && sh.y === 0 && sh.blur === 0 && sh.spread > 0;
    if (sh.spread !== 0 && !spreadOk && isRing && node.strokes.length === 0) {
      node.strokes = [{ type: 'SOLID', color: sh.color.rgb, opacity: sh.color.a }];
      node.strokeWeight = sh.spread;
      node.strokeAlign = sh.inset ? 'INSIDE' : 'OUTSIDE';
      continue;
    }
    const base = {
      color: { ...sh.color.rgb, a: sh.color.a },
      offset: { x: sh.x, y: sh.y },
      radius: Math.max(0, sh.blur),
      visible: true,
      blendMode: 'NORMAL' as BlendMode,
      ...(spreadOk && sh.spread !== 0 ? { spread: sh.spread } : {}),
    };
    effects.push(sh.inset ? { type: 'INNER_SHADOW', ...base } : { type: 'DROP_SHADOW', ...base });
  }
  if (effects.length > 0) node.effects = effects;
}

function applyFrameStyle(frame: FrameNode, s: DomStyleData, w: number, h: number): void {
  frame.fills = backgroundPaints(s, w, h);

  applyCornerRadius(frame, s);
  if (s.opacity < 1) frame.opacity = s.opacity;
  applyStrokes(frame, s);
  // overflow:hidden → clipsContent=true (둥근 모서리 카드 등 콘텐츠 클리핑)
  // 그 외 → false (position:absolute 뱃지/도트가 부모 경계 밖에 보이도록)
  frame.clipsContent = s.overflow === 'hidden' || s.overflow === 'clip';
}

// ─── 재귀 노드 빌더 ───────────────────────────────────────────

let frameCount = 0;
let textCount = 0;

async function buildTree(node: DomNodeData, parent: FrameNode): Promise<void> {
  const { rect, style, tagName, text, textSegments, children, visible, imageUrl } = node;
  const w = Math.max(rect.width, 1);
  const h = Math.max(rect.height, 1);

  // ── 텍스트 리프 노드 ──────────────────────────────
  if (text && children.length === 0) {
    const family = mapFontFamily(style.fontFamily);
    const isItalic = style.fontStyle === 'italic' || style.fontStyle === 'oblique';
    const figmaStyle = weightToFigmaStyle(style.fontWeight, isItalic);
    const fontName = await loadBestFont(family, figmaStyle);

    // 텍스트 노드 공통 생성 헬퍼
    // fixedWidth > 0 → HEIGHT 모드(고정 폭, text-align 동작)
    // fixedWidth = 0 → WIDTH_AND_HEIGHT 모드(inline 요소 등)
    const makeText = (tx: number, ty: number, fixedWidth = 0): TextNode => {
      const t = figma.createText();
      t.fontName = fontName;
      t.fontSize = Math.max(style.fontSize, 1);
      t.characters = text!;
      const textPaint = toSolidPaint(style.color);
      if (textPaint) t.fills = [textPaint];
      const alignMap: Record<string, 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'> = {
        left: 'LEFT', center: 'CENTER', right: 'RIGHT', justify: 'JUSTIFIED',
      };
      t.textAlignHorizontal = alignMap[style.textAlign] ?? 'LEFT';
      const lh = parseFloat(style.lineHeight);
      if (!isNaN(lh) && lh > 0 && style.lineHeight !== 'normal') {
        t.lineHeight = { value: Math.round(lh), unit: 'PIXELS' };
      }
      const ls = parseFloat(style.letterSpacing);
      if (!isNaN(ls) && style.letterSpacing !== 'normal' && style.letterSpacing !== '0px') {
        t.letterSpacing = { value: ls, unit: 'PIXELS' };
      }
      // text-decoration: underline / line-through
      if (style.textDecoration.includes('underline')) {
        t.textDecoration = 'UNDERLINE';
      } else if (style.textDecoration.includes('line-through')) {
        t.textDecoration = 'STRIKETHROUGH';
      }
      if (fixedWidth > 0) {
        // 블록 요소: 고정 폭 + HEIGHT 자동 → text-align(center/right 등) 동작
        t.textAutoResize = 'HEIGHT';
        t.resize(Math.max(fixedWidth, 10), 20);
      } else {
        // 인라인 요소: Figma가 폰트 메트릭으로 폭/높이 자동 결정
        t.textAutoResize = 'WIDTH_AND_HEIGHT';
      }
      t.x = tx;
      t.y = ty;
      return t;
    };

    // bold/color 세그먼트 적용 헬퍼
    const applyBoldSegments = async (t: TextNode): Promise<void> => {
      if (!textSegments || textSegments.length === 0) return;
      let offset = 0;
      for (const seg of textSegments) {
        const len = seg.text.length;
        if (len > 0 && offset + len <= t.characters.length) {
          if (seg.bold) {
            const boldFont = await loadBestFont(family, weightToFigmaStyle('700', isItalic));
            t.setRangeFontName(offset, offset + len, boldFont);
          }
          if (seg.color) {
            const segPaint = toSolidPaint(seg.color);
            if (segPaint) t.setRangeFills(offset, offset + len, [segPaint]);
          }
        }
        offset += len;
      }
    };

    // 배지/버튼: 테두리 또는 배경이 있으면 Frame으로 감싸 박스 스타일 재현
    const bw = Math.max(style.borderTopWidth, style.borderRightWidth,
      style.borderBottomWidth, style.borderLeftWidth);
    const hasBorder = bw > 0 && style.borderStyle !== 'none' && !isTransparent(style.borderColor);
    const hasBg = !isTransparent(style.backgroundColor) ||
      (style.backgroundImage !== '' && style.backgroundImage !== 'none');

    // 한 줄 텍스트 판단: 높이가 폰트 크기의 3.5배 미만이면 줄바꿈 금지
    // (text-base(16px) + h-[50px] 버튼 등이 올바르게 단일 행으로 처리됨)
    const isSingleLine = h < style.fontSize * 3.5;

    // HEIGHT(고정 폭) vs WIDTH_AND_HEIGHT(자동 폭) 판단 헬퍼
    const calcFixedWidth = (containerW: number): number => {
      const estMin = style.fontSize * (text?.length ?? 1);
      return containerW > estMin * 1.5 ? containerW : 0;
    };

    if (hasBorder || hasBg) {
      const frame = figma.createFrame();
      frame.name = tagName;
      frame.resize(w, h);
      frame.x = rect.x;
      frame.y = rect.y;
      applyFrameStyle(frame, style, w, h);

      if (isSingleLine) {
        // 한 줄 텍스트: WIDTH_AND_HEIGHT → 줄바꿈 절대 방지
        const t = makeText(style.paddingLeft, style.paddingTop, 0);
        await applyBoldSegments(t);
        // 가로 정렬
        const isFlex = style.display.includes('flex');
        if (isFlex && style.justifyContent === 'center') {
          t.x = Math.round((w - t.width) / 2);
        } else if (style.textAlign === 'center') {
          t.x = Math.round((w - t.width) / 2);
        }
        // 세로 정렬
        if (isFlex && style.alignItems === 'center') {
          t.y = Math.round((h - t.height) / 2);
        } else if (tagName === 'button' || tagName === 'a') {
          t.y = Math.round((h - t.height) / 2);
        }
        frame.appendChild(t);
      } else {
        // 여러 줄 가능: 고정 폭
        const textAreaW = Math.max(w - style.paddingLeft - style.paddingRight, 10);
        const t = makeText(style.paddingLeft, style.paddingTop, textAreaW);
        await applyBoldSegments(t);
        // 세로 정렬 (flex center 또는 button/a 태그)
        const isFlex2 = style.display.includes('flex');
        if (isFlex2 && style.alignItems === 'center') {
          t.y = Math.round((h - t.height) / 2);
        } else if (tagName === 'button' || tagName === 'a') {
          t.y = Math.round((h - t.height) / 2);
        }
        frame.appendChild(t);
      }

      applyEffects(frame, style);
      if (!visible) frame.visible = false;
      parent.appendChild(frame);
      frameCount++;
      textCount++;
      return;
    }

    // 일반 텍스트 리프
    // center/right 정렬:
    // ① WIDTH_AND_HEIGHT 모드로 Figma 실제 폰트 폭을 얻어 줄바꿈 없이 렌더
    // ② DOM 중심점(center) 또는 DOM 오른쪽 끝(right)을 기준으로 x 재계산
    if (style.textAlign === 'center' || style.textAlign === 'right') {
      const t = makeText(0, rect.y, 0);
      await applyBoldSegments(t);
      if (style.textAlign === 'center') {
        const domCenter = rect.x + rect.width / 2;
        t.x = Math.round(domCenter - t.width / 2);
      } else {
        t.x = Math.round(rect.x + rect.width - t.width);
      }
      if (!visible) t.visible = false;
      parent.appendChild(t);
      textCount++;
      return;
    }

    // left/start 정렬: DOM 위치 그대로
    // block 요소에서 실제로 텍스트가 줄바꿈되는지 lineHeight로 판별
    const isBlockDisplay = /^(block|flex|grid|list-item|table)/.test(style.display);
    const lineH = parseFloat(style.lineHeight) || (style.fontSize * 1.4);
    const textWraps = isBlockDisplay && h > lineH * 1.3;

    if (textWraps) {
      // 브라우저에서 텍스트가 줄바꿈됨 → 요소 폭을 고정폭으로 사용하여 줄바꿈 보존
      const t = makeText(rect.x, rect.y, w);
      await applyBoldSegments(t);
      if (!visible) t.visible = false;
      parent.appendChild(t);
      textCount++;
      return;
    }

    if (isSingleLine) {
      // 한 줄 텍스트: WIDTH_AND_HEIGHT → 줄바꿈 방지
      const t = makeText(rect.x, rect.y, 0);
      await applyBoldSegments(t);
      if (!visible) t.visible = false;
      parent.appendChild(t);
      textCount++;
      return;
    }

    const fixedW = isBlockDisplay ? calcFixedWidth(w) : 0;
    const t = makeText(rect.x, rect.y, fixedW);
    await applyBoldSegments(t);
    if (!visible) t.visible = false;
    parent.appendChild(t);
    textCount++;
    return;
  }

  // ── SVG → createNodeFromSvg로 실제 벡터 재현 ────
  if (tagName === 'svg') {
    if (node.svgHtml) {
      try {
        const svgFrame = figma.createNodeFromSvg(node.svgHtml);
        svgFrame.name = 'svg-icon';
        svgFrame.fills = [];          // 배경 투명
        // SVG HTML에 이미 정확한 픽셀 width/height가 주입되어 있으므로
        // resize는 실질적 no-op이지만, 부모 좌표계 정합성을 위해 수행
        if (Math.abs(svgFrame.width - w) > 1 || Math.abs(svgFrame.height - h) > 1) {
          svgFrame.resize(w, h);
        }
        svgFrame.x = rect.x;
        svgFrame.y = rect.y;
        if (style.opacity < 1) svgFrame.opacity = style.opacity;
        if (!visible) svgFrame.visible = false;
        parent.appendChild(svgFrame);
        frameCount++;
        return;
      } catch {
        // 파싱 실패 시 아래 fallback으로 진행
      }
    }
    // Fallback: 회색 사각형 플레이스홀더
    const r = figma.createRectangle();
    r.name = 'svg-placeholder';
    r.resize(w, h);
    r.fills = [{ type: 'SOLID', color: { r: 0.7, g: 0.7, b: 0.7 }, opacity: 0.4 }];
    if (style.opacity < 1) r.opacity = style.opacity;
    r.x = rect.x;
    r.y = rect.y;
    if (!visible) r.visible = false;
    parent.appendChild(r);
    return;
  }

  // ── 이미지 플레이스홀더 (<img>) ────────────────────
  if (tagName === 'img') {
    const imgRect = figma.createRectangle();
    imgRect.name = imageUrl ? 'img' : 'img (placeholder)';
    imgRect.resize(w, h);
    imgRect.fills = [{ type: 'SOLID', color: { r: 0.88, g: 0.9, b: 0.92 } }];
    applyCornerRadius(imgRect, style);
    applyEffects(imgRect, style);
    imgRect.x = rect.x;
    imgRect.y = rect.y;
    if (!visible) imgRect.visible = false;
    parent.appendChild(imgRect);
    frameCount++;
    return;
  }

  // ── Frame (div, section, header, ... 모든 박스 요소) ────────
  // 자식 extent가 반올림으로 부모를 초과할 수 있음 → clipsContent 시 잘림 방지
  let frameW = w;
  let frameH = h;
  for (const child of children) {
    frameH = Math.max(frameH, child.rect.y + child.rect.height);
    frameW = Math.max(frameW, child.rect.x + child.rect.width);
  }

  const frame = figma.createFrame();
  frame.resize(frameW, frameH);
  frame.x = rect.x;
  frame.y = rect.y;

  applyFrameStyle(frame, style, w, h);

  // 자식 재귀 처리
  for (const child of children) {
    try {
      await buildTree(child, frame);
    } catch (err) {
      console.error('[html-importer] buildTree error:', err);
    }
  }

  applyEffects(frame, style);
  if (!visible) frame.visible = false;
  parent.appendChild(frame);
  frame.name = tagName;

  frameCount++;
}

// ─── 메시지 핸들러 ────────────────────────────────────────────

figma.ui.onmessage = async function (msg: UIToMainMessage) {
  if (msg.type !== 'import-dom') return;

  frameCount = 0;
  textCount = 0;

  try {
    const data = msg.data;

    // 루트 컨테이너 Frame 생성
    const rootFrame = figma.createFrame();
    rootFrame.name = 'HTML Import';
    rootFrame.resize(Math.max(data.rect.width, 1), Math.max(data.rect.height, 1));

    // 루트 스타일 적용
    applyFrameStyle(rootFrame, data.style, data.rect.width, data.rect.height);

    // 페이지에 추가 후 뷰포트 중앙 배치
    figma.currentPage.appendChild(rootFrame);
    rootFrame.x = Math.round(figma.viewport.center.x - rootFrame.width / 2);
    rootFrame.y = Math.round(figma.viewport.center.y - rootFrame.height / 2);

    // 자식 노드 재귀 생성
    for (const child of data.children) {
      try {
        await buildTree(child, rootFrame);
      } catch (err) {
        console.error('[html-importer] child error:', err);
      }
    }

    applyEffects(rootFrame, data.style);

    // 선택 후 줌
    figma.currentPage.selection = [rootFrame];
    figma.viewport.scrollAndZoomIntoView([rootFrame]);

    figma.ui.postMessage({
      type: 'import-done',
      frameCount,
      textCount,
    } as MainToUIMessage);
  } catch (err: any) {
    figma.ui.postMessage({
      type: 'import-error',
      error: err.message ?? String(err),
    } as MainToUIMessage);
  }
};
