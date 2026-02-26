/**
 * domSerializer.ts — 브라우저(플러그인 UI) 컨텍스트에서 실행
 *
 * 렌더링된 DOM을 순회하며 getBoundingClientRect + getComputedStyle로
 * 실제 레이아웃과 스타일을 추출해 DomNodeData 트리를 만든다.
 * code.ts(Figma 샌드박스)로는 DOM API가 없으므로 이쪽에서만 실행된다.
 */
import type { DomNodeData, DomStyleData, TextSegment } from './types';

const SKIP_TAGS = new Set([
  'script', 'style', 'meta', 'link', 'head', 'noscript',
  'br', 'template', 'canvas', 'video', 'audio',
  // hr은 제거 — 구분선으로 직접 렌더링
]);

// 인라인 텍스트 레벨 태그: 자식이 모두 이 태그면 textContent로 병합
const INLINE_TEXT_TAGS = new Set([
  'strong', 'em', 'b', 'i', 'a', 'span', 'small', 'mark',
  'sub', 'sup', 'abbr', 'cite', 'code', 'kbd', 'label',
  'time', 'u', 's', 'del', 'ins',
]);

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
    const pcs = window.getComputedStyle(el, pseudo);
    const content = pcs.content;
    if (!content || content === 'none' || content === 'normal') return null;
    if (pcs.display === 'none') return null;

    const w = pf(pcs.width);
    const h = pf(pcs.height);
    if (w < 1 || h < 1) return null;

    let x = 0;
    let y = 0;
    if (pcs.position === 'absolute' || pcs.position === 'fixed') {
      const elCs = window.getComputedStyle(el);
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
    backgroundImage: cs.backgroundImage || '',
    color: normalizeCssColor(cs.color),
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
  // position:fixed 요소 처리:
  // viewport 기준 좌표라 부모 기준 위치가 어긋나므로
  // 일시적으로 absolute로 변경하여 부모 기준 좌표를 얻는다.
  // (모바일 UI의 fixed 하단 바 등을 올바르게 포함하기 위해)
  let fixedConverted = false;
  if (!isRoot && cs.position === 'fixed') {
    const htmlEl = el as HTMLElement;
    htmlEl.style.position = 'absolute';
    fixedConverted = true;
  }

  const rect = el.getBoundingClientRect();
  // 크기가 0이면 렌더링 안 된 요소
  if (rect.width < 1 || rect.height < 1) {
    if (fixedConverted) (el as HTMLElement).style.position = 'fixed';
    return null;
  }

  // SVG: outerHTML을 직렬화하여 Figma에서 createNodeFromSvg로 재현
  if (tag === 'svg') {
    if (fixedConverted) (el as HTMLElement).style.position = 'fixed';
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

  // ── 혼합 콘텐츠 감지 ──────────────────────────────
  // 텍스트 노드 + 엘리먼트 자식이 공존하는 경우 처리
  const hasSignificantTextNodes = Array.from(el.childNodes).some(
    (n) => n.nodeType === Node.TEXT_NODE && (n.textContent?.trim() ?? '').length > 0
  );

  // <br> 존재 여부: 있으면 텍스트 병합 대신 childNodes 순회로 줄바꿈 보존
  const hasBr = Array.from(el.children).some(
    (c) => c.tagName.toLowerCase() === 'br'
  );

  let text: string | undefined;
  let textSegments: TextSegment[] | undefined;

  if (elementChildren.length === 0 && !hasBr) {
    // 자식 element 없음, <br>도 없음 → 텍스트 리프
    const t = el.textContent?.trim();
    if (t) text = t;
  } else if (hasSignificantTextNodes) {
    // 혼합 콘텐츠: 텍스트 노드 + 엘리먼트 자식 공존
    const allInline = elementChildren.every(
      (c) => INLINE_TEXT_TAGS.has(c.tagName.toLowerCase())
    );
    if (allInline && !hasBr) {
      // <p>텍스트<strong>볼드</strong>텍스트</p> 같은 패턴 (br 없음)
      // → 전체 textContent를 하나의 텍스트 리프로 병합 + bold 세그먼트 추출
      const t = el.textContent?.trim();
      if (t) {
        text = t;
        textSegments = extractTextSegments(el);
      }
    }
    // allInline이 아닌 경우 또는 <br> 포함: 아래에서 childNodes 순회로 처리
  }

  // Form 요소: placeholder/value를 텍스트로 추출
  // <input>, <textarea>는 textContent가 빈 문자열이므로 별도 처리
  let isPlaceholder = false;
  if (!text && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
    const inputEl = el as HTMLInputElement;
    const val = inputEl.value?.trim();
    const ph = el.getAttribute('placeholder')?.trim();
    if (val) {
      text = val;
    } else if (ph) {
      text = ph;
      isPlaceholder = true;
    }
  }

  let imageUrl: string | undefined;
  if (tag === 'img') {
    imageUrl = (el as HTMLImageElement).src || undefined;
  }

  // 재귀: 자식 직렬화 (현재 element rect를 parentRect로 사용)
  const children: DomNodeData[] = [];
  if (!text) {
    if (hasSignificantTextNodes && (elementChildren.length > 0 || hasBr)) {
      // 혼합 콘텐츠 또는 <br> 포함 → childNodes 순회 (줄바꿈·색상 보존)
      for (const childNode of Array.from(el.childNodes)) {
        if (childNode.nodeType === Node.TEXT_NODE) {
          const trimmed = childNode.textContent?.trim();
          if (!trimmed) continue;
          // Range API로 텍스트 노드의 정확한 위치/크기 측정
          const range = document.createRange();
          range.selectNodeContents(childNode);
          const textRect = range.getBoundingClientRect();
          if (textRect.width < 1 || textRect.height < 1) continue;
          // 부모 스타일 상속하되 배경/테두리 제거 (부모 프레임이 이미 처리)
          const textStyle: DomStyleData = {
            ...extractStyle(cs),
            backgroundColor: 'transparent',
            backgroundImage: '',
            borderTopWidth: 0,
            borderRightWidth: 0,
            borderBottomWidth: 0,
            borderLeftWidth: 0,
            borderColor: 'transparent',
            borderStyle: 'none',
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 0,
            paddingLeft: 0,
          };
          children.push({
            tagName: '#text',
            text: trimmed,
            rect: {
              x: Math.round(textRect.left - rect.left),
              y: Math.round(textRect.top - rect.top),
              width: Math.round(textRect.width),
              height: Math.round(textRect.height),
            },
            visible: true,
            style: textStyle,
            children: [],
          });
        } else if (childNode.nodeType === Node.ELEMENT_NODE) {
          const childEl = childNode as Element;
          if (!SKIP_TAGS.has(childEl.tagName.toLowerCase())) {
            const childData = serializeDom(childEl, rect);
            if (childData) children.push(childData);
          }
        }
      }
    } else {
      for (const child of elementChildren) {
        const childData = serializeDom(child, rect);
        if (childData) children.push(childData);
      }
    }
  }

  // ::before / ::after 의사 요소 추출
  const pseudoBefore = extractPseudoElement(el, '::before');
  if (pseudoBefore) children.unshift(pseudoBefore);
  const pseudoAfter = extractPseudoElement(el, '::after');
  if (pseudoAfter) children.push(pseudoAfter);

  // 텍스트와 의사 요소(또는 다른 자식)가 공존하면
  // 텍스트를 명시적 #text 자식 노드로 변환 (buildTree에서 text+children 동시 처리 불가)
  if (text && children.length > 0) {
    const pl = pf(cs.paddingLeft);
    const pt = pf(cs.paddingTop);
    const textStyle: DomStyleData = {
      ...extractStyle(cs),
      backgroundColor: 'transparent',
      backgroundImage: '',
      borderTopWidth: 0, borderRightWidth: 0,
      borderBottomWidth: 0, borderLeftWidth: 0,
      borderColor: 'transparent', borderStyle: 'none',
      paddingTop: 0, paddingRight: 0,
      paddingBottom: 0, paddingLeft: 0,
    };
    children.push({
      tagName: '#text',
      text,
      textSegments,
      rect: {
        x: Math.round(pl),
        y: Math.round(pt),
        width: Math.round(rect.width - pl - pf(cs.paddingRight)),
        height: Math.round(rect.height - pt - pf(cs.paddingBottom)),
      },
      visible: true,
      style: textStyle,
      children: [],
    });
    text = undefined;
    textSegments = undefined;
  }

  // 스타일: placeholder 텍스트면 ::placeholder 색상 사용
  const nodeStyle = extractStyle(cs);
  if (isPlaceholder) {
    try {
      const phCs = window.getComputedStyle(el, '::placeholder');
      const phColor = normalizeCssColor(phCs.color);
      if (phColor && phColor !== 'transparent') nodeStyle.color = phColor;
    } catch { /* ::placeholder not supported */ }
  }

  // fixed → absolute 변환을 했으면 원래대로 복원
  if (fixedConverted) (el as HTMLElement).style.position = 'fixed';

  return {
    tagName: tag,
    text,
    textSegments,
    imageUrl,
    rect: {
      x: Math.round(rect.left - parentRect.left),
      y: Math.round(rect.top - parentRect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    visible: cs.visibility !== 'hidden',
    style: nodeStyle,
    children,
  };
}

/**
 * 인라인 혼합 콘텐츠에서 텍스트 세그먼트 + bold 여부를 추출.
 * 예: <p>텍스트<strong>볼드</strong>나머지</p>
 *   → [{ text:"텍스트", bold:false }, { text:"볼드", bold:true }, { text:"나머지", bold:false }]
 */
function extractTextSegments(el: Element): TextSegment[] {
  const segments: TextSegment[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent || '';
      if (t) segments.push({ text: t });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const childEl = node as Element;
      const childCs = window.getComputedStyle(childEl);
      const isBold = parseInt(childCs.fontWeight) >= 700;
      const childText = childEl.textContent || '';
      if (childText) segments.push({ text: childText, bold: isBold || undefined });
    }
  }
  return segments;
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
