import type { GrayImage } from './types';

export interface Mask {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Sobel-Gradientenbetrag, auf 0..255 begrenzt. */
export function gradientMagnitude(src: GrayImage): Uint16Array {
  const { data, width, height } = src;
  const out = new Uint16Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = data[i - width - 1];
      const t = data[i - width];
      const tr = data[i - width + 1];
      const l = data[i - 1];
      const r = data[i + 1];
      const bl = data[i + width - 1];
      const b = data[i + width];
      const br = data[i + width + 1];
      const gx = tr + 2 * r + br - (tl + 2 * l + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      out[i] = Math.abs(gx) + Math.abs(gy);
    }
  }
  return out;
}

/**
 * Behält die stärksten Gradienten. Der Schwellwert ergibt sich aus einem
 * Histogramm-Perzentil, damit die Erkennung bei hellen wie dunklen
 * Albumseiten gleich gut greift.
 */
export function thresholdTopFraction(mag: Uint16Array, width: number, height: number, fraction: number): Mask {
  const hist = new Uint32Array(1024);
  for (let i = 0; i < mag.length; i++) hist[Math.min(1023, mag[i] >> 2)]++;

  const target = Math.floor(mag.length * fraction);
  let seen = 0;
  let bucket = 1023;
  for (let b = 1023; b >= 0; b--) {
    seen += hist[b];
    if (seen >= target) {
      bucket = b;
      break;
    }
  }
  // Untergrenze, damit in einem völlig flachen Bild nicht Rauschen zur Kante wird.
  const threshold = Math.max(bucket << 2, 24);

  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = mag[i] >= threshold ? 1 : 0;
  return { data, width, height };
}

function morph(mask: Mask, radius: number, dilate: boolean): Mask {
  const { width, height } = mask;
  const hit = dilate ? 1 : 0;
  const tmp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let found = dilate ? 0 : 1;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= width) continue;
        if (mask.data[row + xx] === hit) {
          found = hit;
          break;
        }
      }
      tmp[row + x] = found;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let found = dilate ? 0 : 1;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= height) continue;
        if (tmp[yy * width + x] === hit) {
          found = hit;
          break;
        }
      }
      out[y * width + x] = found;
    }
  }
  return { data: out, width, height };
}

export const dilate = (mask: Mask, radius: number): Mask => morph(mask, radius, true);
export const erode = (mask: Mask, radius: number): Mask => morph(mask, radius, false);

/** Schliessen: Lücken in Kantenzügen füllen, ohne die Kontur zu verdicken. */
export function close(mask: Mask, radius: number): Mask {
  return erode(dilate(mask, radius), radius);
}

/**
 * Alles, was vom Bildrand aus über Nicht-Kanten-Pixel erreichbar ist, gilt als
 * Hintergrund. Übrig bleiben Flächen, die von einem geschlossenen Kantenzug
 * umgeben sind – genau das sind die Fotos auf der Albumseite.
 */
export function fillFromBorder(mask: Mask): Mask {
  const { data, width, height } = mask;
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;

  const push = (i: number) => {
    if (visited[i] || data[i]) return;
    visited[i] = 1;
    stack[top++] = i;
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }

  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = visited[i] ? 0 : 1;
  return { data: out, width, height };
}

export interface Component {
  label: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LabelResult {
  labels: Int32Array;
  components: Component[];
}

/** Zusammenhangskomponenten (4er-Nachbarschaft) der gesetzten Pixel. */
export function connectedComponents(mask: Mask): LabelResult {
  const { data, width, height } = mask;
  const labels = new Int32Array(width * height).fill(-1);
  const components: Component[] = [];
  const stack = new Int32Array(width * height);

  for (let start = 0; start < data.length; start++) {
    if (!data[start] || labels[start] >= 0) continue;
    const label = components.length;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    const comp: Component = {
      label,
      area: 0,
      minX: width,
      minY: height,
      maxX: 0,
      maxY: 0,
    };

    while (top > 0) {
      const i = stack[--top];
      const x = i % width;
      const y = (i / width) | 0;
      comp.area++;
      if (x < comp.minX) comp.minX = x;
      if (x > comp.maxX) comp.maxX = x;
      if (y < comp.minY) comp.minY = y;
      if (y > comp.maxY) comp.maxY = y;

      if (x > 0 && data[i - 1] && labels[i - 1] < 0) {
        labels[i - 1] = label;
        stack[top++] = i - 1;
      }
      if (x < width - 1 && data[i + 1] && labels[i + 1] < 0) {
        labels[i + 1] = label;
        stack[top++] = i + 1;
      }
      if (y > 0 && data[i - width] && labels[i - width] < 0) {
        labels[i - width] = label;
        stack[top++] = i - width;
      }
      if (y < height - 1 && data[i + width] && labels[i + width] < 0) {
        labels[i + width] = label;
        stack[top++] = i + width;
      }
    }
    components.push(comp);
  }

  return { labels, components };
}

/** Randpixel einer Komponente – reicht als Eingabe für die konvexe Hülle. */
export function componentBoundary(labels: Int32Array, width: number, height: number, comp: Component): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let y = comp.minY; y <= comp.maxY; y++) {
    for (let x = comp.minX; x <= comp.maxX; x++) {
      const i = y * width + x;
      if (labels[i] !== comp.label) continue;
      const edge =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        labels[i - 1] !== comp.label ||
        labels[i + 1] !== comp.label ||
        labels[i - width] !== comp.label ||
        labels[i + width] !== comp.label;
      if (edge) pts.push({ x, y });
    }
  }
  return pts;
}
