import { useCallback, useEffect, useRef, useState } from 'react';
import { frameFromVideo } from './canvas';
import { describeCameras } from './lenses';
import type { Camera } from './lenses';

export interface Range {
  min: number;
  max: number;
  step: number;
}

export interface CameraState {
  error: string | null;
  /** Die wählbaren Objektive der Rückseite. */
  cameras: Camera[];
  /** Gerät, das gerade läuft. */
  activeId: string | null;
  torchAvailable: boolean;
  torchOn: boolean;
  zoom: Range | null;
  zoomValue: number;
  focusModes: string[];
  focusMode: string | null;
  /** Auflösung, die die Kamera tatsächlich liefert. */
  resolution: { width: number; height: number } | null;
}

/** Was der Browser über eine Spur verrät – teils noch nicht in den Standardtypen. */
type ExtraCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  zoom?: Range;
  focusMode?: string[];
};
type ExtraSettings = MediaTrackSettings & { zoom?: number; focusMode?: string };

const EMPTY: CameraState = {
  error: null,
  cameras: [],
  activeId: null,
  torchAvailable: false,
  torchOn: false,
  zoom: null,
  zoomValue: 1,
  focusModes: [],
  focusMode: null,
  resolution: null,
};

function constraints(deviceId: string | null): MediaStreamConstraints {
  return {
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    audio: false,
  };
}

/**
 * Rückkamera öffnen und wieder freigeben. Der Stream wird bewusst an das
 * Video-Element gebunden statt an React-State, damit das Vorschaubild auch
 * beim Neuzeichnen nicht flackert.
 *
 * `deviceId` wählt das Objektiv. Ohne Angabe entscheidet der Browser – und der
 * greift auf manchen Geräten zum Ultraweitwinkel, das gerade Fotokanten
 * sichtbar krümmt.
 */
export function useCamera(active: boolean, deviceId: string | null = null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (!active) {
      setState(EMPTY);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({ ...EMPTY, error: 'Dieser Browser kann nicht auf die Kamera zugreifen.' });
      return;
    }

    navigator.mediaDevices
      .getUserMedia(constraints(deviceId))
      .then(async (stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const capabilities = (track?.getCapabilities?.() ?? {}) as ExtraCapabilities;
        const settings = (track?.getSettings?.() ?? {}) as ExtraSettings;

        // Erst nach erteilter Erlaubnis trägt die Geräteliste Namen.
        let cameras: Camera[] = [];
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          cameras = describeCameras(devices.filter((d) => d.kind === 'videoinput'));
        } catch {
          cameras = [];
        }
        if (cancelled) return;

        setState({
          error: null,
          cameras,
          activeId: settings.deviceId ?? deviceId,
          torchAvailable: Boolean(capabilities.torch),
          torchOn: false,
          zoom: capabilities.zoom ?? null,
          zoomValue: settings.zoom ?? capabilities.zoom?.min ?? 1,
          focusModes: capabilities.focusMode ?? [],
          focusMode: settings.focusMode ?? null,
          resolution:
            settings.width && settings.height ? { width: settings.width, height: settings.height } : null,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          ...EMPTY,
          error:
            error instanceof DOMException && error.name === 'NotAllowedError'
              ? 'Zugriff auf die Kamera wurde abgelehnt. Bitte in den Browsereinstellungen erlauben.'
              : 'Die Kamera konnte nicht geöffnet werden.',
        });
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [active, deviceId]);

  const attach = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    if (element && streamRef.current) {
      element.srcObject = streamRef.current;
      void element.play().catch(() => undefined);
    }
  }, []);

  /** Eine erweiterte Einstellung setzen; nicht jedes Gerät kann jede. */
  const apply = useCallback(async (advanced: Record<string, unknown>): Promise<boolean> => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return false;
    try {
      await track.applyConstraints({ advanced: [advanced] } as unknown as MediaTrackConstraints);
      return true;
    } catch {
      return false;
    }
  }, []);

  const toggleTorch = useCallback(async () => {
    const next = !state.torchOn;
    if (await apply({ torch: next })) setState((s) => ({ ...s, torchOn: next }));
    else setState((s) => ({ ...s, torchAvailable: false }));
  }, [apply, state.torchOn]);

  const setZoom = useCallback(
    async (value: number) => {
      setState((s) => ({ ...s, zoomValue: value }));
      await apply({ zoom: value });
    },
    [apply],
  );

  const setFocusMode = useCallback(
    async (mode: string) => {
      if (await apply({ focusMode: mode })) setState((s) => ({ ...s, focusMode: mode }));
    },
    [apply],
  );

  /** Einzelbild in voller Auflösung, begrenzt auf maxDim. */
  const capture = useCallback((maxDim: number): ImageData | null => {
    const video = videoRef.current;
    if (!video) return null;
    return frameFromVideo(video, maxDim);
  }, []);

  return { ...state, attach, toggleTorch, setZoom, setFocusMode, capture, videoRef };
}

/** Kurze Pause – für die Aufnahmereihe der Entspiegelung. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
