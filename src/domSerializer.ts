/**
 * domSerializer.ts — 브라우저(플러그인 UI) 컨텍스트에서 실행
 *
 * 렌더링된 DOM을 순회하며 getBoundingClientRect + getComputedStyle로
 * 실제 레이아웃과 스타일을 추출해 DomNodeData 트리를 만든다.
 * code.ts(Figma 샌드박스)로는 DOM API가 없으므로 이쪽에서만 실행된다.
 */
import type { DomNodeData, DomStyleData } from './types';

const SKIP_TAGS = new Set([
  'script', 'style', 'meta', 'link', 'head', 'noscript',
  'br', 'template', 'canvas', 'video', 'audio',
  // hr은 제거 — 구분선으로 직접 렌더링
]);

// position:fixed 요소는 viewport 기준이라 부모 rect 무시 → 스킵
const SKIP_POSITIONS = new Set(['fixed']);

function pf(val: string): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

/**
 * borderColor / borderStyle 단축 속성은 개별 면 값이 다를 때
 * "rgba(0,0,0,0) rgba(0,0,0,0) rgb(x,y,z) rgba(0,0,0,0)" 같은 4값 문자열로 반환된다.
 * → 파싱 실패를 막기 위해 개별 면에서 non-empty/non-none/non-transparent 값을 우선 추출.
 */
function effectiveBorderColor(cs: CSSStyleDeclaration): string {
  const sides = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
  for (const v of sides) {
    if (v && v !== 'transparent' && v !== 'rgba(0, 0, 0, 0)') return v;
  }
  return cs.borderColor;
}

function effectiveBorderStyle(cs: CSSStyleDeclaration): string {
  const sides = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  for (const v of sides) {
    if (v && v !== 'none') return v;
  }
  return cs.borderStyle;
}

function extractStyle(cs: CSSStyleDeclaration): DomStyleData {
  return {
    backgroundColor: cs.backgroundColor,
    backgroundImage: cs.backgroundImage || '',
    color: cs.color,
    fontSize: pf(cs.fontSize) || 14,
    fontWeight: cs.fontWeight,
    fontFamily: cs.fontFamily,
    fontStyle: cs.fontStyle,
    lineHeight: cs.lineHeight,
    textAlign: cs.textAlign,
    letterSpacing: cs.letterSpacing,
    textDecoration: cs.textDecoration,
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
    opacity: pf(cs.opacity) || 1,
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

/**
 * @param el 직렬화할 DOM 요소
 * @param parentRect 부모의 getBoundingClientRect (상대 좌표 계산용)
 * @param isRoot true이면 position:fixed 체크를 건너뜀
 *               (container 자체가 루트일 때 필요)
 */
export function serializeDom(el: Element, parentRect: DOMRect, isRoot = false): DomNodeData | null {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return null;

  const cs = window.getComputedStyle(el);
  if (cs.display === 'none') return null;
  if (cs.visibility === 'hidden') return null;
  // position:fixed 요소는 viewport 기준 좌표 → 부모 기준 위치가 어긋남
  // 단, 루트 요소(container)는 예외
  if (!isRoot && SKIP_POSITIONS.has(cs.position)) return null;

  const rect = el.getBoundingClientRect();
  // 크기가 0이면 렌더링 안 된 요소
  if (rect.width < 1 || rect.height < 1) return null;

  // SVG: outerHTML을 직렬화하여 Figma에서 createNodeFromSvg로 재현
  if (tag === 'svg') {
    return {
      tagName: 'svg',
      svgHtml: serializeSvg(el as SVGElement, cs),
      rect: {
        x: Math.round(rect.left - parentRect.left),
        y: Math.round(rect.top - parentRect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      visible: true,
      style: extractStyle(cs),
      children: [],
    };
  }

  // 자식 element 목록 (스킵 태그 제외)
  const elementChildren = Array.from(el.children).filter(
    (c) => !SKIP_TAGS.has(c.tagName.toLowerCase())
  );

  // 자식 element가 없고 텍스트 콘텐츠가 있으면 → 텍스트 리프
  let text: string | undefined;
  if (elementChildren.length === 0) {
    const t = el.textContent?.trim();
    if (t) text = t;
  }

  let imageUrl: string | undefined;
  if (tag === 'img') {
    imageUrl = (el as HTMLImageElement).src || undefined;
  }

  // 재귀: 자식 직렬화 (현재 element rect를 parentRect로 사용)
  const children: DomNodeData[] = [];
  if (!text) {
    for (const child of elementChildren) {
      const childData = serializeDom(child, rect);
      if (childData) children.push(childData);
    }
  }

  return {
    tagName: tag,
    text,
    imageUrl,
    rect: {
      x: Math.round(rect.left - parentRect.left),
      y: Math.round(rect.top - parentRect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    visible: cs.visibility !== 'hidden',
    style: extractStyle(cs),
    children,
  };
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
    const symbolEl = document.getElementById(href.slice(1));
    if (!symbolEl) continue;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
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
