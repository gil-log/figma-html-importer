/** 판정 헬퍼: 목 노드 트리(JSON) 탐색과 수치 비교 */

export function createT() {
  const fails = [];
  const fmt = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : JSON.stringify(v));
  return {
    fails,
    ok(cond, msg) {
      if (!cond) fails.push(msg);
      return !!cond;
    },
    eq(actual, expected, msg) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      if (!ok) fails.push(`${msg}: expected ${fmt(expected)}, got ${fmt(actual)}`);
      return ok;
    },
    near(actual, expected, tol, msg) {
      const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol;
      if (!ok) fails.push(`${msg}: expected ${fmt(expected)}±${tol}, got ${fmt(actual)}`);
      return ok;
    },
  };
}

/** 트리를 평탄화하며 루트 기준 절대 좌표(ax, ay)를 붙인다 (회전은 무시) */
export function flatten(root) {
  const out = [];
  const visit = (n, ox, oy, parent) => {
    const ax = ox + n.x;
    const ay = oy + n.y;
    out.push({ ...n, ax, ay, parent });
    for (const c of n.children || []) visit(c, ax, ay, n);
  };
  visit(root, -root.x, -root.y, null);
  return out;
}

export const texts = (root) => flatten(root).filter((n) => n.type === 'TEXT');
export const findText = (root, chars) => texts(root).find((n) => n.characters === chars);
export const findTextIncl = (root, part) => texts(root).find((n) => n.characters.includes(part));
export const find = (root, pred) => flatten(root).find(pred);
export const all = (root, pred) => flatten(root).filter(pred);

const to255 = (v) => Math.round(v * 255);
export function solid(node) {
  const p = (node.fills || []).find((f) => f.type === 'SOLID');
  return p ? [to255(p.color.r), to255(p.color.g), to255(p.color.b)] : null;
}
export const hasSolid = (node, rgb) => JSON.stringify(solid(node)) === JSON.stringify(rgb);

/** Figma gradientTransform → 핸들 위치 (figma-plugin-helpers 의 extractLinearGradientParamsFromTransform 과 같은 계산) */
export function gradientHandles(paint) {
  const [[a, b, tx], [c, d, ty]] = paint.gradientTransform;
  const det = a * d - b * c;
  const inv = [[d / det, -b / det, (b * ty - d * tx) / det], [-c / det, a / det, (c * tx - a * ty) / det]];
  const ap = ([x, y]) => [inv[0][0] * x + inv[0][1] * y + inv[0][2], inv[1][0] * x + inv[1][1] * y + inv[1][2]];
  return { start: ap([0, 0.5]), end: ap([1, 0.5]), yEdge: ap([0.5, 1]), center: ap([0.5, 0.5]) };
}

// ─── zip 만들기 (Claude 디자인 내보내기 흉내) ─────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 파일 표({경로: 문자열|Buffer})로 zip 을 만들어 base64 로 돌려준다.
 * deflate: true 면 압축(방식 8), 아니면 저장(방식 0) — Claude 디자인 내보내기는 저장 방식이다.
 */
export async function makeZipBase64(files, { deflate = false } = {}) {
  const { deflateRawSync } = await import('node:zlib');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]).toString('base64');
}
