/**
 * designExport.ts — Claude 디자인(아티팩트 캔버스)에서 내려받은 zip 을 렌더링할 수 있는 HTML 로 만든다
 *
 * 내려받은 화면(*.dc.html)은 완성된 HTML 이 아니라 <x-dc> 템플릿이다. 같은 zip 의 런타임(support.js)·React·
 * 디자인 시스템 번들이 실행되면서 <x-import> 자리를 실제 컴포넌트로 채운다. 렌더 iframe(srcdoc)에서는 상대 경로를
 * 불러올 수 없으므로, 참조하는 스크립트·스타일을 본문에 넣고 런타임이 쓰는 자원표(window.__resources /
 * __resourceBlobs)를 채워 외부 요청 없이 그려지게 한다.
 */

export interface DesignArtboard {
  /** zip 안 경로 (예: "Filled.dc.html") */
  path: string;
  /** 렌더링할 HTML (자원을 모두 넣은 한 장) */
  html: string;
  title: string;
  /** data-props 의 $preview 크기 (없으면 null) */
  width: number | null;
  height: number | null;
}

const MIME: Record<string, string> = {
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif',
};

/** 템플릿(<x-dc>)과 로직 스크립트를 가진 캔버스 화면인가 */
export function isDesignComponentHtml(html: string): boolean {
  return /<x-dc[\s>]/i.test(html) && /data-dc-script/i.test(html);
}

/** 캔버스 화면인데 런타임을 상대 경로로만 불러온다 → 이 문서만으로는 그려지지 않는다 */
export function needsDesignExport(html: string): boolean {
  return isDesignComponentHtml(html) && /<script\b[^>]*\bsrc\s*=\s*["'](?![a-z][a-z0-9+.-]*:|\/\/)[^"']+["']/i.test(html);
}

const isJunk = (path: string) => path.startsWith('__MACOSX/') || path.split('/').some((seg) => seg.startsWith('.'));

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

/** base 파일 기준 상대 경로를 zip 안 경로로 (밖으로 나가거나 외부 URL 이면 null) */
function resolvePath(base: string, ref: string): string | null {
  const clean = ref.trim().split(/[?#]/)[0];
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
  const parts = (clean.startsWith('/') ? clean.slice(1) : dirOf(base) + clean).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(p);
  }
  let joined = out.join('/');
  try {
    joined = decodeURIComponent(joined);
  } catch { /* 그대로 */ }
  return joined;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function dataUri(path: string, bytes: Uint8Array): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return `data:${MIME[ext] ?? 'application/octet-stream'};base64,${toBase64(bytes)}`;
}

/** 인라인 <script> 안에서 문서 파서가 태그 끝으로 읽는 문자열을 끊는다 (JS 의미는 같다) */
const escapeScript = (js: string) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const escapeStyle = (css: string) => css.replace(/<\/(style)/gi, '<\\/$1');

function decodeAttr(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function readPreview(html: string): { width: number | null; height: number | null } {
  const m = /data-props\s*=\s*(['"])([\s\S]*?)\1/i.exec(html);
  if (!m) return { width: null, height: null };
  try {
    const preview = JSON.parse(decodeAttr(m[2]))?.$preview;
    const w = Number(preview?.width);
    const h = Number(preview?.height);
    return { width: w > 0 ? w : null, height: h > 0 ? h : null };
  } catch {
    return { width: null, height: null };
  }
}

export function readDesignExport(files: Map<string, Uint8Array>): DesignArtboard[] {
  const utf8 = new TextDecoder('utf-8');
  const text = (path: string) => utf8.decode(files.get(path)!);
  const paths = [...files.keys()].filter((p) => !isJunk(p));
  const boards = paths.filter((p) => /\.dc\.html?$/i.test(p));

  // CSS 안의 url(…) 은 그 CSS 파일 기준이다 → zip 안에 있으면 data URI 로
  const inlineCss = (cssPath: string, css: string) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _q, ref) => {
    const target = resolvePath(cssPath, ref);
    const bytes = target ? files.get(target) : undefined;
    return bytes ? `url("${dataUri(target!, bytes)}")` : whole;
  });

  return boards.map((board) => {
    let html = text(board);
    // <script src="상대경로"></script> → 본문 스크립트
    html = html.replace(/<script\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi, (whole, pre, _q, src, post) => {
      const target = resolvePath(board, src);
      if (!target || !files.has(target)) return whole;
      return `<script${pre}${post}>${escapeScript(text(target))}</script>`;
    });
    // <link rel="stylesheet" href="상대경로"> → <style>
    html = html.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/\brel\s*=\s*(["'])[^"']*\bstylesheet\b[^"']*\1/i.test(tag)) return tag;
      const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(tag)?.[2];
      const target = href ? resolvePath(board, href) : null;
      if (!target || !files.has(target)) return tag;
      return `<style>${escapeStyle(inlineCss(target, text(target)))}</style>`;
    });
    // <img src="상대경로"> 등 → data URI
    html = html.replace(/(<(?:img|source|image)\b[^>]*?\s(?:src|href)\s*=\s*)(["'])([^"']+)\2/gi, (whole, pre, q, ref) => {
      const target = resolvePath(board, ref);
      const bytes = target ? files.get(target) : undefined;
      return bytes ? `${pre}${q}${dataUri(target!, bytes)}${q}` : whole;
    });

    // 런타임 자원표: 있으면 런타임이 문서 자신을 다시 받지 않고, <dc-import> 하는 옆 화면을 여기서 읽는다
    const siblings: Record<string, string> = {};
    for (const other of boards) {
      if (other === board) continue;
      const rel = other.startsWith(dirOf(board)) ? other.slice(dirOf(board).length) : null;
      if (rel && !rel.includes('/')) siblings[`./${encodeURIComponent(rel.replace(/\.dc\.html?$/i, ''))}.dc.html`] = text(other);
    }
    const boot = `<script>(function(){var R={},B={},S=${escapeScript(JSON.stringify(siblings))};` +
      `Object.keys(S).forEach(function(k,i){var id='dc-sibling-'+i;R[k]=id;B[id]=new Blob([S[k]],{type:'text/html'});});` +
      `window.__resources=R;window.__resourceBlobs=B;})();</script>`;
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + boot) : boot + html;

    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text(board))?.[1].trim() ?? '';
    const name = board.slice(board.lastIndexOf('/') + 1).replace(/\.dc\.html?$/i, '');
    return { path: board, html, title: title || name, ...readPreview(text(board)) };
  });
}

/** 렌더링이 끝나 #dc-root 에 내용이 생길 때까지 기다린다 (캔버스 화면이 아니면 바로 끝) */
export async function waitForDesignRuntime(doc: Document, maxMs: number): Promise<void> {
  const isDesign = () => !!doc.querySelector('x-dc') || !!doc.getElementById('dc-root');
  if (!isDesign()) return;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const root = doc.getElementById('dc-root');
    if (root && root.childElementCount > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
