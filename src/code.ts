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

// CSS 폰트 패밀리 별칭 — Figma 에 같은 이름의 폰트가 없을 때 대신 쓸 폰트 (시스템 폰트·generic family)
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

// ─── 폰트 선택 ────────────────────────────────────────────────
//
// 1) CSS font-family 목록을 앞에서부터 보며 Figma 에 설치된 같은 이름의 폰트를 찾는다
// 2) 없으면 FONT_MAP 별칭(시스템 폰트 → Inter/Noto Sans KR 등) 중 설치된 것을 쓴다
// 3) 굵기·이탤릭은 그 폰트가 실제로 가진 스타일 이름에서 가장 가까운 것을 고른다
//    ("SemiBold"/"Semi Bold"/"600", 400 이탤릭 = "Italic" 같은 이름 차이를 흡수)

type FontIndex = Map<string, { family: string; styles: string[] }>;
let fontIndexPromise: Promise<FontIndex> | null = null;

function getFontIndex(): Promise<FontIndex> {
  if (!fontIndexPromise) {
    fontIndexPromise = figma.listAvailableFontsAsync().then((fonts) => {
      const index: FontIndex = new Map();
      for (const { fontName } of fonts) {
        const key = fontName.family.toLowerCase();
        const entry = index.get(key) ?? { family: fontName.family, styles: [] };
        entry.styles.push(fontName.style);
        index.set(key, entry);
      }
      return index;
    });
  }
  return fontIndexPromise;
}

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/;
const KOREAN_CAPABLE = /pretendard|noto sans (kr|cjk)|nanum|apple sd gothic|malgun|spoqa|suit|gmarket|ibm plex sans kr|korean| kr$/i;
const KOREAN_PREFERRED = ['Pretendard', 'Noto Sans KR'];

/** 스타일 이름 → 굵기·이탤릭 */
function parseStyleName(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
  const italic = /italic|oblique/.test(s);
  const numeric = s.match(/([1-9]00)/);
  let weight = 400;
  if (/thin|hairline/.test(s)) weight = 100;
  else if (/extralight|ultralight/.test(s)) weight = 200;
  else if (/light/.test(s)) weight = 300;
  else if (/semibold|demibold/.test(s)) weight = 600;
  else if (/extrabold|ultrabold/.test(s)) weight = 800;
  else if (/black|heavy/.test(s)) weight = 900;
  else if (/bold/.test(s)) weight = 700;
  else if (/medium/.test(s)) weight = 500;
  else if (numeric) weight = parseInt(numeric[1], 10);
  return { weight, italic };
}

/** CSS 폰트 매칭처럼 굵기가 가장 가까운 스타일 (같은 거리면 목표가 500 이상이면 더 굵은 쪽) */
function pickStyle(styles: string[], weight: number, italic: boolean): string {
  let best = styles[0];
  let bestScore = Infinity;
  for (const style of styles) {
    const p = parseStyleName(style);
    const tie = weight >= 500 ? (p.weight >= weight ? 0 : 0.5) : (p.weight <= weight ? 0 : 0.5);
    const score = (p.italic === italic ? 0 : 1000) + Math.abs(p.weight - weight) + tie;
    if (score < bestScore) {
      best = style;
      bestScore = score;
    }
  }
  return best;
}

function resolveFamily(cssFontFamily: string, text: string, index: FontIndex): string {
  const families = cssFontFamily.split(',').map((f) => f.trim().replace(/['"]/g, '').toLowerCase()).filter(Boolean);
  let resolved: string | null = null;
  let explicit = false;
  for (const fam of families) {
    const installed = index.get(fam);
    if (installed) {
      resolved = installed.family;
      explicit = true;
      break;
    }
    const alias = FONT_MAP[fam];
    if (alias && index.has(alias.toLowerCase())) {
      resolved = index.get(alias.toLowerCase())!.family;
      break;
    }
  }
  // 시스템 폰트 별칭으로 온 한글 텍스트는 한글 글꼴로 (브라우저도 한글 글리프는 한글 시스템 폰트로 그린다)
  if (HANGUL.test(text) && (!resolved || (!explicit && !KOREAN_CAPABLE.test(resolved)))) {
    const korean = KOREAN_PREFERRED.find((f) => index.has(f.toLowerCase()));
    if (korean) return korean;
  }
  return resolved ?? 'Inter';
}

const fontCache = new Map<string, Promise<FontName>>();

/** CSS font-family·font-weight·font-style → 로드된 Figma FontName */
function resolveFont(cssFontFamily: string, cssWeight: string, cssFontStyle: string, text: string): Promise<FontName> {
  const weight = parseInt(cssWeight, 10) || 400;
  const italic = cssFontStyle === 'italic' || cssFontStyle.startsWith('oblique');
  const key = `${cssFontFamily}|${weight}|${italic}|${HANGUL.test(text)}`;
  let cached = fontCache.get(key);
  if (!cached) {
    cached = (async () => {
      const index = await getFontIndex();
      const family = resolveFamily(cssFontFamily, text, index);
      const entry = index.get(family.toLowerCase());
      const candidates: FontName[] = [];
      if (entry) candidates.push({ family: entry.family, style: pickStyle(entry.styles, weight, italic) });
      candidates.push({ family: 'Inter', style: pickStyle(index.get('inter')?.styles ?? ['Regular'], weight, italic) });
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
    })();
    fontCache.set(key, cached);
  }
  return cached;
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
    if (tl > 0) (frame as any).cornerRadius = tl;
  } else {
    (frame as FrameNode).topLeftRadius = tl;
    (frame as FrameNode).topRightRadius = tr;
    (frame as FrameNode).bottomRightRadius = br;
    (frame as FrameNode).bottomLeftRadius = bl;
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

  // dashed·dotted → 점선 (Chrome 처럼 dashed 는 굵기의 3배 길이, dotted 는 굵기 길이)
  if (s.borderStyle === 'dashed') frame.dashPattern = [maxW * 3, maxW * 3];
  else if (s.borderStyle === 'dotted') frame.dashPattern = [maxW, maxW];

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
  // overflow 가 visible 이 아니면(hidden·clip·auto·scroll) 넘치는 자식을 자른다
  // (둥근 모서리 카드, 가로 스크롤 칩·캐러셀). visible → 절대위치 뱃지/도트가 부모 경계 밖에 보인다
  frame.clipsContent = [s.overflowX ?? s.overflow, s.overflowY ?? s.overflow].some((v) => v !== 'visible');
}

// ─── 텍스트 노드 ──────────────────────────────────────────────

function toTextAlign(textAlign: string, direction: string): 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED' {
  const rtl = direction === 'rtl';
  switch (textAlign) {
    case 'center':
    case '-webkit-center':
    case '-internal-center':
      return 'CENTER';
    case 'right':
    case '-webkit-right':
      return 'RIGHT';
    case 'left':
    case '-webkit-left':
      return 'LEFT';
    case 'justify':
      return 'JUSTIFIED';
    case 'end':
      return rtl ? 'LEFT' : 'RIGHT';
    default: // start
      return rtl ? 'RIGHT' : 'LEFT';
  }
}

function toTextCase(textTransform: string | undefined): TextCase {
  switch (textTransform) {
    case 'uppercase': return 'UPPER';
    case 'lowercase': return 'LOWER';
    case 'capitalize': return 'TITLE';
    default: return 'ORIGINAL';
  }
}

function toTextDecoration(decoration: string | undefined): TextDecoration {
  if (decoration?.includes('underline')) return 'UNDERLINE';
  if (decoration?.includes('line-through')) return 'STRIKETHROUGH';
  return 'NONE';
}

function toLetterSpacing(letterSpacing: string | undefined): LetterSpacing | null {
  if (!letterSpacing || letterSpacing === 'normal') return null;
  const v = parseFloat(letterSpacing);
  return isNaN(v) || v === 0 ? null : { value: v, unit: 'PIXELS' };
}

/** 인라인 요소의 굵기·이탤릭·글꼴·크기·색·밑줄·대소문자 구간 적용 */
async function applySegments(t: TextNode, node: DomNodeData): Promise<void> {
  const { style, textSegments } = node;
  if (!textSegments) return;
  const baseFont = t.fontName as FontName;
  let offset = 0;
  for (const seg of textSegments) {
    const start = offset;
    const end = offset + seg.text.length;
    offset = end;
    if (end <= start || end > t.characters.length) continue;
    if (seg.fontFamily || seg.fontWeight || seg.fontStyle) {
      const font = await resolveFont(seg.fontFamily ?? style.fontFamily, seg.fontWeight ?? style.fontWeight,
        seg.fontStyle ?? style.fontStyle, seg.text);
      if (font.family !== baseFont.family || font.style !== baseFont.style) t.setRangeFontName(start, end, font);
    }
    if (seg.fontSize) t.setRangeFontSize(start, end, Math.max(seg.fontSize, 1));
    if (seg.color) {
      const paint = toSolidPaint(seg.color);
      if (paint) t.setRangeFills(start, end, [paint]);
    }
    if (seg.textDecoration) t.setRangeTextDecoration(start, end, toTextDecoration(seg.textDecoration));
    if (seg.textTransform) t.setRangeTextCase(start, end, toTextCase(seg.textTransform));
    if (seg.letterSpacing) {
      t.setRangeLetterSpacing(start, end, toLetterSpacing(seg.letterSpacing) ?? { value: 0, unit: 'PIXELS' });
    }
  }
}

/**
 * 텍스트 노드 생성 + 배치.
 * 위치·줄바꿈은 브라우저에서 Range 로 잰 실제 글자 영역(textBox)과 줄 수(lineCount)로 정한다.
 * - 말줄임: content box 폭 고정 + maxLines
 * - 여러 줄: content box 폭 고정(HEIGHT) → 브라우저와 같은 폭에서 줄바꿈
 * - 한 줄: 자동 폭(WIDTH_AND_HEIGHT) → Figma 글꼴 폭 차이로 줄바꿈되지 않게 하고, 정렬 기준점(왼쪽/가운데/오른쪽)에 맞춘다
 * 세로는 글자 영역 중심에 맞춘다.
 * @param ox, oy 노드 rect 원점의 부모 기준 좌표
 */
async function createTextNode(node: DomNodeData, ox: number, oy: number): Promise<TextNode> {
  const { style, rect } = node;
  const fontName = await resolveFont(style.fontFamily, style.fontWeight, style.fontStyle, node.text ?? '');

  const t = figma.createText();
  t.fontName = fontName;
  t.fontSize = Math.max(style.fontSize, 1);
  t.characters = node.text ?? '';
  const textPaint = toSolidPaint(style.color);
  if (textPaint) t.fills = [textPaint];
  const lh = parseFloat(style.lineHeight);
  if (!isNaN(lh) && lh > 0 && style.lineHeight !== 'normal') t.lineHeight = { value: lh, unit: 'PIXELS' };
  const ls = toLetterSpacing(style.letterSpacing);
  if (ls) t.letterSpacing = ls;
  const decoration = toTextDecoration(style.textDecoration);
  if (decoration !== 'NONE') t.textDecoration = decoration;
  const textCase = toTextCase(style.textTransform);
  if (textCase !== 'ORIGINAL') t.textCase = textCase;
  const align = toTextAlign(style.textAlign, style.direction);
  t.textAlignHorizontal = align;
  await applySegments(t, node);

  const box = node.textBox ?? { x: 0, y: 0, width: rect.width, height: rect.height };
  const wrap = node.wrapBox ?? { x: box.x, width: box.width };
  if (node.truncate) {
    t.textAutoResize = 'HEIGHT';
    t.resize(Math.max(wrap.width, 1), Math.max(box.height, 1));
    t.textTruncation = 'ENDING';
    t.maxLines = node.truncate.maxLines;
    t.x = ox + wrap.x;
  } else if ((node.lineCount ?? 1) > 1) {
    t.textAutoResize = 'HEIGHT';
    t.resize(Math.max(wrap.width, 1), Math.max(box.height, 1));
    t.x = ox + wrap.x;
  } else {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
    if (align === 'CENTER') t.x = ox + box.x + box.width / 2 - t.width / 2;
    else if (align === 'RIGHT') t.x = ox + box.x + box.width - t.width;
    else t.x = ox + box.x;
  }
  t.y = oy + box.y + box.height / 2 - t.height / 2;
  return t;
}

// ─── 회전 ─────────────────────────────────────────────────────

/**
 * CSS 회전 → relativeTransform.
 * CSS 는 transform-origin(O) 기준으로 M 을 적용하고 이동(e, f)을 더하므로
 * 요소의 왼쪽 위 모서리는 L + O − M·O + (e, f) 로 간다. 회전과 함께 확대됐으면 배율은 크기에 반영한다.
 */
function applyRotation(n: FrameNode | RectangleNode, node: DomNodeData): void {
  const tf = node.transform;
  if (!tf) return;
  const { a, b, c, d, e, f, ox, oy } = tf;
  const sx = Math.hypot(a, b);
  const sy = (a * d - b * c) / sx;
  if (Math.abs(sx - 1) > 1e-3 || Math.abs(sy - 1) > 1e-3) {
    n.resizeWithoutConstraints(Math.max(n.width * sx, 0.01), Math.max(n.height * sy, 0.01));
  }
  const cos = a / sx;
  const sin = b / sx;
  const x = node.rect.x + ox + e - (a * ox + c * oy);
  const y = node.rect.y + oy + f - (b * ox + d * oy);
  n.relativeTransform = [[cos, -sin, x], [sin, cos, y]];
}

// ─── 재귀 노드 빌더 ───────────────────────────────────────────

let frameCount = 0;
let textCount = 0;

async function buildTree(node: DomNodeData, parent: FrameNode): Promise<void> {
  const { rect, style, tagName, text, children, visible, imageUrl } = node;
  const w = Math.max(rect.width, 0.01);
  const h = Math.max(rect.height, 0.01);

  // ── display:contents: 자기 레이어 없이 자식을 부모에 바로 배치 (자식 좌표는 이미 부모 기준) ──
  if (node.contents) {
    if (text) {
      parent.appendChild(await createTextNode(node, 0, 0));
      textCount++;
    }
    for (const child of children) {
      try {
        await buildTree(child, parent);
      } catch (err) {
        console.error('[html-importer] buildTree error:', err);
      }
    }
    return;
  }

  // ── 텍스트 리프 노드 ──────────────────────────────
  if (text && children.length === 0) {
    // 배지/버튼: 테두리 또는 배경이 있으면 Frame으로 감싸 박스 스타일 재현
    const bw = Math.max(style.borderTopWidth, style.borderRightWidth,
      style.borderBottomWidth, style.borderLeftWidth);
    const hasBorder = bw > 0 && style.borderStyle !== 'none' && !isTransparent(style.borderColor);
    const hasBg = !isTransparent(style.backgroundColor) ||
      (style.backgroundImage !== '' && style.backgroundImage !== 'none');

    if ((hasBorder || hasBg) && !node.collapsed) {
      const frame = figma.createFrame();
      frame.name = tagName;
      frame.resize(w, h);
      frame.x = rect.x;
      frame.y = rect.y;
      applyFrameStyle(frame, style, w, h);
      frame.appendChild(await createTextNode(node, 0, 0));
      applyEffects(frame, style);
      applyRotation(frame, node);
      if (!visible) frame.visible = false;
      parent.appendChild(frame);
      frameCount++;
      textCount++;
      return;
    }

    if (node.transform) {
      // 회전된 텍스트: 요소 크기의 투명 프레임에 넣고 프레임을 회전시킨다
      const wrapper = figma.createFrame();
      wrapper.name = tagName;
      wrapper.fills = [];
      wrapper.clipsContent = false;
      wrapper.resize(w, h);
      wrapper.appendChild(await createTextNode(node, 0, 0));
      if (style.opacity < 1) wrapper.opacity = style.opacity;
      applyRotation(wrapper, node);
      if (!visible) wrapper.visible = false;
      parent.appendChild(wrapper);
      textCount++;
      return;
    }

    const t = await createTextNode(node, rect.x, rect.y);
    if (style.opacity < 1) t.opacity = style.opacity;
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
        applyRotation(svgFrame, node);
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
    applyRotation(r, node);
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
    if (style.opacity < 1) imgRect.opacity = style.opacity;
    imgRect.x = rect.x;
    imgRect.y = rect.y;
    applyRotation(imgRect, node);
    if (!visible) imgRect.visible = false;
    parent.appendChild(imgRect);
    frameCount++;
    return;
  }

  // ── Frame (div, section, header, ... 모든 박스 요소) ────────
  // 크기는 요소 자신의 크기 그대로 둔다 (넘치는 자식 때문에 배경이 커지지 않게)
  const frame = figma.createFrame();
  frame.resize(w, h);
  frame.x = rect.x;
  frame.y = rect.y;

  if (node.collapsed) {
    // 크기 0 박스: 배경·테두리 없이 자식만 보이게 한다
    frame.fills = [];
    frame.clipsContent = false;
    if (style.opacity < 1) frame.opacity = style.opacity;
  } else {
    applyFrameStyle(frame, style, w, h);
  }

  // 자식 재귀 처리
  for (const child of children) {
    try {
      await buildTree(child, frame);
    } catch (err) {
      console.error('[html-importer] buildTree error:', err);
    }
  }

  if (!node.collapsed) applyEffects(frame, style);
  applyRotation(frame, node);
  if (!visible) frame.visible = false;
  parent.appendChild(frame);
  frame.name = tagName;

  frameCount++;
}

/** 자식이 그려지는 오른쪽·아래 끝 (자르지 않는 프레임은 자손까지 따라간다) */
function contentExtent(frame: FrameNode): { right: number; bottom: number } {
  let right = 0;
  let bottom = 0;
  for (const c of frame.children) {
    right = Math.max(right, c.x + c.width);
    bottom = Math.max(bottom, c.y + c.height);
    if (c.type === 'FRAME' && !c.clipsContent && c.children.length > 0) {
      const inner = contentExtent(c);
      right = Math.max(right, c.x + inner.right);
      bottom = Math.max(bottom, c.y + inner.bottom);
    }
  }
  return { right, bottom };
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

    // 페이지에 추가 후 뷰포트 중앙 배치
    figma.currentPage.appendChild(rootFrame);
    rootFrame.x = Math.round(figma.viewport.center.x - rootFrame.width / 2);
    rootFrame.y = Math.round(figma.viewport.center.y - rootFrame.height / 2);

    const isLeaf = (!!data.text && data.children.length === 0) || data.tagName === 'svg' || data.tagName === 'img';
    if (isLeaf) {
      // 버튼·아이콘처럼 요소 하나만 붙여넣은 경우: 루트 프레임 안에 요소 자신을 (0,0) 에 만든다
      rootFrame.fills = [];
      rootFrame.clipsContent = false;
      await buildTree({ ...data, rect: { ...data.rect, x: 0, y: 0 } }, rootFrame);
    } else {
      applyFrameStyle(rootFrame, data.style, data.rect.width, data.rect.height);
      // 자식 노드 재귀 생성
      for (const child of data.children) {
        try {
          await buildTree(child, rootFrame);
        } catch (err) {
          console.error('[html-importer] child error:', err);
        }
      }
      // 페이지 밖으로 넘친 자식(절대위치 요소 등)까지 루트가 감싸도록 늘린다 (루트가 자르지 않을 때만)
      if (!rootFrame.clipsContent) {
        const { right, bottom } = contentExtent(rootFrame);
        if (right > rootFrame.width || bottom > rootFrame.height) {
          rootFrame.resizeWithoutConstraints(Math.max(right, rootFrame.width), Math.max(bottom, rootFrame.height));
        }
      }
      applyEffects(rootFrame, data.style);
    }

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
