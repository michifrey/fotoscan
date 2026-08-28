/** Ein Punkt in Bildkoordinaten (x nach rechts, y nach unten). */
export interface Pt {
  x: number;
  y: number;
}

/** Viereck, immer im Uhrzeigersinn ab oben links: TL, TR, BR, BL. */
export type Quad = [Pt, Pt, Pt, Pt];

/** Einkanaliges Graubild. */
export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Minimale Teilmenge von ImageData, damit die Pipeline auch in Node läuft. */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function createRgba(width: number, height: number): RgbaImage {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}
