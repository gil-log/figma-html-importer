/**
 * render.ts — 붙여넣은 HTML 을 격리된 iframe 에서 렌더링
 *
 * 플러그인 UI 문서 안에 직접 넣으면 미디어쿼리·vw·vh 가 플러그인 창(400×580) 기준으로 계산되고,
 * 붙여넣은 스크립트·스타일이 플러그인 UI 를 오염시킨다. 렌더 폭×높이 크기의 srcdoc iframe 에서
 * 브라우저가 일반 페이지처럼 <head>·스크립트·스타일을 순서대로 처리하게 한다.
 */

import { waitForDesignRuntime } from './designExport';

export interface Viewport {
  width: number;
  height: number;
}

export interface RenderedDocument {
  win: Window;
  doc: Document;
  dispose(): void;
}

const LOAD_TIMEOUT_MS = 15000;

/** fragment 는 문서로 감싸고, 문서는 표준 모드로 렌더링되도록 doctype 을 보장한다 */
function toDocument(html: string): string {
  // 뷰포트 밖 lazy 이미지는 로드되지 않으므로 즉시 로드로 바꾼다
  let src = html.replace(/\bloading\s*=\s*(["'])lazy\1/gi, 'loading="eager"');
  if (!/<html[\s>]/i.test(src) && !/<body[\s>]/i.test(src)) {
    src = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${src}</body></html>`;
  } else if (!/^\s*<!doctype/i.test(src)) {
    src = `<!DOCTYPE html>${src}`;
  }
  return src;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, delay(ms)]);
}

/** DOM 변경(Tailwind Play CDN 의 스타일 생성, 스크립트의 DOM 조작 등)이 quietMs 동안 없을 때까지 대기 */
function waitForQuiet(doc: Document, win: Window, quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const finish = () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(max);
      resolve();
    };
    const observer = new (win as any).MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, quietMs);
    }) as MutationObserver;
    observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    quiet = setTimeout(finish, quietMs);
    const max = setTimeout(finish, maxMs);
  });
}

export async function renderHtml(html: string, viewport: Viewport): Promise<RenderedDocument> {
  const iframe = document.createElement('iframe');
  // 스크립트는 실행하되 alert·팝업·폼 전송·상위 창 이동은 막는다 (DOM 을 읽기 위해 same-origin 유지)
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.setAttribute('scrolling', 'no');
  iframe.style.cssText = [
    'position:fixed',
    `left:${-(viewport.width + 1000)}px`,
    'top:0',
    `width:${viewport.width}px`,
    `height:${viewport.height}px`,
    'border:0',
    'opacity:0',
    'pointer-events:none',
  ].join(';');

  const loaded = new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
  iframe.srcdoc = toDocument(html);
  document.body.appendChild(iframe);
  await withTimeout(loaded, LOAD_TIMEOUT_MS);

  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc || !doc.documentElement) {
    iframe.remove();
    throw new Error('HTML 렌더링용 문서를 만들지 못했습니다.');
  }

  // Claude 디자인 화면은 런타임이 #dc-root 에 그려 넣을 때까지 기다린다 (DOM 이 잠시 조용해도 아직 안 그려졌을 수 있다)
  await waitForDesignRuntime(doc, 10000);
  // 레이아웃을 한 번 강제해 웹폰트 로딩을 시작시킨 뒤 폰트·스크립트·Tailwind 처리를 기다린다
  void doc.documentElement.offsetHeight;
  await withTimeout(doc.fonts.ready, 3000);
  await waitForQuiet(doc, win, 120, 4000);
  await withTimeout(doc.fonts.ready, 3000);
  win.scrollTo(0, 0);

  return { win, doc, dispose: () => iframe.remove() };
}

// ─── 캡처 준비 ────────────────────────────────────────────────

/**
 * position:fixed 요소를 문서 기준 absolute 로 바꾼다.
 * 뷰포트 기준 좌표 대신 문서(=결과 프레임) 기준으로 배치되어 모바일 UI 의 하단 바가 결과 맨 아래에 붙는다.
 * 단 위아래를 모두 붙여 뷰포트를 채우던 요소(전체 화면 모달 오버레이, 사이드 드로어)는 바꾸면 페이지 전체 높이로
 * 늘어나므로, 바꾸기 전 뷰포트 기준 위치·높이로 고정해 첫 화면에 보이던 모습 그대로 둔다.
 * 렌더 iframe 은 캡처 후 버리므로 원래대로 되돌리지 않는다.
 */
export function prepareForCapture(doc: Document, win: Window): void {
  const html = doc.documentElement;
  const fixed: { el: HTMLElement; before: DOMRect }[] = [];
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('body *'))) {
    if (win.getComputedStyle(el).position === 'fixed') fixed.push({ el, before: el.getBoundingClientRect() });
  }
  if (fixed.length === 0) return;
  if (win.getComputedStyle(html).position === 'static') html.style.position = 'relative';
  for (const { el } of fixed) el.style.setProperty('position', 'absolute', 'important');
  for (const { el, before } of fixed) {
    const after = el.getBoundingClientRect();
    if (Math.abs(after.height - before.height) <= 1) continue;
    const top = parseFloat(win.getComputedStyle(el).top) || 0;
    el.style.setProperty('top', `${top + before.top - after.top}px`, 'important');
    el.style.setProperty('bottom', 'auto', 'important');
    el.style.setProperty('height', `${before.height}px`, 'important');
  }
}

const NON_CONTENT_TAGS = new Set([
  'style', 'script', 'meta', 'link', 'title', 'noscript', 'template', 'head', 'base',
]);

export interface CanvasBackground {
  backgroundColor: string;
  backgroundImage: string;
  /** 배경이 body 에서 캔버스로 전파된 경우 body 노드 자체의 배경은 지워야 한다 */
  fromBody: boolean;
}

function hasBackground(cs: CSSStyleDeclaration): boolean {
  const color = cs.backgroundColor;
  const clear = !color || color === 'transparent' || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(color);
  return !clear || (!!cs.backgroundImage && cs.backgroundImage !== 'none');
}

/**
 * CSS 캔버스 배경: html 에 배경이 없으면 body 배경이 페이지 전체(캔버스)로 전파된다.
 */
export function canvasBackground(doc: Document, win: Window): CanvasBackground | null {
  const htmlCs = win.getComputedStyle(doc.documentElement);
  if (hasBackground(htmlCs)) {
    return { backgroundColor: htmlCs.backgroundColor, backgroundImage: htmlCs.backgroundImage, fromBody: false };
  }
  if (doc.body) {
    const bodyCs = win.getComputedStyle(doc.body);
    if (hasBackground(bodyCs)) {
      return { backgroundColor: bodyCs.backgroundColor, backgroundImage: bodyCs.backgroundImage, fromBody: true };
    }
  }
  return null;
}

/**
 * 결과 프레임의 루트 결정.
 * - 페이지 배경이 없고 보이는 콘텐츠 요소가 하나 → 그 요소만 (버튼·카드 같은 조각을 딱 맞게 가져온다)
 * - 그 외(여러 요소, 또는 페이지 배경 있음) → 문서 전체(html)
 */
export function findRenderRoot(doc: Document, win: Window): { root: Element; page: boolean } {
  const body = doc.body;
  const contentEls = body
    ? Array.from(body.children).filter((el) => !NON_CONTENT_TAGS.has(el.tagName.toLowerCase()))
    : [];
  const visibleEls = contentEls.filter((el) => {
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (visibleEls.length === 1 && !canvasBackground(doc, win)) return { root: visibleEls[0], page: false };
  return { root: doc.documentElement, page: true };
}
