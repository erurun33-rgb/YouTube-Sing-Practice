// Canvas drawing of a normalised handwriting stroke (shared by annotations and lyrics).

export function drawStroke(ctx, s, w, h) {
  const lw = Math.max(1.5, s.width * h);
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = 2;
  const P = s.points.map(([x, y]) => [x * w, y * h]);
  if (!P.length) return;
  ctx.beginPath();
  if (s.tool === 'circle' && P.length >= 2) {
    const cx = (P[0][0] + P[1][0]) / 2, cy = (P[0][1] + P[1][1]) / 2;
    ctx.ellipse(cx, cy, Math.abs(P[1][0] - P[0][0]) / 2, Math.abs(P[1][1] - P[0][1]) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (s.tool === 'arrow' && P.length >= 2) {
    const [a, b] = [P[0], P[P.length - 1]];
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const head = Math.max(10, lw * 4);
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - head * Math.cos(ang - 0.45), b[1] - head * Math.sin(ang - 0.45));
    ctx.lineTo(b[0] - head * Math.cos(ang + 0.45), b[1] - head * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (P.length === 1) {
    ctx.arc(P[0][0], P[0][1], lw / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo(P[0][0], P[0][1]);
  for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]);
  ctx.stroke();
}
