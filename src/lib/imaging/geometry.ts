import type { Pt, Quad } from './types';

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Monotone chain. Ergebnis ist im Uhrzeigersinn (y zeigt nach unten). */
export function convexHull(points: Pt[]): Pt[] {
  if (points.length < 4) return points.slice();
  const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function polygonArea(poly: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function perimeter(poly: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) sum += dist(poly[i], poly[(i + 1) % poly.length]);
  return sum;
}

function pointLineDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return dist(p, a);
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / len;
}

/** Douglas-Peucker auf einer offenen Punktkette. */
function simplifyChain(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  let maxDist = -1;
  let index = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointLineDistance(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= eps) return [pts[0], pts[pts.length - 1]];
  const left = simplifyChain(pts.slice(0, index + 1), eps);
  const right = simplifyChain(pts.slice(index), eps);
  return left.slice(0, -1).concat(right);
}

/** Douglas-Peucker auf einem geschlossenen Polygon. */
export function simplifyPolygon(poly: Pt[], eps: number): Pt[] {
  if (poly.length < 4) return poly.slice();
  // Startpunkt: der Punkt mit dem grössten Abstand zum ersten Punkt. So liegt
  // der Schnitt garantiert auf einer echten Ecke und nicht mitten auf einer Kante.
  let far = 0;
  let farDist = -1;
  for (let i = 1; i < poly.length; i++) {
    const d = dist(poly[0], poly[i]);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  const chainA = poly.slice(0, far + 1);
  const chainB = poly.slice(far).concat([poly[0]]);
  const a = simplifyChain(chainA, eps);
  const b = simplifyChain(chainB, eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

/**
 * Nähert ein konvexes Polygon durch genau vier Ecken an. Sucht das kleinste
 * Epsilon, das noch ein Viereck liefert; erst wenn das scheitert, kommt das
 * umschliessende Rechteck zum Zug.
 */
export function approximateQuad(hull: Pt[]): Quad | null {
  if (hull.length < 4) return null;
  if (hull.length === 4) return orderQuad(hull);

  const peri = perimeter(hull);
  let best: Pt[] | null = null;
  for (let step = 1; step <= 40; step++) {
    const eps = (peri * step) / 1000; // 0.1 % .. 4 % des Umfangs
    const simplified = simplifyPolygon(hull, eps);
    if (simplified.length === 4) {
      best = simplified;
      break;
    }
    if (simplified.length < 4) break;
  }
  if (!best) return minAreaRect(hull);
  return orderQuad(best);
}

/** Kleinstes umschliessendes Rechteck über Rotating Calipers auf der Hülle. */
export function minAreaRect(hull: Pt[]): Quad | null {
  if (hull.length < 3) return null;
  let bestArea = Infinity;
  let best: Quad | null = null;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const ux = ex / len;
    const uy = ey / len;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const toXy = (u: number, v: number): Pt => ({ x: u * ux - v * uy, y: u * uy + v * ux });
      best = [toXy(minU, minV), toXy(maxU, minV), toXy(maxU, maxV), toXy(minU, maxV)];
    }
  }
  return best ? orderQuad(best) : null;
}

/** Bringt vier Punkte in die Reihenfolge TL, TR, BR, BL. */
export function orderQuad(pts: Pt[]): Quad {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const sorted = pts
    .slice()
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // Nach dem Winkelsortieren beginnt die Kette irgendwo; auf die Ecke oben
  // links (kleinste Summe x+y) rotieren.
  let start = 0;
  let bestSum = Infinity;
  for (let i = 0; i < 4; i++) {
    const sum = sorted[i].x + sorted[i].y;
    if (sum < bestSum) {
      bestSum = sum;
      start = i;
    }
  }
  const rotated = [sorted[start], sorted[(start + 1) % 4], sorted[(start + 2) % 4], sorted[(start + 3) % 4]];
  // Uhrzeigersinn erzwingen (positive Fläche bei y nach unten).
  let signed = 0;
  for (let i = 0; i < 4; i++) {
    const a = rotated[i];
    const b = rotated[(i + 1) % 4];
    signed += a.x * b.y - b.x * a.y;
  }
  if (signed < 0) rotated.reverse();
  // Nach dem Umdrehen kann die Ecke oben links verrutscht sein.
  let s2 = 0;
  let bs2 = Infinity;
  for (let i = 0; i < 4; i++) {
    const sum = rotated[i].x + rotated[i].y;
    if (sum < bs2) {
      bs2 = sum;
      s2 = i;
    }
  }
  return [rotated[s2], rotated[(s2 + 1) % 4], rotated[(s2 + 2) % 4], rotated[(s2 + 3) % 4]] as Quad;
}

export function quadCentroid(q: Quad): Pt {
  return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
}

export function scaleQuad(q: Quad, factor: number): Quad {
  return q.map((p) => ({ x: p.x * factor, y: p.y * factor })) as Quad;
}

/**
 * Plausibilitätsprüfung: annähernd rechte Winkel, keine extrem schiefen
 * Seitenverhältnisse, keine entarteten Formen.
 */
export function isPlausibleQuad(q: Quad): boolean {
  const sides = [dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0])];
  if (sides.some((s) => s < 8)) return false;

  // Gegenüberliegende Seiten dürfen sich perspektivisch unterscheiden, aber nicht beliebig.
  if (Math.max(sides[0], sides[2]) / Math.min(sides[0], sides[2]) > 2.2) return false;
  if (Math.max(sides[1], sides[3]) / Math.min(sides[1], sides[3]) > 2.2) return false;

  // Seitenverhältnis: Fotos sind selten extremer als 4:1.
  const w = (sides[0] + sides[2]) / 2;
  const h = (sides[1] + sides[3]) / 2;
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio > 4) return false;

  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4];
    const cur = q[i];
    const next = q[(i + 1) % 4];
    const v1x = prev.x - cur.x;
    const v1y = prev.y - cur.y;
    const v2x = next.x - cur.x;
    const v2y = next.y - cur.y;
    const cosA =
      (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
    const angle = (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI;
    if (angle < 55 || angle > 125) return false;
  }
  return true;
}

/**
 * Verschiebt jede Kante eines konvexen Vierecks um `distance` nach innen und
 * schneidet die Kanten neu. Anders als ein prozentuales Schrumpfen entspricht
 * das genau der Breite des Kantensaums, den die Erkennung mitnimmt.
 */
export function insetQuad(quad: Quad, distance: number): Quad {
  if (distance <= 0) return quad;
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  // Kanten als Punkt-Richtungs-Paare, jeweils um distance nach innen versetzt.
  const lines = quad.map((a, i) => {
    const b = quad[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    // Normale zum Schwerpunkt hin ausrichten.
    if ((cx - a.x) * nx + (cy - a.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { x: a.x + nx * distance, y: a.y + ny * distance, dx, dy };
  });

  const corners: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    // Ecke i entsteht aus den Kanten (i-1) und i.
    const a = lines[(i + 3) % 4];
    const b = lines[i];
    const denom = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(denom) < 1e-9) return quad;
    const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / denom;
    corners.push({ x: a.x + a.dx * t, y: a.y + a.dy * t });
  }
  return corners as Quad;
}
