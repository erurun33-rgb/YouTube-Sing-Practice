// Geometry helpers for the annotation overlay (pure, unit tested).

// Rectangle actually showing picture inside an element that letterboxes (object-fit: contain).
// elRect: {left, top, width, height}; intrinsic: {width, height} (0 when unknown -> whole element).
export function containRect(elRect, intrinsic) {
  const { left, top, width, height } = elRect;
  const iw = intrinsic?.width || 0;
  const ih = intrinsic?.height || 0;
  if (!(iw > 0 && ih > 0 && width > 0 && height > 0)) return { left, top, width, height };
  const scale = Math.min(width / iw, height / ih);
  const w = iw * scale;
  const h = ih * scale;
  return { left: left + (width - w) / 2, top: top + (height - h) / 2, width: w, height: h };
}

// Client (px) -> normalised 0..1 coordinates inside rect (clamped).
export function toNormalized(clientX, clientY, rect) {
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
}

// Ramer-Douglas-Peucker polyline simplification; keeps storage small for handwriting.
export function simplify(points, epsilon = 0.002) {
  if (points.length <= 2) return points.slice();
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  let maxD = -1, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= epsilon) return [points[0], points[points.length - 1]];
  const left = simplify(points.slice(0, idx + 1), epsilon);
  const right = simplify(points.slice(idx), epsilon);
  return left.slice(0, -1).concat(right);
}

export function roundPoints(points, digits = 4) {
  const f = 10 ** digits;
  return points.map(([x, y]) => [Math.round(x * f) / f, Math.round(y * f) / f]);
}

// Distance from point to segment, used by the stroke eraser (all in the same units).
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Geometry of a stroke expressed in pixel space (for hit testing / drawing shapes).
// circle: points = [corner1, corner2] bounding box; arrow: [start, end]; pen: polyline.
export function strokeHit(stroke, px, py, w, h, tolerancePx) {
  const P = stroke.points.map(([x, y]) => [x * w, y * h]);
  if (stroke.tool === 'circle' && P.length >= 2) {
    const cx = (P[0][0] + P[1][0]) / 2, cy = (P[0][1] + P[1][1]) / 2;
    const rx = Math.abs(P[1][0] - P[0][0]) / 2, ry = Math.abs(P[1][1] - P[0][1]) / 2;
    if (rx < 1 || ry < 1) return Math.hypot(px - cx, py - cy) <= tolerancePx + Math.max(rx, ry);
    // Approximate distance to ellipse outline via normalised radius.
    const r = Math.hypot((px - cx) / rx, (py - cy) / ry);
    return Math.abs(r - 1) * Math.min(rx, ry) <= tolerancePx;
  }
  if (P.length === 1) return Math.hypot(px - P[0][0], py - P[0][1]) <= tolerancePx;
  for (let i = 1; i < P.length; i++) {
    if (distToSegment(px, py, P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]) <= tolerancePx) return true;
  }
  return false;
}

export function formatTime(t) {
  if (!Number.isFinite(t)) return '--:--';
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}
