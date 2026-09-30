/**
 * figma-mock.js — Figma 샌드박스 API 목(mock)
 *
 * dist/code.js 를 브라우저에서 그대로 실행하기 위한 최소 구현.
 * 실제 Figma 가 거부하는 호출(미로딩 폰트로 텍스트 수정, 0 크기 resize,
 * 지원하지 않는 이미지 포맷, 잘못된 SVG 등)은 똑같이 예외를 던져
 * 런타임 오류를 테스트 단계에서 잡는다.
 */
(function () {
  const AVAILABLE = {
    'Inter': ['Thin', 'Extra Light', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black',
      'Thin Italic', 'Extra Light Italic', 'Light Italic', 'Italic', 'Medium Italic', 'Semi Bold Italic',
      'Bold Italic', 'Extra Bold Italic', 'Black Italic'],
    'Roboto': ['Thin', 'Light', 'Regular', 'Medium', 'Bold', 'Black', 'Italic', 'Medium Italic', 'Bold Italic'],
    'Roboto Mono': ['Regular', 'Medium', 'Bold'],
    'Noto Sans KR': ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black'],
    'Merriweather': ['Light', 'Regular', 'Bold', 'Black', 'Italic'],
    'Open Sans': ['Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Italic'],
  };

  const loaded = new Set();
  const key = (f) => f.family + '/' + f.style;
  const log = { fontLoads: [], messages: [] };

  const canvas = document.createElement('canvas').getContext('2d');
  function measure(text, font) {
    canvas.font = `${font.size}px "${font.family}", sans-serif`;
    return canvas.measureText(text).width;
  }

  function assertLoaded(font, what) {
    if (!loaded.has(key(font))) throw new Error(`unloaded font "${key(font)}" (${what})`);
  }

  let idSeq = 0;
  function base(type) {
    const n = {
      id: String(++idSeq), type, name: type, parent: null, children: [],
      _x: 0, _y: 0, _w: 100, _h: 100, _rt: null,
      fills: [], strokes: [], opacity: 1, visible: true, blendMode: 'PASS_THROUGH',
      get x() { return this._x; }, set x(v) { this._x = v; this._rt = null; },
      get y() { return this._y; }, set y(v) { this._y = v; this._rt = null; },
      get width() { return this._w; }, get height() { return this._h; },
      get relativeTransform() { return this._rt || [[1, 0, this._x], [0, 1, this._y]]; },
      set relativeTransform(m) {
        if (!Array.isArray(m) || m.length !== 2 || m.some((r) => r.length !== 3 || r.some((v) => !isFinite(v)))) {
          throw new Error('invalid transform');
        }
        this._rt = m; this._x = m[0][2]; this._y = m[1][2];
      },
      resize(w, h) {
        if (!(w >= 0.01) || !(h >= 0.01)) throw new Error(`resize must be >= 0.01 (got ${w}x${h})`);
        this._w = w; this._h = h;
      },
      resizeWithoutConstraints(w, h) { this.resize(w, h); },
      appendChild(c) {
        if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
        this.children.push(c); c.parent = this;
      },
      insertChild(i, c) {
        if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
        this.children.splice(i, 0, c); c.parent = this;
      },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; },
    };
    let effects = [];
    Object.defineProperty(n, 'effects', {
      get() { return effects; },
      set(list) {
        for (const e of list) {
          if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
            if (!e.color || !e.offset || !(e.radius >= 0) || e.visible === undefined || !e.blendMode) {
              throw new Error('invalid shadow effect ' + JSON.stringify(e));
            }
            const spreadOk = n.type === 'RECTANGLE' || n.type === 'ELLIPSE' ||
              (n.type === 'FRAME' && n.clipsContent && n.fills.some((p) => p.visible !== false));
            if (e.spread && !spreadOk) throw new Error('spread not accepted on this node');
          } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
            if (!(e.radius >= 0) || e.blurType !== 'NORMAL' || e.visible === undefined) {
              throw new Error('invalid blur effect ' + JSON.stringify(e));
            }
          } else {
            throw new Error('unknown effect ' + e.type);
          }
        }
        effects = list;
      },
    });
    return n;
  }

  function frame() {
    const n = base('FRAME');
    n.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    n.clipsContent = true;
    n.cornerRadius = 0;
    n.layoutMode = 'NONE';
    return n;
  }

  function text() {
    const n = base('TEXT');
    n.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
    const s = {
      fontName: { family: 'Inter', style: 'Regular' }, characters: '', fontSize: 12,
      textAutoResize: 'NONE', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP',
      lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PERCENT', value: 0 },
      textDecoration: 'NONE', textCase: 'ORIGINAL', textTruncation: 'DISABLED', maxLines: null,
      textDecorationStyle: null, textDecorationOffset: null, textDecorationThickness: null, textDecorationColor: null,
    };
    n.ranges = [];
    const guarded = ['characters', 'fontSize', 'textAutoResize', 'textAlignHorizontal', 'textAlignVertical',
      'lineHeight', 'letterSpacing', 'textDecoration', 'textCase', 'textTruncation', 'maxLines',
      'textDecorationStyle', 'textDecorationOffset', 'textDecorationThickness', 'textDecorationColor'];
    for (const p of guarded) {
      Object.defineProperty(n, p, {
        get() { return s[p]; },
        set(v) {
          assertLoaded(s.fontName, 'set ' + p);
          // Figma: 밑줄 세부 속성은 밑줄·취소선이 있을 때만 의미가 있다
          if (p.startsWith('textDecoration') && p !== 'textDecoration' && s.textDecoration === 'NONE') {
            throw new Error(`${p} requires textDecoration`);
          }
          // 테스트용 실패 주입: 이 글자를 넣으면 Figma 가 거부한 것처럼 예외
          if (p === 'characters' && window.__failText && v === window.__failText) throw new Error('injected failure');
          s[p] = v;
        },
      });
    }
    Object.defineProperty(n, 'fontName', {
      get() { return s.fontName; },
      set(f) { assertLoaded(f, 'set fontName'); s.fontName = f; },
    });
    const lineH = () => (s.lineHeight.unit === 'PIXELS' ? s.lineHeight.value : s.fontSize * 1.21);
    const lines = () => {
      const paras = s.characters.split('\n');
      if (s.textAutoResize === 'WIDTH_AND_HEIGHT') return paras;
      const out = [];
      for (const para of paras) {
        let cur = '';
        for (const word of para.split(' ')) {
          const cand = cur ? cur + ' ' + word : word;
          if (cur && measure(cand, { size: s.fontSize, family: s.fontName.family }) > n._w + 0.5) {
            out.push(cur); cur = word;
          } else cur = cand;
        }
        out.push(cur);
      }
      return s.maxLines ? out.slice(0, s.maxLines) : out;
    };
    Object.defineProperty(n, 'width', {
      get() {
        if (s.textAutoResize !== 'WIDTH_AND_HEIGHT') return n._w;
        return Math.max(1, ...lines().map((l) => measure(l, { size: s.fontSize, family: s.fontName.family })));
      },
    });
    Object.defineProperty(n, 'height', {
      get() { return s.textAutoResize === 'NONE' ? n._h : lines().length * lineH(); },
    });
    const range = (kind) => (start, end, value) => {
      if (!(start >= 0 && end <= s.characters.length && start < end)) {
        throw new Error(`range out of bounds ${kind} ${start}-${end} / ${s.characters.length}`);
      }
      if (kind === 'fontName') assertLoaded(value, 'setRangeFontName');
      n.ranges.push({ kind, start, end, value: kind === 'fontName' ? key(value) : value });
    };
    n.setRangeFontName = range('fontName');
    n.setRangeFills = range('fills');
    n.setRangeFontSize = range('fontSize');
    n.setRangeTextDecoration = range('textDecoration');
    n.setRangeTextCase = range('textCase');
    n.setRangeLetterSpacing = range('letterSpacing');
    n.setRangeLineHeight = range('lineHeight');
    n.setRangeTextDecorationStyle = range('textDecorationStyle');
    n.setRangeTextDecorationThickness = range('textDecorationThickness');
    n.setRangeTextDecorationOffset = range('textDecorationOffset');
    n.setRangeTextDecorationColor = range('textDecorationColor');
    return n;
  }

  function isSupportedImage(bytes) {
    const b = bytes;
    return (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
      (b[0] === 0xff && b[1] === 0xd8) ||
      (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46);
  }

  const page = base('PAGE');
  page.selection = [];
  const storage = {};

  window.__figmaLog = log;
  window.figma = {
    showUI() {},
    notify() {},
    ui: {
      onmessage: null,
      postMessage(m) {
        log.messages.push(m);
        document.getElementById('ui').contentWindow.postMessage({ pluginMessage: m }, '*');
      },
      resize() {},
    },
    createFrame: frame,
    createRectangle() { const n = base('RECTANGLE'); n.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }]; n.cornerRadius = 0; return n; },
    createEllipse() { return base('ELLIPSE'); },
    createText: text,
    createNodeFromSvg(svg) {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (doc.querySelector('parsererror')) throw new Error('invalid svg');
      const n = frame();
      n.svg = svg;
      const root = doc.documentElement;
      n._w = parseFloat(root.getAttribute('width')) || 100;
      n._h = parseFloat(root.getAttribute('height')) || 100;
      return n;
    },
    createImage(bytes) {
      if (!(bytes instanceof Uint8Array) || !isSupportedImage(bytes)) throw new Error('unsupported image format');
      return { hash: 'img' + (++idSeq) + '_' + bytes.length };
    },
    loadFontAsync(f) {
      log.fontLoads.push(key(f));
      if ((AVAILABLE[f.family] || []).includes(f.style)) { loaded.add(key(f)); return Promise.resolve(); }
      return Promise.reject(new Error('font not found ' + key(f)));
    },
    listAvailableFontsAsync() {
      const out = [];
      for (const [family, styles] of Object.entries(AVAILABLE)) {
        for (const style of styles) out.push({ fontName: { family, style } });
      }
      return Promise.resolve(out);
    },
    clientStorage: {
      getAsync(k) { return Promise.resolve(storage[k]); },
      setAsync(k, v) { storage[k] = v; return Promise.resolve(); },
    },
    viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
    currentPage: page,
    commitUndo() {},
  };
  window.__html__ = '';

  // ── 목 노드 → 비교용 JSON ────────────────────────────────
  window.__serializeNode = function serialize(n) {
    const o = { type: n.type, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height };
    for (const p of ['opacity', 'visible', 'clipsContent', 'cornerRadius', 'topLeftRadius', 'strokeWeight',
      'strokeAlign', 'dashPattern', 'blendMode', 'layoutMode', 'itemSpacing', 'counterAxisSpacing',
      'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'primaryAxisAlignItems',
      'counterAxisAlignItems', 'layoutPositioning', 'layoutWrap', 'layoutSizingHorizontal', 'layoutSizingVertical',
      'svg']) {
      if (n[p] !== undefined) o[p] = n[p];
    }
    o.fills = n.fills;
    o.strokes = n.strokes;
    o.effects = n.effects;
    if (n._rt) o.relativeTransform = n._rt;
    if (n.type === 'TEXT') {
      for (const p of ['characters', 'fontName', 'fontSize', 'textAutoResize', 'textAlignHorizontal', 'lineHeight',
        'letterSpacing', 'textDecoration', 'textCase', 'textTruncation', 'maxLines', 'ranges', 'textDecorationStyle',
        'textDecorationOffset', 'textDecorationThickness', 'textDecorationColor', 'strokeWeight', 'strokeAlign']) o[p] = n[p];
    }
    o.children = n.children.map(serialize);
    return o;
  };
})();
