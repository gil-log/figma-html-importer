import React, {useCallback, useEffect, useRef, useState} from 'react';
import {serializeDom} from '../domSerializer';
import type {DomNodeData, MainToUIMessage} from '../types';

const WIDTH_OPTIONS = [
  {label: '375px — Mobile', value: 375},
  {label: '768px — Tablet', value: 768},
  {label: '1440px — Desktop', value: 1440},
  {label: '1920px — Wide', value: 1920},
  {label: '2880px — Multi-screen', value: 2880},
  {label: '3840px — Extra Wide', value: 3840},
];

type Status = 'idle' | 'rendering' | 'parsing' | 'building' | 'done' | 'error';

const STATUS_LABEL: Record<Status, string> = {
  idle: '',
  rendering: 'HTML 렌더링 중...',
  parsing: 'DOM 스타일 분석 중...',
  building: 'Figma 노드 생성 중...',
  done: '',
  error: '',
};

export default function App() {
  const [html, setHtml] = useState('');
  const [renderWidth, setRenderWidth] = useState(1440);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<{ frameCount: number; textCount: number } | null>(null);
  const [error, setError] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Figma main thread 메시지 수신
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data?.pluginMessage as MainToUIMessage | undefined;
      if (!msg) return;
      if (msg.type === 'import-done') {
        setStatus('done');
        setResult({frameCount: msg.frameCount, textCount: msg.textCount});
      } else if (msg.type === 'import-error') {
        setStatus('error');
        setError(msg.error);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleImport = useCallback(async () => {
    if (!html.trim()) return;

    setStatus('rendering');
    setError('');
    setResult(null);

    // ── 1. Tailwind CDN 사용 감지 및 로딩 ──────────────────
    if (html.includes('cdn.tailwindcss.com') || html.includes('tailwindcss')) {
      await ensureTailwind();
    }

    // ── 1-a. 인라인 <script> 주입 (tailwind.config 등) ──────
    // CDN이 먼저 로드되어 window.tailwind가 생성된 후
    // tailwind.config = {...} 가 실행되어야 커스텀 색상이 동작한다.
    const injectedScripts = injectInlineScripts(html);

    // ── 1-b. <head> 내 <style> 태그를 document.head에 주입 ──
    // extractBodyContent는 <body> 내용만 가져오므로
    // <head>의 CSS가 날아가는 문제를 여기서 보완한다.
    const injectedStyle = injectHeadStyles(html);

    // ── 2. 렌더 컨테이너 생성 ──────────────────────────────
    const container = document.createElement('div');
    container.style.cssText = [
      'position:fixed',
      `left:${-(renderWidth + 500)}px`,
      'top:0',
      `width:${renderWidth}px`,
      'pointer-events:none',
      'z-index:-9999',
      'overflow:visible',
    ].join(';');

    // body 태그의 class/style 속성을 컨테이너에 그대로 적용
    // (Tailwind의 flex/gap 같은 레이아웃 클래스를 살리기 위해)
    applyBodyAttrsToContainer(html, container);

    container.innerHTML = extractBodyContent(html);
    document.body.appendChild(container);
    containerRef.current = container;

    // ── 3. 브라우저 레이아웃 + Tailwind 처리 대기 ────────────
    // Tailwind Play CDN은 MutationObserver → rAF 배치로 동작하므로 여러 frame 대기
    await waitFrames(4);

    try {
      // ── 4. 루트 엘리먼트 탐색 ────────────────────────────
      const root = findRenderRoot(container);

      setStatus('parsing');
      await waitFrames(1);

      const rootRect = root.getBoundingClientRect();
      // root가 container 자체인 경우 isRoot=true → position:fixed 체크 건너뜀
      const isRoot = root === container;
      const domData = serializeDom(root, rootRect, isRoot);
      if (!domData) throw new Error(
          `<${root.tagName.toLowerCase()}> 요소 크기가 0입니다.\n` +
          'Tailwind CDN이 로드되지 않았거나 콘텐츠가 없는 요소입니다.'
      );

      // ── 5. body/html 배경을 루트 노드에 적용 ─────────────
      // body { background: ... } CSS는 document.body에 적용되지만
      // 직렬화는 컨테이너 자식부터 시작하므로 body 배경이 누락된다.
      // CSS background는 상속되지 않으므로 명시적으로 복사해야 한다.
      // html 배경도 동일하게 처리 (body 배경 없으면 html 배경을 확인).
      applyDocumentBackground(domData);

      setStatus('building');
      parent.postMessage({pluginMessage: {type: 'import-dom', data: domData}}, '*');

    } catch (e: any) {
      setStatus('error');
      setError(e.message ?? String(e));
      if (containerRef.current) {
        document.body.removeChild(containerRef.current);
        containerRef.current = null;
      }
    } finally {
      // 주입했던 <style> 제거
      if (injectedStyle && document.head.contains(injectedStyle)) {
        document.head.removeChild(injectedStyle);
      }
      // 주입했던 <script> 제거
      for (const s of injectedScripts) {
        if (document.head.contains(s)) document.head.removeChild(s);
      }
      // 렌더 컨테이너 제거
      if (containerRef.current) {
        document.body.removeChild(containerRef.current);
        containerRef.current = null;
      }
    }
  }, [html, renderWidth, status]);

  const handleReset = () => {
    setStatus('idle');
    setResult(null);
    setError('');
    setHtml('');
  };

  const isImporting = status === 'rendering' || status === 'parsing' || status === 'building';
  const canImport = !isImporting && html.trim().length > 0;

  return (
      <div className="root">
        {/* 헤더 */}
        <div className="header">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2">
            <polyline points="16 18 22 12 16 6"/>
            <polyline points="8 6 2 12 8 18"/>
          </svg>
          <span className="header-title">HTML → Figma</span>
        </div>

        {/* 렌더 너비 선택 */}
        <div className="toolbar">
          <span className="label">렌더 너비</span>
          <select
              className="select"
              value={renderWidth}
              onChange={(e) => setRenderWidth(Number(e.target.value))}
              disabled={isImporting}
          >
            {WIDTH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* HTML 입력 */}
        <div className="textarea-wrap">
        <textarea
            className="textarea"
            placeholder={`전체 HTML 문서 또는 일부 fragment 모두 지원합니다.\n<style> 태그 포함 시 스타일도 적용됩니다.`}
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            disabled={isImporting}
            spellCheck={false}
        />
          {html && !isImporting && (
              <button className="clear-btn" onClick={handleReset} title="지우기">
                ✕
              </button>
          )}
        </div>

        {/* 진행 상태 */}
        {isImporting && (
            <div className="status-row">
              <div className="spinner"/>
              <span className="status-text">{STATUS_LABEL[status]}</span>
            </div>
        )}

        {/* 에러 */}
        {status === 'error' && (
            <div className="error-box">
              <strong>오류:</strong> {error}
            </div>
        )}

        {/* 완료 */}
        {status === 'done' && result && (
            <div className="success-box">
              <span>✓ 완료</span>
              <span className="result-detail">
            Frame {result.frameCount}개 · Text {result.textCount}개
          </span>
            </div>
        )}

        {/* 가져오기 버튼 */}
        <button
            className={`import-btn ${!canImport ? 'disabled' : ''}`}
            onClick={handleImport}
            disabled={!canImport}
        >
          {isImporting ? '가져오는 중...' : 'Figma에 가져오기'}
        </button>

        {/* 설명 */}
        <div className="hint">
          Chrome에서 렌더링한 것과 동일하게 Figma 레이어로 변환합니다.<br/>
          외부 폰트/이미지는 Inter 폰트 및 회색 placeholder로 대체됩니다.
        </div>
      </div>
  );
}

// ─── 헬퍼 함수 ────────────────────────────────────────────────

function waitFrames(n: number): Promise<void> {
  return new Promise<void>((res) => {
    let count = 0;
    const tick = () => {
      if (++count >= n) res(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Tailwind CDN을 플러그인 UI 문서에 한 번만 로드 */
async function ensureTailwind(): Promise<void> {
  if ((window as any).__twLoaded) return;
  if (document.querySelector('script[src*="tailwindcss"]')) {
    // 이미 로딩 중 — 잠시 대기
    await new Promise<void>((res) => setTimeout(res, 600));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.tailwindcss.com';
    s.onload = () => {
      (window as any).__twLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error('Tailwind CDN 로드 실패. 네트워크를 확인하세요.'));
    document.head.appendChild(s);
  });
  // Tailwind 초기화 대기
  await new Promise<void>((res) => setTimeout(res, 300));
}

/**
 * HTML 문자열에서 <body> 태그의 class/style 속성을 추출해 container에 적용.
 * Tailwind의 flex/gap 같은 레이아웃 클래스가 컨테이너에 살아야 Chrome과 동일한 레이아웃이 나옴.
 */
function applyBodyAttrsToContainer(html: string, container: HTMLDivElement): void {
  const bodyTagMatch = html.match(/<body([^>]*)>/i);
  if (!bodyTagMatch) return;
  const attrs = bodyTagMatch[1];

  const classMatch = attrs.match(/class=["']([^"']*)["']/i);
  if (classMatch) container.className = classMatch[1];

  const styleMatch = attrs.match(/style=["']([^"']*)["']/i);
  if (styleMatch) {
    // 기존 positioning style에 body inline style 병합
    container.style.cssText += ';' + styleMatch[1];
  }
}

/**
 * HTML의 모든 <style> 태그 내용을 하나로 합쳐 document.head에 주입.
 * extractBodyContent()가 <head>를 버리기 때문에 커스텀 CSS가 사라지는
 * 문제를 보완한다. 반환된 element를 렌더링 후 반드시 제거할 것.
 */
function injectHeadStyles(html: string): HTMLStyleElement | null {
  const matches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  if (!matches || matches.length === 0) return null;
  const combined = matches
  .map((s) => {
    const m = s.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    return m ? m[1] : '';
  })
  .join('\n');
  if (!combined.trim()) return null;
  const el = document.createElement('style');
  el.textContent = combined;
  document.head.appendChild(el);
  return el;
}

/**
 * HTML의 인라인 <script> 태그(src 없는 것)를 document.head에 주입.
 * tailwind.config = {...} 같은 설정 스크립트가 CDN보다 먼저 실행되어야
 * Tailwind 커스텀 색상(bg-bg 등)이 올바르게 동작한다.
 * 반환된 element 배열을 렌더링 후 반드시 제거할 것.
 */
function injectInlineScripts(html: string): HTMLScriptElement[] {
  const injected: HTMLScriptElement[] = [];
  // src 속성이 없는 인라인 <script> 태그만 매칭
  const regex = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const content = match[1].trim();
    if (!content) continue;
    const el = document.createElement('script');
    el.textContent = content;
    document.head.appendChild(el);
    injected.push(el);
  }
  return injected;
}

/**
 * 전체 HTML 문서에서 <body> 안의 내용만 추출.
 * <body> 태그가 없으면 원본 그대로 반환 (fragment 형태).
 */
function extractBodyContent(html: string): string {
  const bodyStart = html.search(/<body[^>]*>/i);
  const bodyEnd = html.search(/<\/body>/i);
  if (bodyStart === -1 || bodyEnd === -1) return html;
  const openTagEnd = html.indexOf('>', bodyStart) + 1;
  return html.slice(openTagEnd, bodyEnd);
}

/**
 * innerHTML로 주입된 컨테이너에서 실제 렌더링 루트 찾기.
 *
 * 처리하는 케이스:
 * 1. <style> 등 비콘텐츠 태그 건너뜀
 * 2. display:none / visibility:hidden 요소 건너뜀 (SVG 아이콘 스프라이트 등)
 * 3. 크기가 0인 요소 건너뜀
 * 4. 가시적 콘텐츠 요소가 1개 → 그것을 루트로
 * 5. 여러 개 (nav+main+footer 등) → container 자체를 루트로 해 전부 포함
 */
const NON_CONTENT_TAGS = new Set([
  'style', 'script', 'meta', 'link', 'title', 'noscript', 'template', 'head',
]);

function findRenderRoot(container: HTMLElement): Element {
  // html/body 구조 태그를 재귀로 통과하며 top-level 콘텐츠 요소 수집
  function collectContentEls(el: Element): Element[] {
    const result: Element[] = [];
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') {
        result.push(...collectContentEls(child));
      } else if (!NON_CONTENT_TAGS.has(tag)) {
        result.push(child);
      }
    }
    return result;
  }

  const contentEls = collectContentEls(container);

  // display:none, visibility:hidden, 크기 0 요소 제외
  const visibleEls = contentEls.filter(el => {
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  // 가시 요소가 정확히 1개 → 그게 루트 (가장 일반적인 케이스)
  if (visibleEls.length === 1) return visibleEls[0];

  // 여러 개이거나 0개 → container 자체를 루트로 사용
  // (투명 배경, 모든 콘텐츠 자식이 포함됨)
  return container;
}

/**
 * body/html에 설정된 배경을 직렬화된 루트 노드에 적용.
 * CSS `body { background: ... }` 규칙은 document.body에 적용되지만
 * 직렬화는 컨테이너 자식부터 시작하므로 body/html 배경이 누락된다.
 * CSS background 속성은 상속되지 않으므로 명시적으로 복사해야 한다.
 */
function applyDocumentBackground(domData: DomNodeData): void {
  const isClear = (c: string) =>
      !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';

  // body → html 순으로 탐색하여 배경색 찾기
  const sources = [
    window.getComputedStyle(document.body),
    window.getComputedStyle(document.documentElement),
  ];

  if (isClear(domData.style.backgroundColor)) {
    for (const cs of sources) {
      if (!isClear(cs.backgroundColor)) {
        domData.style.backgroundColor = cs.backgroundColor;
        break;
      }
    }
  }

  if (!domData.style.backgroundImage || domData.style.backgroundImage === 'none') {
    for (const cs of sources) {
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        domData.style.backgroundImage = cs.backgroundImage;
        break;
      }
    }
  }
}
