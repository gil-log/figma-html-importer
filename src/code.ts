/**
 * code.ts — Figma 플러그인 메인 스레드 (샌드박스)
 *
 * UI로부터 DomNodeData 트리를 받아 Figma API로 노드를 재귀 생성한다.
 * DOM API 없음, Figma API만 사용 가능.
 */
import type {
  DomNodeData, DomStyleData, ImageAsset, ImportOptions, ImportPage, UIToMainMessage, MainToUIMessage,
} from './types';

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

/**
 * 그라디언트 첫 인자에서 색 보간 공간 구문("in oklab", "in oklch longer hue")을 뺀다.
 * Figma 는 보간 공간을 지정할 수 없으므로 방향·모양만 남긴다 (Tailwind v4 가 기본으로 붙인다).
 */
function stripInterpolation(part: string): string {
  return part.replace(/\bin\s+[a-z0-9-]+(\s+(shorter|longer|increasing|decreasing)\s+hue)?/i, '').replace(/\s+/g, ' ').trim();
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
    const positions = colorMatch[2].trim().split(/\s+/).filter(Boolean).map((p) => {
      if (p.endsWith('%')) return parseFloat(p) / 100;
      if (p.endsWith('px') && lengthPx > 0) return parseFloat(p) / lengthPx;
      const angle = parseAngle(p); // conic-gradient 스톱 각도
      return angle !== null ? angle / 360 : NaN;
    });
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

type Stop = { position: number; color: RGBA };

function lerpStop(a: Stop, b: Stop, position: number): Stop {
  const t = b.position === a.position ? 0 : (position - a.position) / (b.position - a.position);
  const mix = (x: number, y: number) => x + (y - x) * t;
  return {
    position,
    color: { r: mix(a.color.r, b.color.r), g: mix(a.color.g, b.color.g), b: mix(a.color.b, b.color.b), a: mix(a.color.a, b.color.a) },
  };
}

/**
 * repeating-*-gradient: 첫~끝 스톱 한 주기를 0~1 이 다 찰 때까지 반복해 펼치고 경계는 보간한다.
 * 스톱이 너무 많아지면(가는 줄무늬를 큰 면에) null → 반복 없는 그라디언트로 둔다.
 */
function repeatStops(stops: Stop[]): Stop[] | null {
  const first = stops[0].position;
  const period = stops[stops.length - 1].position - first;
  if (period <= 1e-6) return null;
  const kStart = Math.floor(-first / period);
  const kEnd = Math.ceil((1 - first) / period);
  if ((kEnd - kStart + 1) * stops.length > 256) return null;
  const all: Stop[] = [];
  for (let k = kStart; k <= kEnd; k++) {
    for (const st of stops) all.push({ position: st.position + k * period, color: st.color });
  }
  const out: Stop[] = [];
  for (let i = 0; i < all.length; i++) {
    const cur = all[i];
    const prev = all[i - 1];
    if (prev && prev.position < 0 && cur.position > 0) out.push(lerpStop(prev, cur, 0));
    if (cur.position >= 0 && cur.position <= 1) out.push(cur);
    if (prev && prev.position < 1 && cur.position > 1) out.push(lerpStop(prev, cur, 1));
  }
  // 경계에 같은 위치 스톱이 겹치면 0% 는 안쪽으로 이어지는 마지막 값, 100% 는 안쪽에서 오는 첫 값만 남긴다
  const trimmed = out.filter((st, i) =>
    !(st.position === 0 && out[i + 1]?.position === 0) && !(st.position === 1 && out[i - 1]?.position === 1));
  return trimmed.length >= 2 ? trimmed : null;
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
  const m = css.trim().match(/^(repeating-)?linear-gradient\(([\s\S]+)\)$/i);
  if (!m) return null;
  const repeating = !!m[1];
  const parts = splitTopLevelCommas(m[2]);
  if (parts.length < 2) return null;

  const W = Math.max(w, 1);
  const H = Math.max(h, 1);
  let angleDeg = 180; // 방향 생략 = to bottom (Chrome 은 기본 방향을 computed 값에서 생략한다)
  let stopParts = parts;
  const first = stripInterpolation(parts[0]).toLowerCase();
  const angle = parseAngle(first);
  if (first === '') {
    stopParts = parts.slice(1); // "in oklab" 만 있는 경우
  } else if (angle !== null) {
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
  let stops = parseColorStops(stopParts, length);
  if (stops.length < 2) return null;
  if (repeating) stops = repeatStops(stops) ?? stops;

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

/** "left"/"center"/"30%"/"12px" → px (기준 길이 base 에 대한 위치) */
function parsePosition(token: string | undefined, base: number): number {
  if (!token || token === 'center') return base / 2;
  if (token === 'left' || token === 'top') return 0;
  if (token === 'right' || token === 'bottom') return base;
  return token.endsWith('%') ? (parseFloat(token) / 100) * base : parseFloat(token) || 0;
}

/** "at X Y" 부분 → 픽셀 중심 */
function parseAtPosition(spec: string, W: number, H: number): { cx: number; cy: number } {
  const at = spec.match(/\bat\s+(.+)$/);
  if (!at) return { cx: W / 2, cy: H / 2 };
  let [x, y] = at[1].trim().split(/\s+/);
  // "at top" / "at bottom" 처럼 세로 키워드만 온 경우
  if ((x === 'top' || x === 'bottom') && (y === undefined || y === 'left' || y === 'right' || y === 'center')) [x, y] = [y, x];
  return { cx: parsePosition(x, W), cy: parsePosition(y, H) };
}

/**
 * CSS radial-gradient() → Figma GRADIENT_RADIAL.
 * Figma 그라디언트 공간의 원(중심 (0.5,0.5), 반지름 0.5)을 CSS 가 계산한 중심·가로/세로 반지름으로 옮기는 행렬의 역행렬.
 */
function parseRadialGradient(css: string, w: number, h: number): GradientPaint | null {
  const m = css.trim().match(/^(repeating-)?radial-gradient\(([\s\S]+)\)$/i);
  if (!m) return null;
  const repeating = !!m[1];
  const parts = splitTopLevelCommas(m[2]);
  const W = Math.max(w, 1);
  const H = Math.max(h, 1);
  const first = stripInterpolation(parts[0]).toLowerCase();
  const hasSpec = !/^(rgba?\(|color\(|#|transparent)/.test(first);
  const spec = hasSpec ? first : '';
  const stopParts = hasSpec ? parts.slice(1) : parts;

  const { cx, cy } = parseAtPosition(spec, W, H);
  const shapeSpec = spec.replace(/\bat\s+.+$/, '').trim();
  const circle = /\bcircle\b/.test(shapeSpec) || (/^[\d.]+px$/.test(shapeSpec.replace(/\bcircle\b/, '').trim()));
  const sideX = [cx, W - cx];
  const sideY = [cy, H - cy];
  const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - cx, y - cy));
  const lengths = shapeSpec.replace(/\b(circle|ellipse)\b/g, '').trim().split(/\s+/).filter(Boolean);
  const keyword = lengths.find((l) => /-(side|corner)$/.test(l)) ?? (lengths.length ? null : 'farthest-corner');
  let rx: number;
  let ry: number;
  if (keyword) {
    const near = keyword.startsWith('closest');
    if (circle) {
      const r = keyword.endsWith('side')
        ? (near ? Math.min(...sideX, ...sideY) : Math.max(...sideX, ...sideY))
        : (near ? Math.min(...corners) : Math.max(...corners));
      rx = ry = r;
    } else {
      rx = near ? Math.min(...sideX) : Math.max(...sideX);
      ry = near ? Math.min(...sideY) : Math.max(...sideY);
      // 모서리 기준 타원은 변 기준 타원의 비율을 유지하며 모서리를 지나도록 √2 배
      if (keyword.endsWith('corner')) {
        rx *= Math.SQRT2;
        ry *= Math.SQRT2;
      }
    }
  } else {
    rx = parsePosition(lengths[0], W);
    ry = circle ? rx : parsePosition(lengths[1] ?? lengths[0], H);
  }
  rx = Math.max(rx, 0.01);
  ry = Math.max(ry, 0.01);

  let stops = parseColorStops(stopParts, rx);
  if (stops.length < 2) return null;
  if (repeating) stops = repeatStops(stops) ?? stops;
  // 100% 밖 스톱은 반지름을 늘려서 표현
  const tMax = Math.max(1, stops[stops.length - 1].position);
  if (tMax > 1) {
    rx *= tMax;
    ry *= tMax;
    for (const st of stops) st.position /= tMax;
  }
  const M: Transform = [
    [(2 * rx) / W, 0, (cx - rx) / W],
    [0, (2 * ry) / H, (cy - ry) / H],
  ];
  return {
    type: 'GRADIENT_RADIAL',
    gradientTransform: invertTransform(M),
    gradientStops: stops.map((st) => ({ position: Math.min(1, Math.max(0, st.position)), color: st.color })),
    opacity: 1,
  };
}

/**
 * CSS conic-gradient() → Figma GRADIENT_ANGULAR.
 * 그라디언트 공간 +x 를 CSS 시작 방향(from, 위=0° 시계방향)으로, +y 를 그보다 90° 시계방향으로 둔다.
 */
function parseConicGradient(css: string, w: number, h: number): GradientPaint | null {
  const m = css.trim().match(/^conic-gradient\(([\s\S]+)\)$/i);
  if (!m) return null;
  const parts = splitTopLevelCommas(m[1]);
  const W = Math.max(w, 1);
  const H = Math.max(h, 1);
  const first = stripInterpolation(parts[0]).toLowerCase();
  const hasSpec = first === '' || /^(from|at)\b/.test(first);
  const spec = hasSpec ? first : '';
  const stopParts = hasSpec ? parts.slice(1) : parts;
  const from = parseAngle(spec.match(/from\s+(\S+)/)?.[1] ?? '0deg') ?? 0;
  const { cx, cy } = parseAtPosition(spec, W, H);
  const stops = parseColorStops(stopParts, 0);
  if (stops.length < 2) return null;

  const r = Math.min(W, H) / 2;
  const a = (from * Math.PI) / 180;
  const u = [(r * Math.sin(a)) / W, (-r * Math.cos(a)) / H];
  const v = [(r * Math.cos(a)) / W, (r * Math.sin(a)) / H];
  const M: Transform = [
    [2 * u[0], 2 * v[0], cx / W - u[0] - v[0]],
    [2 * u[1], 2 * v[1], cy / H - u[1] - v[1]],
  ];
  return {
    type: 'GRADIENT_ANGULAR',
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
    const layers = splitTopLevelCommas(s.backgroundImage);
    // background-size/repeat 목록은 레이어 수보다 짧으면 반복해서 대응된다
    const sizes = splitTopLevelCommas(s.backgroundSize || 'auto');
    const repeats = splitTopLevelCommas(s.backgroundRepeat || 'repeat');
    const layerPaints: Paint[] = [];
    layers.forEach((layer, i) => {
      const paint = parseLinearGradient(layer, w, h) ??
        parseRadialGradient(layer, w, h) ??
        parseConicGradient(layer, w, h) ??
        backgroundImagePaint(layer, sizes[i % sizes.length], repeats[i % repeats.length], s.filter);
      if (paint) layerPaints.push(paint);
    });
    paints.push(...layerPaints.reverse());
  }
  return paints;
}

// ─── 이미지 ───────────────────────────────────────────────────

let imageAssets: Record<string, ImageAsset> = {};
const imageHashes = new Map<string, string | null>();

/** UI 가 받아 온 이미지 → Figma 이미지 해시 (같은 URL 은 한 번만 만든다) */
function imageHash(url: string | undefined): string | null {
  if (!url) return null;
  const cached = imageHashes.get(url);
  if (cached !== undefined) return cached;
  let hash: string | null = null;
  const asset = imageAssets[url];
  if (asset) {
    try {
      hash = figma.createImage(asset.bytes).hash;
    } catch (err) {
      console.error('[html-importer] createImage error:', err);
    }
  }
  imageHashes.set(url, hash);
  return hash;
}

/**
 * filter 의 색 보정 함수 → Figma 이미지 필터 (이미지 fill 에만 적용된다).
 * grayscale(a) → 채도 -a, saturate(s) → 채도 s-1, contrast(c) → 대비 c-1, brightness(b) → 노출 b-1 (-1~1 로 제한)
 */
function imageFilters(filter: string | undefined): ImageFilters | undefined {
  if (!filter || filter === 'none') return undefined;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const out: { saturation?: number; contrast?: number; exposure?: number } = {};
  for (const m of filter.matchAll(/(grayscale|saturate|contrast|brightness)\(\s*([\d.]+)(%?)\s*\)/g)) {
    const v = parseFloat(m[2]) / (m[3] ? 100 : 1);
    if (m[1] === 'grayscale') out.saturation = clamp((out.saturation ?? 0) - Math.min(v, 1));
    if (m[1] === 'saturate') out.saturation = clamp((out.saturation ?? 0) + v - 1);
    if (m[1] === 'contrast') out.contrast = clamp(v - 1);
    if (m[1] === 'brightness') out.exposure = clamp(v - 1);
  }
  return Object.keys(out).length ? out : undefined;
}

/** object-fit → scaleMode. contain 류는 FIT, 나머지(cover·fill·none)는 FILL */
function objectFitScaleMode(fit: string | undefined): 'FILL' | 'FIT' {
  return fit === 'contain' || fit === 'scale-down' ? 'FIT' : 'FILL';
}

/**
 * background-image: url(...) 레이어 → 이미지 fill.
 * cover → FILL, contain → FIT, 반복되는 원본 크기/px 크기 → TILE, 그 외(100% 100% 등) → FILL
 */
function backgroundImagePaint(layer: string, size: string, repeat: string, filter?: string): ImagePaint | null {
  const paint = backgroundImagePaintBase(layer, size, repeat);
  const filters = imageFilters(filter);
  return paint && filters ? { ...paint, filters } : paint;
}

function backgroundImagePaintBase(layer: string, size: string, repeat: string): ImagePaint | null {
  const m = layer.trim().match(/^url\(\s*["']?([^"')]+)["']?\s*\)$/);
  if (!m) return null;
  const hash = imageHash(m[1]);
  if (!hash) return null;
  const sz = (size || 'auto').trim();
  if (sz === 'cover') return { type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' };
  if (sz === 'contain') return { type: 'IMAGE', imageHash: hash, scaleMode: 'FIT' };
  const tiles = !/^no-repeat/.test((repeat || 'repeat').trim());
  if (tiles) {
    const asset = imageAssets[m[1]];
    const px = sz.match(/^([\d.]+)px/);
    const factor = px && asset?.width ? parseFloat(px[1]) / asset.width : 1;
    if (px || /^auto/.test(sz)) return { type: 'IMAGE', imageHash: hash, scaleMode: 'TILE', scalingFactor: factor };
  }
  return { type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' };
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

/**
 * 면마다 색이 다른 테두리(왼쪽 강조선 등) → 면별 사각형.
 * Figma 는 한 노드에 테두리 색을 하나만 둘 수 있으므로, 모서리가 각진 박스는 면마다 자기 색의 사각형을 깐다
 * (위·아래를 먼저, 좌·우를 위에). 둥근 모서리는 사각형이 곡선을 따를 수 없어 가장 두꺼운 면 색의 테두리로 둔다.
 */
function applySideBorders(frame: FrameNode, s: DomStyleData): boolean {
  const sides = [
    { name: 'border-top', w: s.borderTopWidth, color: s.borderTopColor },
    { name: 'border-bottom', w: s.borderBottomWidth, color: s.borderBottomColor },
    { name: 'border-left', w: s.borderLeftWidth, color: s.borderLeftColor },
    { name: 'border-right', w: s.borderRightWidth, color: s.borderRightColor },
  ].filter((side) => side.w > 0 && side.color && !isTransparent(side.color));
  const colors = new Set(sides.map((side) => side.color));
  const square = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius]
    .every((r) => !r);
  if (colors.size < 2 || !square || s.borderStyle !== 'solid') return false;

  const W = frame.width;
  const H = frame.height;
  sides.forEach((side, i) => {
    const r = figma.createRectangle();
    r.name = side.name;
    const paint = toSolidPaint(side.color);
    r.fills = paint ? [paint] : [];
    if (side.name === 'border-top') { r.resize(W, side.w); r.x = 0; r.y = 0; }
    if (side.name === 'border-bottom') { r.resize(W, side.w); r.x = 0; r.y = H - side.w; }
    if (side.name === 'border-left') { r.resize(side.w, H); r.x = 0; r.y = 0; }
    if (side.name === 'border-right') { r.resize(side.w, H); r.x = W - side.w; r.y = 0; }
    frame.insertChild(i, r);
  });
  return true;
}

function applyStrokes(frame: FrameNode, s: DomStyleData): void {
  const maxW = Math.max(s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth);
  if (maxW <= 0 || s.borderStyle === 'none' || isTransparent(s.borderColor)) return;
  if (applySideBorders(frame, s)) return;
  const paint = toSolidPaint(s.borderColor);
  if (!paint) return;
  frame.strokes = [paint];
  // border-collapse 표: 이웃 칸과 공유하는 선이 격자선 가운데에 한 번 그려지고 칸 상자는 선의 절반씩을 포함한다
  // → 가운데 정렬이면 겹치는 두 칸의 선이 한 줄로 보인다 (INSIDE 면 두 겹으로 두꺼워진다)
  const collapsed = s.borderCollapse === 'collapse' && /^table(-cell)?$/.test(s.display);
  frame.strokeAlign = collapsed ? 'CENTER' : 'INSIDE';

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
  const extra = filterEffects(s);
  if (shadows.length === 0 && extra.length === 0) return;

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
  effects.push(...extra);
  if (effects.length > 0) node.effects = effects;
}

/**
 * filter / backdrop-filter → Figma 효과.
 * Figma blur 반경은 CSS blur() 의 2배로 계산된다 (Figma Dev Mode 도 CSS 로 내보낼 때 2로 나눈다).
 * drop-shadow() 는 드롭 섀도, 그 외 색 보정 필터(brightness 등)는 Figma 에 대응하는 효과가 없어 넘어간다.
 */
function filterEffects(s: DomStyleData): Effect[] {
  const out: Effect[] = [];
  const blurOf = (css: string | undefined) => {
    const m = (css || '').match(/blur\(\s*([\d.]+)px\s*\)/);
    return m ? parseFloat(m[1]) : 0;
  };
  const layer = blurOf(s.filter);
  if (layer > 0) out.push({ type: 'LAYER_BLUR', blurType: 'NORMAL', radius: layer * 2, visible: true });
  const backdrop = blurOf(s.backdropFilter);
  if (backdrop > 0) out.push({ type: 'BACKGROUND_BLUR', blurType: 'NORMAL', radius: backdrop * 2, visible: true });
  for (const m of (s.filter || '').matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)) {
    for (const sh of parseShadows(m[1])) {
      out.push({
        type: 'DROP_SHADOW', color: { ...sh.color.rgb, a: sh.color.a }, offset: { x: sh.x, y: sh.y },
        radius: Math.max(0, sh.blur), visible: true, blendMode: 'NORMAL', showShadowBehindNode: true,
      });
    }
  }
  return out;
}

const BLEND_MODES: Record<string, BlendMode> = {
  multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', darken: 'DARKEN', lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE', saturation: 'SATURATION', color: 'COLOR',
  luminosity: 'LUMINOSITY', 'plus-lighter': 'LINEAR_DODGE',
};

/** mix-blend-mode → Figma 레이어 블렌드 모드 */
function applyBlendMode(node: SceneNode & MinimalBlendMixin, s: DomStyleData): void {
  const mode = BLEND_MODES[s.mixBlendMode];
  if (mode) node.blendMode = mode;
}

function applyFrameStyle(frame: FrameNode, s: DomStyleData, w: number, h: number): void {
  frame.fills = backgroundPaints(s, w, h);

  applyCornerRadius(frame, s);
  if (s.opacity < 1) frame.opacity = s.opacity;
  applyBlendMode(frame, s);
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

function toTextCase(textTransform: string | undefined, fontVariantCaps?: string): TextCase {
  switch (textTransform) {
    case 'uppercase': return 'UPPER';
    case 'lowercase': return 'LOWER';
    case 'capitalize': return 'TITLE';
  }
  if (fontVariantCaps === 'small-caps') return 'SMALL_CAPS';
  if (fontVariantCaps === 'all-small-caps') return 'SMALL_CAPS_FORCED';
  return 'ORIGINAL';
}

function toTextDecoration(decoration: string | undefined): TextDecoration {
  if (decoration?.includes('underline')) return 'UNDERLINE';
  if (decoration?.includes('line-through')) return 'STRIKETHROUGH';
  return 'NONE';
}

function toDecorationStyle(v: string | undefined): TextDecorationStyle | null {
  if (v === 'wavy') return 'WAVY';
  if (v === 'dotted' || v === 'dashed') return 'DOTTED';
  return null; // solid·double 은 기본 모양
}

/** text-decoration-thickness / text-underline-offset 의 px 값 (auto·from-font 는 null) */
function toDecorationLength(v: string | undefined): { value: number; unit: 'PIXELS' } | null {
  const m = (v || '').match(/^(-?[\d.]+)px$/);
  return m ? { value: parseFloat(m[1]), unit: 'PIXELS' } : null;
}

/** 글자색과 다른 밑줄 색만 따로 지정한다 (같으면 Figma 기본 AUTO = 글자색) */
function toDecorationColor(color: string | undefined, textColor: string): TextDecorationColor | null {
  if (!color || color === textColor) return null;
  const paint = toSolidPaint(color);
  return paint ? { value: paint } : null;
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
    // 밑줄 세부 속성은 밑줄·취소선이 있는 구간에만 둘 수 있다
    if (toTextDecoration(seg.textDecoration ?? style.textDecoration) !== 'NONE') {
      const ds = toDecorationStyle(seg.textDecorationStyle);
      if (ds) t.setRangeTextDecorationStyle(start, end, ds);
      const th = toDecorationLength(seg.textDecorationThickness);
      if (th) t.setRangeTextDecorationThickness(start, end, th);
      const off = toDecorationLength(seg.textUnderlineOffset);
      if (off) t.setRangeTextDecorationOffset(start, end, off);
      const dc = toDecorationColor(seg.textDecorationColor, seg.color ?? style.color);
      if (dc) t.setRangeTextDecorationColor(start, end, dc);
    }
    if (seg.textTransform || seg.fontVariantCaps) {
      t.setRangeTextCase(start, end, toTextCase(seg.textTransform ?? style.textTransform, seg.fontVariantCaps ?? style.fontVariantCaps));
    }
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
 * @param layerEffects false 면 filter·블렌드 모드를 넣지 않는다 (배경 박스 프레임이 이미 가진 경우)
 */
async function createTextNode(node: DomNodeData, ox: number, oy: number, layerEffects = true): Promise<TextNode> {
  const { style, rect } = node;
  const fontName = await resolveFont(style.fontFamily, style.fontWeight, style.fontStyle, node.text ?? '');

  const t = figma.createText();
  t.fontName = fontName;
  t.fontSize = Math.max(style.fontSize, 1);
  t.characters = node.text ?? '';
  const textPaint = toSolidPaint(style.color);
  t.fills = textPaint ? [textPaint] : [];
  const lh = parseFloat(style.lineHeight);
  if (!isNaN(lh) && lh > 0 && style.lineHeight !== 'normal') t.lineHeight = { value: lh, unit: 'PIXELS' };
  const ls = toLetterSpacing(style.letterSpacing);
  if (ls) t.letterSpacing = ls;
  const decoration = toTextDecoration(style.textDecoration);
  if (decoration !== 'NONE') {
    t.textDecoration = decoration;
    const ds = toDecorationStyle(style.textDecorationStyle);
    if (ds) t.textDecorationStyle = ds;
    const th = toDecorationLength(style.textDecorationThickness);
    if (th) t.textDecorationThickness = th;
    const off = decoration === 'UNDERLINE' ? toDecorationLength(style.textUnderlineOffset) : null;
    if (off) t.textDecorationOffset = off;
    const dc = toDecorationColor(style.textDecorationColor, style.color);
    if (dc) t.textDecorationColor = dc;
  }
  // -webkit-text-stroke → 글자 외곽선 (CSS 처럼 윤곽선 가운데에 그린다)
  if (style.textStrokeWidth > 0) {
    const strokePaint = toSolidPaint(style.textStrokeColor);
    if (strokePaint) {
      t.strokes = [strokePaint];
      t.strokeWeight = style.textStrokeWidth;
      t.strokeAlign = 'CENTER';
    }
  }
  const textCase = toTextCase(style.textTransform, style.fontVariantCaps);
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

  // background-clip:text 그라디언트 글자 → 텍스트 fill 을 그라디언트로
  if (style.textFillImage && !textPaint) {
    const paints = backgroundPaints({ ...style, backgroundColor: 'transparent', backgroundImage: style.textFillImage },
      t.width, t.height);
    if (paints.length) t.fills = paints;
  }
  const effects: Effect[] = parseShadows(style.textShadow).map((sh) => ({
    type: 'DROP_SHADOW', color: { ...sh.color.rgb, a: sh.color.a }, offset: { x: sh.x, y: sh.y },
    radius: Math.max(0, sh.blur), visible: true, blendMode: 'NORMAL', showShadowBehindNode: true,
  }));
  if (layerEffects) effects.push(...filterEffects(style));
  if (effects.length) t.effects = effects;
  if (layerEffects) applyBlendMode(t, style);
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

// ─── Auto Layout (옵션) ───────────────────────────────────────

let importOptions: ImportOptions = {};

interface BuiltChild {
  data: DomNodeData;
  scene: SceneNode;
}

const AUTO_LAYOUT_TOLERANCE = 1.5;

/**
 * flex 컨테이너 → Auto Layout.
 * Figma 는 자식 크기·padding·gap·정렬로 위치를 다시 계산하므로, 그렇게 계산한 위치가
 * 브라우저 위치와 허용 오차 안에서 같은 컨테이너만 변환한다 (margin·flex-wrap·space-around 등은 그대로 둔다).
 * 절대위치 자식은 ABSOLUTE 로 제자리에 둔다.
 */
function tryAutoLayout(frame: FrameNode, node: DomNodeData, built: BuiltChild[]): boolean {
  const s = node.style;
  if (!/^(inline-)?flex$/.test(s.display) || (s.flexWrap && s.flexWrap !== 'nowrap')) return false;
  if (s.flexDirection !== 'row' && s.flexDirection !== 'column') return false;
  const horizontal = s.flexDirection === 'row';
  const isAbsolute = (d: DomNodeData) => d.style.position === 'absolute' || d.style.position === 'fixed';
  const flow = built.filter((b) => !isAbsolute(b.data));
  const absolute = built.filter((b) => isAbsolute(b.data));
  if (flow.length === 0 || flow.some((b) => b.data.transform)) return false;

  const pos = (n: SceneNode) => (horizontal ? n.x : n.y);
  const crossPos = (n: SceneNode) => (horizontal ? n.y : n.x);
  const size = (n: SceneNode) => (horizontal ? n.width : n.height);
  const crossSize = (n: SceneNode) => (horizontal ? n.height : n.width);
  flow.sort((a, b) => pos(a.scene) - pos(b.scene));

  const pad = {
    left: s.borderLeftWidth + s.paddingLeft,
    right: s.borderRightWidth + s.paddingRight,
    top: s.borderTopWidth + s.paddingTop,
    bottom: s.borderBottomWidth + s.paddingBottom,
  };
  const start = horizontal ? pad.left : pad.top;
  const inner = (horizontal ? frame.width : frame.height) - start - (horizontal ? pad.right : pad.bottom);
  const crossStart = horizontal ? pad.top : pad.left;
  const crossInner = (horizontal ? frame.height : frame.width) - crossStart - (horizontal ? pad.bottom : pad.right);
  const gap = horizontal ? s.columnGap : s.rowGap;
  const sum = flow.reduce((acc, b) => acc + size(b.scene), 0);
  const total = sum + gap * (flow.length - 1);

  let primary: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  let spacing = gap;
  let cursor = start;
  switch (s.justifyContent) {
    case 'normal': case 'flex-start': case 'start': case 'left':
      primary = 'MIN';
      break;
    case 'center':
      primary = 'CENTER';
      cursor = start + (inner - total) / 2;
      break;
    case 'flex-end': case 'end': case 'right':
      primary = 'MAX';
      cursor = start + inner - total;
      break;
    case 'space-between':
      primary = flow.length > 1 ? 'SPACE_BETWEEN' : 'MIN';
      if (flow.length > 1) spacing = (inner - sum) / (flow.length - 1);
      break;
    default:
      return false;
  }
  for (const b of flow) {
    if (Math.abs(pos(b.scene) - cursor) > AUTO_LAYOUT_TOLERANCE) return false;
    cursor += size(b.scene) + spacing;
  }

  let counter: 'MIN' | 'CENTER' | 'MAX';
  const stretched: SceneNode[] = [];
  switch (s.alignItems) {
    case 'flex-start': case 'start': case 'self-start': counter = 'MIN'; break;
    case 'center': counter = 'CENTER'; break;
    case 'flex-end': case 'end': case 'self-end': counter = 'MAX'; break;
    case 'normal': case 'stretch': counter = 'MIN'; break;
    default: return false;
  }
  for (const b of flow) {
    const c = crossSize(b.scene);
    const expected = counter === 'CENTER' ? crossStart + (crossInner - c) / 2
      : counter === 'MAX' ? crossStart + crossInner - c
        : crossStart;
    if (Math.abs(crossPos(b.scene) - expected) > AUTO_LAYOUT_TOLERANCE) return false;
    if ((s.alignItems === 'normal' || s.alignItems === 'stretch') && Math.abs(c - crossInner) <= AUTO_LAYOUT_TOLERANCE) {
      stretched.push(b.scene);
    }
  }

  // 데이터에 없는 장식 레이어(면별 테두리 사각형)도 배치에 끼지 않게 제자리에 둔다
  const extras = frame.children.filter((c) => !built.some((b) => b.scene === c));
  const absolutePositions = [...absolute.map((b) => b.scene), ...extras]
    .map((n) => ({ n: n as FrameNode, x: n.x, y: n.y }));
  frame.layoutMode = horizontal ? 'HORIZONTAL' : 'VERTICAL';
  frame.primaryAxisSizingMode = 'FIXED';
  frame.counterAxisSizingMode = 'FIXED';
  frame.paddingLeft = pad.left;
  frame.paddingRight = pad.right;
  frame.paddingTop = pad.top;
  frame.paddingBottom = pad.bottom;
  frame.itemSpacing = primary === 'SPACE_BETWEEN' ? 0 : gap;
  frame.primaryAxisAlignItems = primary;
  frame.counterAxisAlignItems = counter;
  for (const b of flow) frame.appendChild(b.scene);
  for (const { n, x, y } of absolutePositions) {
    if (!extras.includes(n)) frame.appendChild(n);
    n.layoutPositioning = 'ABSOLUTE';
    n.x = x;
    n.y = y;
  }
  for (const n of stretched) {
    if (horizontal) (n as FrameNode).layoutSizingVertical = 'FILL';
    else (n as FrameNode).layoutSizingHorizontal = 'FILL';
  }
  return true;
}

// ─── 재귀 노드 빌더 ───────────────────────────────────────────

let frameCount = 0;
let textCount = 0;
let failedCount = 0;
let firstError = '';
let builtCount = 0;
let totalCount = 0;

const PROGRESS_EVERY = 50;

function countNodes(node: DomNodeData): number {
  return 1 + node.children.reduce((acc, c) => acc + countNodes(c), 0);
}

/** 노드 하나를 처리할 때마다 호출: 일정 개수마다 진행률을 보내고 Figma 가 멈추지 않도록 양보한다 */
async function tickProgress(): Promise<void> {
  builtCount++;
  if (builtCount % PROGRESS_EVERY !== 0) return;
  figma.ui.postMessage({ type: 'import-progress', done: builtCount, total: totalCount } as MainToUIMessage);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 자식 하나를 만들고, 실패하면 나머지는 계속 만들되 실패 개수·첫 오류를 기록한다 */
async function buildChild(child: DomNodeData, parent: FrameNode): Promise<void> {
  try {
    await buildTree(child, parent);
  } catch (err: any) {
    failedCount++;
    if (!firstError) firstError = `<${child.tagName}> ${err?.message ?? String(err)}`;
    console.error('[html-importer] buildTree error:', err);
  }
}

async function buildTree(node: DomNodeData, parent: FrameNode): Promise<void> {
  await tickProgress();
  const { rect, style, tagName, text, children, visible, imageUrl } = node;
  const w = Math.max(rect.width, 0.01);
  const h = Math.max(rect.height, 0.01);

  // ── display:contents: 자기 레이어 없이 자식을 부모에 바로 배치 (자식 좌표는 이미 부모 기준) ──
  if (node.contents) {
    if (text) {
      parent.appendChild(await createTextNode(node, 0, 0));
      textCount++;
    }
    for (const child of children) await buildChild(child, parent);
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
      frame.name = node.name ?? tagName;
      frame.resize(w, h);
      frame.x = rect.x;
      frame.y = rect.y;
      applyFrameStyle(frame, style, w, h);
      frame.appendChild(await createTextNode(node, 0, 0, false));
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
      wrapper.name = node.name ?? tagName;
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
        svgFrame.name = node.name ?? 'svg-icon';
        svgFrame.fills = [];          // 배경 투명
        // SVG HTML에 이미 정확한 픽셀 width/height가 주입되어 있으므로
        // resize는 실질적 no-op이지만, 부모 좌표계 정합성을 위해 수행
        if (Math.abs(svgFrame.width - w) > 1 || Math.abs(svgFrame.height - h) > 1) {
          svgFrame.resize(w, h);
        }
        svgFrame.x = rect.x;
        svgFrame.y = rect.y;
        if (style.opacity < 1) svgFrame.opacity = style.opacity;
        const svgEffects = filterEffects(style);
        if (svgEffects.length) svgFrame.effects = svgEffects;
        applyBlendMode(svgFrame, style);
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

  // ── 이미지 (<img>, <canvas>, <video poster>) — 받아오지 못했거나 임베드(<iframe> 등)면 회색 자리표시 ──
  if (['img', 'canvas', 'video', 'iframe', 'embed', 'object'].includes(tagName)) {
    const imgRect = figma.createRectangle();
    const hash = imageHash(imageUrl);
    imgRect.name = hash ? node.name ?? tagName : `${node.name ?? tagName} (placeholder)`;
    imgRect.resize(w, h);
    const filters = imageFilters(style.filter);
    imgRect.fills = hash
      ? [{ type: 'IMAGE', imageHash: hash, scaleMode: objectFitScaleMode(style.objectFit), ...(filters ? { filters } : {}) }]
      : [{ type: 'SOLID', color: { r: 0.88, g: 0.9, b: 0.92 } }];
    applyCornerRadius(imgRect, style);
    applyEffects(imgRect, style);
    applyBlendMode(imgRect, style);
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

  // 자식 재귀 처리 (Auto Layout 검증을 위해 자식 데이터 ↔ 만든 레이어를 짝지어 둔다)
  const built: BuiltChild[] = [];
  for (const child of children) {
    const before = frame.children.length;
    await buildChild(child, frame);
    if (frame.children.length === before + 1) built.push({ data: child, scene: frame.children[before] });
  }
  if (importOptions.autoLayout && !node.collapsed && built.length === children.length) {
    tryAutoLayout(frame, node, built);
  }

  if (!node.collapsed) applyEffects(frame, style);
  applyRotation(frame, node);
  if (!visible) frame.visible = false;
  parent.appendChild(frame);
  frame.name = node.name ?? tagName;

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

/** 루트 프레임 하나 생성 (위치는 호출한 쪽에서 정한다) */
async function buildRoot(page: ImportPage, target: BaseNode & ChildrenMixin, multi: boolean): Promise<FrameNode> {
  const data = page.data;
  const rootFrame = figma.createFrame();
  const baseName = page.title?.trim() || data.name || 'HTML Import';
  rootFrame.name = multi ? `${baseName} · ${page.width}` : baseName;
  rootFrame.resize(Math.max(data.rect.width, 1), Math.max(data.rect.height, 1));
  target.appendChild(rootFrame);

  const isLeaf = (!!data.text && data.children.length === 0) ||
    ['svg', 'img', 'canvas', 'video'].includes(data.tagName);
  if (isLeaf) {
    // 버튼·아이콘처럼 요소 하나만 붙여넣은 경우: 루트 프레임 안에 요소 자신을 (0,0) 에 만든다
    rootFrame.fills = [];
    rootFrame.clipsContent = false;
    await buildChild({ ...data, rect: { ...data.rect, x: 0, y: 0 } }, rootFrame);
    return rootFrame;
  }

  applyFrameStyle(rootFrame, data.style, data.rect.width, data.rect.height);
  // 자식 노드 재귀 생성
  const built: BuiltChild[] = [];
  for (const child of data.children) {
    const before = rootFrame.children.length;
    await buildChild(child, rootFrame);
    if (rootFrame.children.length === before + 1) built.push({ data: child, scene: rootFrame.children[before] });
  }
  if (importOptions.autoLayout && built.length === data.children.length) tryAutoLayout(rootFrame, data, built);
  // 페이지 밖으로 넘친 자식(절대위치 요소 등)까지 루트가 감싸도록 늘린다 (루트가 자르지 않을 때만)
  if (!rootFrame.clipsContent) {
    const { right, bottom } = contentExtent(rootFrame);
    if (right > rootFrame.width || bottom > rootFrame.height) {
      rootFrame.resizeWithoutConstraints(Math.max(right, rootFrame.width), Math.max(bottom, rootFrame.height));
    }
  }
  applyEffects(rootFrame, data.style);
  return rootFrame;
}

/** "선택한 프레임 안에 넣기" 가 켜져 있고 프레임류가 선택돼 있으면 그 안, 아니면 현재 페이지 */
function resolveTarget(): BaseNode & ChildrenMixin {
  const selected = figma.currentPage.selection[0];
  if (importOptions.intoSelection && selected &&
    (selected.type === 'FRAME' || selected.type === 'COMPONENT' || selected.type === 'SECTION')) {
    return selected;
  }
  return figma.currentPage;
}

const SETTINGS_KEY = 'settings';
const ROOT_GAP = 80;

figma.ui.onmessage = async function (msg: UIToMainMessage) {
  if (msg.type === 'load-settings') {
    const settings = await figma.clientStorage.getAsync(SETTINGS_KEY).catch(() => null);
    figma.ui.postMessage({ type: 'settings', settings: settings ?? null } as MainToUIMessage);
    return;
  }
  if (msg.type === 'save-settings') {
    await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings).catch(() => undefined);
    return;
  }
  if (msg.type !== 'import-dom') return;

  frameCount = 0;
  textCount = 0;
  failedCount = 0;
  firstError = '';
  builtCount = 0;
  totalCount = msg.pages.reduce((acc, p) => acc + countNodes(p.data), 0);
  imageHashes.clear();
  importOptions = msg.options ?? {};

  try {
    const target = resolveTarget();
    const multi = msg.pages.length > 1;
    const roots: FrameNode[] = [];
    for (const page of msg.pages) {
      imageAssets = page.images ?? {};
      const root = await buildRoot(page, target, multi);
      // 페이지에 넣을 때는 뷰포트 중앙, 선택한 프레임 안이면 왼쪽 위부터. 여러 폭은 오른쪽으로 나란히
      const prev = roots[roots.length - 1];
      if (prev) {
        root.x = prev.x + prev.width + ROOT_GAP;
        root.y = prev.y;
      } else if (target.type === 'PAGE') {
        root.x = Math.round(figma.viewport.center.x - root.width / 2);
        root.y = Math.round(figma.viewport.center.y - root.height / 2);
      } else {
        root.x = 0;
        root.y = 0;
      }
      roots.push(root);
    }

    // 선택 후 줌
    figma.currentPage.selection = roots;
    figma.viewport.scrollAndZoomIntoView(roots);

    figma.ui.postMessage({
      type: 'import-done',
      frameCount,
      textCount,
      failedCount,
      firstError: firstError || undefined,
    } as MainToUIMessage);
  } catch (err: any) {
    figma.ui.postMessage({
      type: 'import-error',
      error: err.message ?? String(err),
    } as MainToUIMessage);
  }
};
