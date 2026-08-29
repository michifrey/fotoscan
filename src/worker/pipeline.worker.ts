/// <reference lib="webworker" />
import { detectPhotoQuads } from '../lib/imaging/detect';
import { estimateMotion } from '../lib/imaging/motion';
import type { Motion } from '../lib/imaging/motion';
import { reanchor, startPose } from '../lib/imaging/pose';
import type { Pose } from '../lib/imaging/pose';
import { refinePhoto } from '../lib/imaging/closeup';
import { mergePhotos } from '../lib/imaging/stack';
import type { EnhanceOptions } from '../lib/imaging/enhance';
import type { Quad, RgbaImage } from '../lib/imaging/types';

export interface TransferImage {
  data: ArrayBuffer;
  width: number;
  height: number;
}

export type WorkerRequest =
  | { id: number; type: 'detect'; image: TransferImage; analysisSize?: number }
  | { id: number; type: 'merge'; frames: TransferImage[]; quads: Quad[] }
  | { id: number; type: 'motion'; previous: TransferImage; current: TransferImage }
  | { id: number; type: 'anchor'; overview: TransferImage; frame: TransferImage; guess: Pose | null }
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
  | { id: number; type: 'motion'; motion: Motion | null }
  | { id: number; type: 'anchor'; pose: Pose | null }
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

    // Beim Abfahren einer Seite: die Bewegung zwischen zwei Vorschaubildern
    // und das Nachverankern gegen die Übersicht. Beides gehört hierher, damit
    // der Sucher flüssig bleibt.
    if (request.type === 'motion') {
      const motion = estimateMotion(toRgba(request.previous), toRgba(request.current));
      const response: WorkerResponse = { id: request.id, type: 'motion', motion };
      self.postMessage(response);
      return;
    }

    if (request.type === 'anchor') {
      const overview = toRgba(request.overview);
      const frame = toRgba(request.frame);
      const pose = request.guess ? reanchor(overview, frame, request.guess) : startPose(overview, frame);
      const response: WorkerResponse = { id: request.id, type: 'anchor', pose };
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
