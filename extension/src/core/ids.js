// Small shared helpers for stored data (ids, stroke normalisation).

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.min(1, Math.max(0, num(v, 0.5)));

// Handwriting stroke with normalised points. `maxWidth` is relative to the frame height
// (video picture for annotations, line box for lyrics).
export function normalizeStroke(s, maxWidth = 0.05) {
  if (!s || !Array.isArray(s.points)) return null;
  const points = s.points.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [clamp01(p[0]), clamp01(p[1])]);
  if (!points.length) return null;
  return {
    tool: ['pen', 'circle', 'arrow'].includes(s.tool) ? s.tool : 'pen',
    color: typeof s.color === 'string' && s.color ? s.color.slice(0, 20) : '#ff3b30',
    width: Math.min(maxWidth, Math.max(0.001, num(s.width, 0.006))),
    points,
  };
}
