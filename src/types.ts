// ─── DOM 데이터 (UI → Main 전달용) ────────────────────────────

export interface DomStyleData {
  // 배경
  backgroundColor: string;
  backgroundImage: string;

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
  overflow: string;

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

export interface DomNodeData {
  tagName: string;
  text?: string;        // 텍스트 리프 노드의 텍스트 콘텐츠
  imageUrl?: string;    // <img> src
  svgHtml?: string;     // <svg> 직렬화 HTML (<use> 참조 인라인 처리 후)
  rect: {
    x: number;         // 부모 기준 상대 좌표
    y: number;
    width: number;
    height: number;
  };
  visible: boolean;
  style: DomStyleData;
  children: DomNodeData[];
}

// ─── 메시지 타입 ──────────────────────────────────────────────

// UI → Main
export interface ImportDomMessage {
  type: 'import-dom';
  data: DomNodeData;
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
