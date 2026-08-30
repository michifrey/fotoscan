/// <reference lib="webworker" />
import { detectAt, detectPage, detectPhotoQuads, detectPhotosOnPage } from '../lib/imaging/detect';
import { refinePhoto } from '../lib/imaging/closeup';
import { locate } from '../lib/imaging/locate';
import { mergePhotos } from '../lib/imaging/stack';
import type { EnhanceOptions } from '../lib/imaging/enhance';
import type { Pt, Quad, RgbaImage } from '../lib/imaging/types';

export interface TransferImage {
  data: ArrayBuffer;
  width: number;
  height: number;
}

export type WorkerRequest =
  | { id: number; type: 'detect'; image: TransferImage; analysisSize?: number }
  | { id: number; type: 'merge'; frames: TransferImage[]; quads: Quad[] }
  | { id: number; type: 'page'; image: TransferImage; analysisSize?: number }
  | { id: number; type: 'photos'; page: TransferImage }
  | { id: number; type: 'spot'; page: TransferImage; point: Pt }
  | { id: number; type: 'locate'; reference: TransferImage; frame: TransferImage }
  | {
      id: number;
      type: 'refine';
      reference: TransferImage;
      closeup: TransferImage | null;
      quad: Quad | null;
      options: EnhanceOptions;
      rotation: number;
    };

export type WorkerResponse =
  | { id: number; type: 'detect'; quads: Quad[] }
  | { id: number; type: 'merge'; images: TransferImage[] }
  | { id: number; type: 'page'; page: Quad | null }
  | { id: number; type: 'photos'; quads: Quad[] }
  | { id: number; type: 'spot'; quad: Quad | null }
  | { id: number; type: 'locate'; quad: Quad | null }
  | { id: number; type: 'refine'; image: TransferImage }
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

    if (request.type === 'merge') {
      const images = mergePhotos(request.frames.map(toRgba), request.quads).map(toTransfer);
      const response: WorkerResponse = { id: request.id, type: 'merge', images };
      self.postMessage(
        response,
        images.map((image) => image.data),
      );
      return;
    }

    // Die beiden Stufen der Erfassung und das, was dazwischen von Hand
    // nachgeholfen wird. Alles hierher, damit der Sucher flüssig bleibt und
    // ein Tipp sofort antwortet.
    if (request.type === 'page') {
      const page = detectPage(toRgba(request.image), { analysisSize: request.analysisSize });
      const response: WorkerResponse = { id: request.id, type: 'page', page };
      self.postMessage(response);
      return;
    }

    if (request.type === 'photos') {
      const quads = detectPhotosOnPage(toRgba(request.page));
      const response: WorkerResponse = { id: request.id, type: 'photos', quads };
      self.postMessage(response);
      return;
    }

    if (request.type === 'spot') {
      const quad = detectAt(toRgba(request.page), request.point);
      const response: WorkerResponse = { id: request.id, type: 'spot', quad };
      self.postMessage(response);
      return;
    }

    if (request.type === 'locate') {
      const quad = locate(toRgba(request.reference), toRgba(request.frame));
      const response: WorkerResponse = { id: request.id, type: 'locate', quad };
      self.postMessage(response);
      return;
    }

    // Ab hier nur noch `refine`. Die Verengung braucht das ausdrückliche `if`,
    // seit es mehr als drei Auftragsarten gibt.
    if (request.type !== 'refine') return;

    const closeup =
      request.closeup && request.quad ? { image: toRgba(request.closeup), quad: request.quad } : null;
    const image = toTransfer(
      refinePhoto(toRgba(request.reference), closeup, request.options, request.rotation),
    );
    const response: WorkerResponse = { id: request.id, type: 'refine', image };
    self.postMessage(response, [image.data]);
  } catch (error) {
    const response: WorkerResponse = {
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
