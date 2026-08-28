import { useCallback, useEffect, useRef, useState } from 'react';
import { frameFromVideo } from './canvas';

export interface CameraState {
  stream: MediaStream | null;
  error: string | null;
  torchAvailable: boolean;
  torchOn: boolean;
}

const CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 3840 },
    height: { ideal: 2160 },
  },
  audio: false,
};

/**
 * Rückkamera öffnen und wieder freigeben. Der Stream wird bewusst an das
 * Video-Element gebunden statt an React-State, damit das Vorschaubild auch
 * beim Neuzeichnen nicht flackert.
 */
export function useCamera(active: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>({
    stream: null,
    error: null,
    torchAvailable: false,
    torchOn: false,
  });

  useEffect(() => {
    let cancelled = false;

    if (!active) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setState({ stream: null, error: null, torchAvailable: false, torchOn: false });
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setState((s) => ({ ...s, error: 'Dieser Browser kann nicht auf die Kamera zugreifen.' }));
      return;
    }

    navigator.mediaDevices
      .getUserMedia(CONSTRAINTS)
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
        setState({ stream, error: null, torchAvailable: Boolean(capabilities.torch), torchOn: false });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          stream: null,
          error:
            error instanceof DOMException && error.name === 'NotAllowedError'
              ? 'Zugriff auf die Kamera wurde abgelehnt. Bitte in den Browsereinstellungen erlauben.'
              : 'Die Kamera konnte nicht geöffnet werden.',
          torchAvailable: false,
          torchOn: false,
        });
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [active]);

  const attach = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    if (element && streamRef.current) {
      element.srcObject = streamRef.current;
      void element.play().catch(() => undefined);
    }
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !state.torchOn;
    try {
      // `torch` steht (noch) nicht in den Standardtypen, wird aber von Android-Browsern unterstützt.
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setState((s) => ({ ...s, torchOn: next }));
    } catch {
      setState((s) => ({ ...s, torchAvailable: false }));
    }
  }, [state.torchOn]);

  /** Einzelbild in voller Auflösung, begrenzt auf maxDim. */
  const capture = useCallback((maxDim: number): ImageData | null => {
    const video = videoRef.current;
    if (!video) return null;
    return frameFromVideo(video, maxDim);
  }, []);

  return { ...state, attach, toggleTorch, capture, videoRef };
}

/** Kurze Pause – für die Aufnahmereihe der Entspiegelung. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
