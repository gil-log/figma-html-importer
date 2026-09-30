// ─── DOM 데이터 (UI → Main 전달용) ────────────────────────────

export interface DomStyleData {
  // 배경
  backgroundColor: string;
  backgroundImage: string;
  backgroundSize: string;
  backgroundRepeat: string;
  objectFit: string;

  // 텍스트
  color: string;
  fontSize: number;
  fontWeight: string;
  fontFamily: string;
  fontStyle: string;
  lineHeight: string;
  textAlign: string;
  letterSpacing: string;
  textDecoration: string;
  textTransform: string;
  direction: string;

  // 테두리
  borderTopLeftRadius: number;
  borderTopRightRadius: number;
  borderBottomRightRadius: number;
  borderBottomLeftRadius: number;
  borderTopWidth: number;
  borderRightWidth: number;
  borderBottomWidth: number;
  borderLeftWidth: number;
  borderColor: string;
  borderStyle: string;

  // 기타 시각
  opacity: number;
  boxShadow: string;
  textShadow: string;
  filter: string;
  backdropFilter: string;
  mixBlendMode: string;
  /** background-clip:text 로 글자에만 칠해지는 배경(그라디언트 글자) */
  textFillImage: string;
  overflow: string;
  overflowX: string;
  overflowY: string;

  // 레이아웃
  display: string;
  flexDirection: string;
  alignItems: string;
  justifyContent: string;
  rowGap: number;
  columnGap: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  position: string;
}

/**
 * 인라인 혼합 콘텐츠의 스타일 구간.
 * 세그먼트 text 를 이어 붙이면 노드의 text 와 정확히 같다.
 * 스타일 필드는 노드 기본 스타일과 다를 때만 채운다.
 */
export interface TextSegment {
  text: string;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  fontSize?: number;
  color?: string;
  textDecoration?: string;
  textTransform?: string;
  letterSpacing?: string;
}

export interface TextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomNodeData {
  tagName: string;
  text?: string;           // 텍스트 리프 노드의 텍스트 콘텐츠 (공백은 CSS white-space 규칙대로 접힌 상태)
  textSegments?: TextSegment[];  // 인라인 혼합 콘텐츠의 스타일 구간
  textBox?: TextBox;       // 실제 글자 줄 상자들의 합집합 (노드 rect 기준, Range 로 측정)
  wrapBox?: { x: number; width: number };  // 여러 줄일 때 줄바꿈 기준 폭 (content box, 노드 rect 기준)
  lineCount?: number;      // 브라우저에서 실제로 그려진 줄 수
  truncate?: { maxLines: number };  // text-overflow:ellipsis / -webkit-line-clamp
  imageUrl?: string;       // <img> src, <canvas> 내용(data URL), <video> poster
  svgHtml?: string;        // <svg> 직렬화 HTML (<use> 참조 인라인 처리 후)
  rect: {
    x: number;            // 부모 기준 상대 좌표
    y: number;
    width: number;
    height: number;
  };
  visible: boolean;
  /** 크기가 0 인 박스 (자식만 보인다: 배경·테두리·클리핑 없이 자식만 배치) */
  collapsed?: boolean;
  /** display:contents — 자신은 박스가 없고 자식이 부모 기준 좌표를 가진다 */
  contents?: boolean;
  /**
   * 회전 transform (CSS matrix(a, b, c, d, e, f) + transform-origin, 요소 rect 기준 px).
   * 이 값이 있으면 rect·자식 좌표는 회전을 풀어낸 원래 레이아웃 기준이다.
   */
  transform?: { a: number; b: number; c: number; d: number; e: number; f: number; ox: number; oy: number };
  style: DomStyleData;
  children: DomNodeData[];
}

// ─── 메시지 타입 ──────────────────────────────────────────────

/** UI 에서 받아온 이미지 (PNG·JPEG·GIF, 최대 4096px) — width/height 는 원본 크기 */
export interface ImageAsset {
  bytes: Uint8Array;
  width: number;
  height: number;
}

// UI → Main
export interface ImportDomMessage {
  type: 'import-dom';
  data: DomNodeData;
  images?: Record<string, ImageAsset>;
}

export type UIToMainMessage = ImportDomMessage;

// Main → UI
export interface ImportDoneMessage {
  type: 'import-done';
  frameCount: number;
  textCount: number;
}

export interface ImportErrorMessage {
  type: 'import-error';
  error: string;
}

export type MainToUIMessage = ImportDoneMessage | ImportErrorMessage;
