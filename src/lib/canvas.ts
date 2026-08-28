import type { RgbaImage } from './imaging/types';

/** Zeichnet ein Bild in ein Canvas und liest es als Pixeldaten zurück. */
export function drawToImageData(source: CanvasImageSource, width: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas wird nicht unterstützt');
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** Aktuelles Videobild als Pixeldaten, optional herunterskaliert. */
export function frameFromVideo(video: HTMLVideoElement, maxDim?: number): ImageData | null {
  const sw = video.videoWidth;
  const sh = video.videoHeight;
  if (!sw || !sh) return null;
  const factor = maxDim ? Math.min(1, maxDim / Math.max(sw, sh)) : 1;
  return drawToImageData(video, Math.round(sw * factor), Math.round(sh * factor));
}

export async function imageDataFromBlob(blob: Blob, maxDim = 4096): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  try {
    const factor = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    return drawToImageData(bitmap, Math.round(bitmap.width * factor), Math.round(bitmap.height * factor));
  } finally {
    bitmap.close();
  }
}

export function toImageData(img: RgbaImage): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

export function blobFromImageData(img: RgbaImage, quality = 0.92): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas wird nicht unterstützt');
  ctx.putImageData(toImageData(img), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Bild konnte nicht gespeichert werden'))),
      'image/jpeg',
      quality,
    );
  });
}

export function objectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}
