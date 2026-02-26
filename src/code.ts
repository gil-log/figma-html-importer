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
  else if (w >= 300) style = 'Light';
  else if (w >= 200) style = 'ExtraLight';
  else if (w >= 100) style = 'Thin';
  return italic ? style + ' Italic' : style;
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

  candidates.push(
    { family, style: style.replace(' Italic', '') },
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

function parseBoxShadow(shadow: string): DropShadowEffect | null {
  if (!shadow || shadow === 'none') return null;
  // "0px 4px 16px 0px rgba(0,0,0,0.1)" 또는 "0px 2px 8px rgba(0,0,0,0.2)" 형태
  const m = shadow.match(
    /(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?\s+(rgba?\([^)]+\)|#[\da-fA-F]{3,8})/
  );
  if (!m) return null;
  const color = parseColor(m[5]);
  if (!color) return null;
  return {
    type: 'DROP_SHADOW',
    color: { ...color.rgb, a: color.a },
    offset: { x: parseFloat(m[1]), y: parseFloat(m[2]) },
    radius: parseFloat(m[3]),
    spread: parseFloat(m[4] || '0'),
    visible: true,
    blendMode: 'NORMAL',
  };
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
 * CSS linear-gradient() → Figma GradientPaint
 * 예: "linear-gradient(49.89deg, #ea27c2 0%, #e100a3 100%)"
 */
function parseLinearGradient(css: string): GradientPaint | null {
  const m = css.match(/^linear-gradient\(([\s\S]+)\)$/i);
  if (!m) return null;

  const parts = splitTopLevelCommas(m[1]);
  if (parts.length < 2) return null;

  // 각도 파싱 (deg / "to top" 등)
  let angleDeg = 180; // 기본: top → bottom
  let stopStart = 0;
  const angleStr = parts[0].trim();
  if (/deg$/i.test(angleStr)) {
    angleDeg = parseFloat(angleStr);
    stopStart = 1;
  } else if (/^to\s/i.test(angleStr)) {
    const dir = angleStr.toLowerCase();
    if (dir === 'to top') angleDeg = 0;
    else if (dir === 'to right') angleDeg = 90;
    else if (dir === 'to bottom') angleDeg = 180;
    else if (dir === 'to left') angleDeg = 270;
    else if (dir === 'to top right') angleDeg = 45;
    else if (dir === 'to bottom right') angleDeg = 135;
    else if (dir === 'to bottom left') angleDeg = 225;
    else if (dir === 'to top left') angleDeg = 315;
    stopStart = 1;
  }

  // CSS 각도: 0deg = top(bottom→top), 90deg = right(left→right), 180deg = bottom
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  // 시작점(0% stop): (0.5 - 0.5*sinθ, 0.5 + 0.5*cosθ)
  // 끝점(100% stop): (0.5 + 0.5*sinθ, 0.5 - 0.5*cosθ)
  // Figma gradientTransform: [[a, b, tx], [c, d, ty]]
  //   transform([0,0]) = start, transform([1,0]) = end
  //   a = sinθ, c = -cosθ, tx = start.x, ty = start.y
  const gradientTransform: Transform = [
    [sinA,  cosA,  0.5 * (1 - sinA)],
    [-cosA, sinA,  0.5 * (1 + cosA)],
  ];

  // 컬러 스톱 파싱
  const stopParts = parts.slice(stopStart);
  const gradientStops: ColorStop[] = [];

  for (let i = 0; i < stopParts.length; i++) {
    const part = stopParts[i].trim();
    // 색상과 위치 분리: "rgba(0,0,0,0.5) 30%" or "#fff 0%"
    const posMatch = part.match(/(.+?)\s+([\d.]+)%\s*$/);
    let colorStr: string;
    let position: number;
    if (posMatch) {
      colorStr = posMatch[1].trim();
      position = parseFloat(posMatch[2]) / 100;
    } else {
      colorStr = part;
      position = i / Math.max(stopParts.length - 1, 1);
    }

    const parsed = parseColor(colorStr) ?? parseHexColor(colorStr);
    if (!parsed) continue;
    gradientStops.push({
      position,
      color: { ...parsed.rgb, a: parsed.a },
    });
  }

  if (gradientStops.length < 2) return null;

  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform,
    gradientStops,
    opacity: 1,
  };
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

function applyEffects(frame: FrameNode, s: DomStyleData): void {
  const shadow = parseBoxShadow(s.boxShadow);
  if (shadow) frame.effects = [shadow];
}

function applyFrameStyle(frame: FrameNode, s: DomStyleData): void {
  // backgroundImage(gradient)가 있으면 우선 적용, 없으면 backgroundColor
  let fills: Paint[] = [];
  if (s.backgroundImage && s.backgroundImage !== 'none' && s.backgroundImage !== '') {
    const grad = parseLinearGradient(s.backgroundImage);
    if (grad) {
      fills = [grad];
    } else {
      const solid = toSolidPaint(s.backgroundColor);
      if (solid) fills = [solid];
    }
  } else {
    const solid = toSolidPaint(s.backgroundColor);
    if (solid) fills = [solid];
  }
  frame.fills = fills;

  applyCornerRadius(frame, s);
  if (s.opacity < 1) frame.opacity = s.opacity;
  applyStrokes(frame, s);
  applyEffects(frame, s);
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
      applyFrameStyle(frame, style);

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
    if (isSingleLine) {
      // 한 줄 텍스트: WIDTH_AND_HEIGHT → 줄바꿈 방지
      const t = makeText(rect.x, rect.y, 0);
      await applyBoldSegments(t);
      if (!visible) t.visible = false;
      parent.appendChild(t);
      textCount++;
      return;
    }

    const isBlockDisplay = /^(block|flex|grid|list-item|table)/.test(style.display);
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

  applyFrameStyle(frame, style);

  // 자식 재귀 처리
  for (const child of children) {
    try {
      await buildTree(child, frame);
    } catch (err) {
      console.error('[html-importer] buildTree error:', err);
    }
  }

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
    applyFrameStyle(rootFrame, data.style);

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
