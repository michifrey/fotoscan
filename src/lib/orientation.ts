import { useCallback, useEffect, useRef, useState } from 'react';

/** Neigung in Grad, die einer vollen Auslenkung zum Zielpunkt entspricht. */
const RANGE_DEGREES = 11;

export interface Tilt {
  x: number;
  y: number;
}

type PermissionCapableEvent = {
  requestPermission?: () => Promise<string>;
};

export function orientationSupported(): boolean {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
}

/**
 * iOS verlangt für den Lagesensor eine ausdrückliche Erlaubnis, und zwar aus
 * einer Nutzeraktion heraus. Andere Browser liefern die Werte ohne Nachfrage.
 */
export async function requestOrientationAccess(): Promise<boolean> {
  if (!orientationSupported()) return false;
  const event = DeviceOrientationEvent as unknown as PermissionCapableEvent;
  if (typeof event.requestPermission === 'function') {
    try {
      return (await event.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Neigung des Telefons gegenüber der Haltung beim Start, umgerechnet auf
 * -1 … 1 je Achse. Die Werte werden pro Bildwiederholung übernommen, damit der
 * Sensor mit seinen 60 Hz nicht ebenso viele Neuzeichnungen auslöst.
 */
export function useTilt(active: boolean) {
  const [tilt, setTilt] = useState<Tilt>({ x: 0, y: 0 });
  const [receiving, setReceiving] = useState(false);
  const reference = useRef<{ beta: number; gamma: number } | null>(null);
  const latest = useRef<Tilt>({ x: 0, y: 0 });
  const seen = useRef(false);

  useEffect(() => {
    if (!active || !orientationSupported()) {
      reference.current = null;
      seen.current = false;
      setTilt({ x: 0, y: 0 });
      setReceiving(false);
      return;
    }

    const handle = (event: DeviceOrientationEvent) => {
      if (event.beta === null || event.gamma === null) return;
      if (!reference.current) reference.current = { beta: event.beta, gamma: event.gamma };
      seen.current = true;
      latest.current = {
        x: clamp((event.gamma - reference.current.gamma) / RANGE_DEGREES, -1.8, 1.8),
        y: clamp((event.beta - reference.current.beta) / RANGE_DEGREES, -1.8, 1.8),
      };
    };

    let frame = 0;
    const tick = () => {
      setTilt((current) =>
        Math.abs(current.x - latest.current.x) < 0.004 && Math.abs(current.y - latest.current.y) < 0.004
          ? current
          : latest.current,
      );
      if (seen.current) setReceiving(true);
      frame = requestAnimationFrame(tick);
    };

    window.addEventListener('deviceorientation', handle);
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('deviceorientation', handle);
      cancelAnimationFrame(frame);
    };
  }, [active]);

  const reset = useCallback(() => {
    reference.current = null;
    seen.current = false;
    latest.current = { x: 0, y: 0 };
    setTilt({ x: 0, y: 0 });
  }, []);

  return { tilt, receiving, reset };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
