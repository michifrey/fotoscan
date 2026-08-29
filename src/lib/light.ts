import { useCallback, useRef, useState } from 'react';
import { brightEnough, tooDark } from './imaging/exposure';
import type { Exposure } from './imaging/exposure';
import type { Light } from './framing';

/** So viele Vorschaubilder hintereinander müssen dunkel sein, bevor es angeht. */
const FRAMES = 3;

/** Und so lange bleibt es danach mindestens, wie es ist. */
const HOLD = 2500;

/** Was der Kamera-Hook vom Licht hergibt. */
export interface Torch {
  torchAvailable: boolean;
  torchOn: boolean;
  setTorch: (on: boolean) => Promise<void>;
}

/**
 * Schaltet das Licht der Kamera zu, wenn das Motiv zu dunkel wird.
 *
 * Zwei Vorkehrungen gegen Flackern, und beide sind nötig: Es wird erst nach
 * mehreren dunklen Vorschaubildern geschaltet, denn ein einzelnes verwackeltes
 * ist immer zu dunkel. Und danach eine Weile gar nicht mehr, denn das
 * eingeschaltete Licht hebt die eigene Messung sofort wieder über die
 * Schwelle – ohne Sperre ginge es im Sekundentakt an und aus.
 *
 * Wieder ausgeschaltet wird nur, was die App selbst eingeschaltet hat. Wer es
 * von Hand anmacht, will es anhaben.
 *
 * `allowed` entscheidet, ob überhaupt von selbst geschaltet werden darf. Das
 * Licht wirft seinen eigenen Glanz auf den Abzug; das ist nur dort in Ordnung,
 * wo er hinterher wieder herausgerechnet wird.
 */
export function useAutoLight(torch: Torch, allowed: boolean) {
  const [automatic, setAutomatic] = useState(true);
  const darkFrames = useRef(0);
  const brightFrames = useRef(0);
  const changed = useRef(0);
  const litByApp = useRef(false);

  const light: Light = {
    available: torch.torchAvailable,
    on: torch.torchOn,
    automatic: automatic && allowed,
  };

  const state = useRef(light);
  state.current = light;
  const setTorch = torch.setTorch;

  /** Für jedes Vorschaubild einmal aufrufen. */
  const measure = useCallback(
    (exposure: Exposure) => {
      const now = state.current;
      darkFrames.current = tooDark(exposure) ? darkFrames.current + 1 : 0;
      brightFrames.current = brightEnough(exposure) ? brightFrames.current + 1 : 0;
      if (!now.available || Date.now() - changed.current < HOLD) return;

      if (!now.on && now.automatic && darkFrames.current >= FRAMES) {
        changed.current = Date.now();
        litByApp.current = true;
        void setTorch(true);
        return;
      }
      if (now.on && litByApp.current && brightFrames.current >= FRAMES) {
        changed.current = Date.now();
        litByApp.current = false;
        void setTorch(false);
      }
    },
    [setTorch],
  );

  /** Der Nutzer hat die Lichttaste angetippt – ab jetzt entscheidet er. */
  const takeOver = useCallback(() => {
    setAutomatic(false);
    litByApp.current = false;
    changed.current = Date.now();
    void setTorch(!state.current.on);
  }, [setTorch]);

  return { light, measure, takeOver };
}
