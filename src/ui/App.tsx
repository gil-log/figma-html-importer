import React, {useCallback, useEffect, useState} from 'react';
import {serializeDom} from '../domSerializer';
import type {DomNodeData, MainToUIMessage} from '../types';
import {canvasBackground, findRenderRoot, prepareForCapture, renderHtml} from './render';
import {collectImageUrls, loadImages} from './images';

// 렌더 폭별 뷰포트 높이 (vh 단위·position:fixed 기준)
const WIDTH_OPTIONS = [
  {label: '375px — Mobile', value: 375, height: 812},
  {label: '768px — Tablet', value: 768, height: 1024},
  {label: '1440px — Desktop', value: 1440, height: 900},
  {label: '1920px — Wide', value: 1920, height: 1080},
  {label: '2880px — Multi-screen', value: 2880, height: 1620},
  {label: '3840px — Extra Wide', value: 3840, height: 2160},
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

const WHITE = 'rgb(255, 255, 255)';

export default function App() {
  const [html, setHtml] = useState('');
  const [renderWidth, setRenderWidth] = useState(1440);
  const [autoLayout, setAutoLayout] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<{ frameCount: number; textCount: number } | null>(null);
  const [error, setError] = useState('');

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

    const option = WIDTH_OPTIONS.find((o) => o.value === renderWidth) ?? WIDTH_OPTIONS[2];
    let rendered: Awaited<ReturnType<typeof renderHtml>> | null = null;
    try {
      // ── 1. 렌더 폭×높이 iframe 에서 렌더링 (스크립트·Tailwind·웹폰트 처리 대기 포함) ──
      rendered = await renderHtml(html, {width: option.value, height: option.height});
      const {doc, win} = rendered;

      setStatus('parsing');
      prepareForCapture(doc, win);

      // ── 2. 루트 결정 후 직렬화 ────────────────────────────
      const {root, page} = findRenderRoot(doc, win);
      const domData = serializeDom(root, root.getBoundingClientRect());
      if (!domData) throw new Error(
          `<${root.tagName.toLowerCase()}> 요소 크기가 0입니다.\n` +
          '콘텐츠가 없거나 스타일이 적용되지 않은 요소입니다.'
      );

      // ── 3. 루트 배경: 페이지면 캔버스 배경(html → body 전파), 없으면 브라우저처럼 흰색 ──
      if (page) applyCanvasBackground(domData, canvasBackground(doc, win));
      if (!hasBackground(domData)) domData.style.backgroundColor = WHITE;

      // ── 4. 참조된 이미지를 바이트로 받아 함께 보낸다 (못 받은 것은 자리표시) ──
      const images = await loadImages(collectImageUrls(domData));

      setStatus('building');
      parent.postMessage({pluginMessage: {
        type: 'import-dom', data: domData, images, title: doc.title, options: {autoLayout},
      }}, '*');
    } catch (e: any) {
      setStatus('error');
      setError(e.message ?? String(e));
    } finally {
      rendered?.dispose();
    }
  }, [html, renderWidth, autoLayout]);

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

        {/* 옵션 */}
        <label className="option">
          <input
              id="opt-autolayout"
              type="checkbox"
              checked={autoLayout}
              onChange={(e) => setAutoLayout(e.target.checked)}
              disabled={isImporting}
          />
          <span>flex 를 Auto Layout 으로 변환 (브라우저 배치와 같을 때만)</span>
        </label>

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
          불러올 수 없는 이미지(CORS 차단 등)는 회색 자리표시로 대체됩니다.
        </div>
      </div>
  );
}

// ─── 헬퍼 함수 ────────────────────────────────────────────────

function hasBackground(node: DomNodeData): boolean {
  const c = node.style.backgroundColor;
  const clear = !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
  return !clear || (!!node.style.backgroundImage && node.style.backgroundImage !== 'none');
}

/**
 * 페이지 루트(html)에 캔버스 배경을 적용.
 * body 배경이 캔버스로 전파된 경우 body 노드에서는 지워 같은 배경이 두 번 그려지지 않게 한다.
 */
function applyCanvasBackground(root: DomNodeData, canvas: ReturnType<typeof canvasBackground>): void {
  if (!canvas) return;
  root.style.backgroundColor = canvas.backgroundColor;
  root.style.backgroundImage = canvas.backgroundImage;
  if (canvas.fromBody) {
    const body = root.children.find((c) => c.tagName === 'body');
    if (body) {
      body.style.backgroundColor = 'transparent';
      body.style.backgroundImage = '';
    }
  }
}
