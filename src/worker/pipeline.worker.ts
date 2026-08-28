/// <reference lib="webworker" />
import { detectPhotoQuads } from '../lib/imaging/detect';
import { mergeFrames } from '../lib/imaging/destack';
import { enhance } from '../lib/imaging/enhance';
import type { EnhanceOptions } from '../lib/imaging/enhance';
import { outputSize, rotate, warpPerspective } from '../lib/imaging/warp';
import type { Quad, RgbaImage } from '../lib/imaging/types';

export interface TransferImage {
  data: ArrayBuffer;
  width: number;
  height: number;
}

export type WorkerRequest =
  | { id: number; type: 'detect'; image: TransferImage; analysisSize?: number }
  | {
      id: number;
      type: 'extract';
      frames: TransferImage[];
      quads: Quad[];
      options: EnhanceOptions;
      rotation: number;
    };

export type WorkerResponse =
  | { id: number; type: 'detect'; quads: Quad[] }
  | { id: number; type: 'extract'; images: TransferImage[] }
  | { id: number; type: 'error'; message: string };

function toRgba(image: TransferImage): RgbaImage {
  return { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
}

function toTransfer(img: RgbaImage): TransferImage {
  const copy = new Uint8ClampedArray(img.data);
  return { data: copy.buffer, width: img.width, height: img.height };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'detect') {
      const quads = detectPhotoQuads(toRgba(request.image), { analysisSize: request.analysisSize });
      const response: WorkerResponse = { id: request.id, type: 'detect', quads };
      self.postMessage(response);
      return;
    }

    const frames = request.frames.map(toRgba);
    const images: TransferImage[] = [];

    for (const quad of request.quads) {
      const size = outputSize(quad);
      // Jede Aufnahme wird einzeln auf dieselbe Zielfläche entzerrt; erst
      // danach lassen sich die Aufnahmen sinnvoll verrechnen.
      const warped = frames.map((frame) => warpPerspective(frame, quad, size.width, size.height));
      const merged = warped.length > 1 ? mergeFrames(warped) : warped[0];
      const improved = enhance(merged, request.options);
      images.push(toTransfer(rotate(improved, request.rotation)));
    }

    const response: WorkerResponse = { id: request.id, type: 'extract', images };
    self.postMessage(
      response,
      images.map((image) => image.data),
    );
  } catch (error) {
    const response: WorkerResponse = {
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
