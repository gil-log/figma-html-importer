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
