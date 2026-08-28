import type { Camera } from '../lib/lenses';
import type { Range } from '../lib/camera';
import { Button } from './ui';

const FOCUS_NAMES: Record<string, string> = {
  continuous: 'Fortlaufend',
  'single-shot': 'Einmalig',
  manual: 'Manuell',
  none: 'Aus',
};

interface Props {
  cameras: Camera[];
  activeId: string | null;
  zoom: Range | null;
  zoomValue: number;
  focusModes: string[];
  focusMode: string | null;
  resolution: { width: number; height: number } | null;
  onPick: (deviceId: string) => void;
  onZoom: (value: number) => void;
  onFocus: (mode: string) => void;
  onClose: () => void;
}

/**
 * Kameraeinstellungen. Der wichtigste Punkt ist die Objektivwahl: Überlässt
 * man die Wahl dem Browser, greift er auf manchen Geräten zum
 * Ultraweitwinkel – und das biegt gerade Fotokanten sichtbar krumm.
 */
export function CameraSettings({
  cameras,
  activeId,
  zoom,
  zoomValue,
  focusModes,
  focusMode,
  resolution,
  onPick,
  onZoom,
  onFocus,
  onClose,
}: Props) {
  const usableFocus = focusModes.filter((mode) => mode !== 'none');

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div
        className="max-h-full overflow-y-auto rounded-t-2xl border-t border-white/10 bg-stone-950 px-5 pt-4 pb-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Kameraeinstellungen"
        data-testid="camera-settings"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />

        <p className="mb-2 text-xs font-medium tracking-wide text-stone-400 uppercase">Objektiv</p>
        {cameras.length <= 1 ? (
          <p className="mb-4 text-sm text-stone-400">
            Dieses Gerät meldet nur eine Kamera. Mehr gibt es hier nicht zu wählen.
          </p>
        ) : (
          <ul className="mb-5 space-y-2">
            {cameras.map((camera) => {
              const active = camera.deviceId === activeId;
              return (
                <li key={camera.deviceId}>
                  <button
                    type="button"
                    onClick={() => onPick(camera.deviceId)}
                    data-testid={`lens-${camera.kind}`}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition ${
                      active ? 'border-amber-400 bg-amber-400/10' : 'border-white/10 bg-white/5 hover:bg-white/10'
                    }`}
                  >
                    <span>
                      <span className="block text-sm text-stone-100">{camera.name}</span>
                      {camera.kind === 'ultraweit' && (
                        <span className="block text-xs text-stone-400">Verzeichnet stark – zum Scannen ungeeignet</span>
                      )}
                      {camera.kind === 'haupt' && (
                        <span className="block text-xs text-stone-400">Beste Wahl für Albumseiten</span>
                      )}
                    </span>
                    {active && (
                      <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M5 12.5l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {zoom && zoom.max > zoom.min && (
          <div className="mb-5">
            <div className="mb-2 flex items-baseline justify-between">
              <p className="text-xs font-medium tracking-wide text-stone-400 uppercase">Zoom</p>
              <p className="text-xs text-stone-400">{zoomValue.toFixed(1)}×</p>
            </div>
            <input
              type="range"
              min={zoom.min}
              max={zoom.max}
              step={zoom.step || 0.1}
              value={zoomValue}
              onChange={(event) => onZoom(Number(event.target.value))}
              aria-label="Zoom"
              className="w-full accent-amber-400"
            />
            <p className="mt-1 text-xs text-stone-500">
              Näher heranzugehen bringt mehr als zu zoomen – der Zoom schneidet nur aus.
            </p>
          </div>
        )}

        {usableFocus.length > 1 && (
          <div className="mb-5">
            <p className="mb-2 text-xs font-medium tracking-wide text-stone-400 uppercase">Fokus</p>
            <div className="flex flex-wrap gap-2">
              {usableFocus.map((mode) => (
                <Button
                  key={mode}
                  variant={focusMode === mode ? 'primary' : 'ghost'}
                  onClick={() => onFocus(mode)}
                  className="rounded-full px-3 py-1.5 text-xs"
                >
                  {FOCUS_NAMES[mode] ?? mode}
                </Button>
              ))}
            </div>
          </div>
        )}

        {resolution && (
          <p className="mb-5 text-xs text-stone-500">
            Aufnahme: {resolution.width} × {resolution.height} Bildpunkte
          </p>
        )}

        <Button variant="primary" onClick={onClose} className="w-full" data-testid="settings-close">
          Fertig
        </Button>
      </div>
    </div>
  );
}

/** Schieberegler – als Zahnrad gezeichnet liest sich das Symbol wie eine Sonne. */
export function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </svg>
  );
}
