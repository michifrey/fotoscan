export type LensKind = 'ultraweit' | 'haupt' | 'tele' | 'front' | 'unbekannt';

export interface Camera {
  deviceId: string;
  /** Bezeichnung, wie sie der Browser liefert. */
  label: string;
  /** Verständlicher Name für die Auswahl. */
  name: string;
  kind: LensKind;
}

const FRONT = /\b(front|vorder|user|selfie|face)/i;
const ULTRA = /(ultra|0[.,]5\s*x|super[- ]?wide|weitwinkel.*ultra)/i;
const TELE = /(tele|[2-9]([.,]\d)?\s*x\b)/i;
const BACK = /\b(back|rück|ruck|rear|haupt|wide|weitwinkel|dual|doppel|triple|dreifach)/i;
const ANDROID_INDEX = /camera\s*2?\s*(\d+)/i;

/**
 * Ordnet eine Kamera anhand ihrer Bezeichnung ein.
 *
 * Die Reihenfolge ist wichtig: „Rück-Ultraweitwinkelkamera" enthält beides,
 * und das Ultraweitwinkel ist die genauere Aussage.
 */
export function classify(label: string): LensKind {
  if (FRONT.test(label)) return 'front';
  if (ULTRA.test(label)) return 'ultraweit';
  if (TELE.test(label)) return 'tele';
  if (BACK.test(label)) return 'haupt';
  return 'unbekannt';
}

const NAMES: Record<LensKind, string> = {
  ultraweit: 'Ultraweitwinkel',
  haupt: 'Hauptkamera',
  tele: 'Teleobjektiv',
  front: 'Frontkamera',
  unbekannt: 'Kamera',
};

/**
 * Macht aus den Geräten des Browsers eine Auswahlliste. Fronkameras fallen
 * weg – zum Abfotografieren eines Albums taugen sie nicht.
 *
 * Android nennt seine Kameras oft nur „camera2 0, facing back". Dort hilft die
 * Nummer weiter: Die 0 ist auf so gut wie jedem Gerät die Hauptkamera.
 */
export function describeCameras(devices: { deviceId: string; label: string }[]): Camera[] {
  const back = devices.filter((device) => classify(device.label) !== 'front');
  let unnamed = 0;

  return back.map((device) => {
    let kind = classify(device.label);
    const index = ANDROID_INDEX.exec(device.label);
    if (kind === 'haupt' && index && index[1] !== '0') kind = 'unbekannt';
    if (kind === 'unbekannt' && index && index[1] === '0') kind = 'haupt';

    const name = kind === 'unbekannt' ? `${NAMES.unbekannt} ${++unnamed}` : NAMES[kind];
    return { deviceId: device.deviceId, label: device.label, name, kind };
  });
}

/**
 * Voreinstellung: die Hauptkamera. Sie hat die beste Auflösung und verzeichnet
 * am wenigsten – ein Ultraweitwinkel biegt gerade Fotokanten sichtbar krumm.
 */
export function preferred(cameras: Camera[]): Camera | null {
  return (
    cameras.find((c) => c.kind === 'haupt') ??
    cameras.find((c) => c.kind === 'unbekannt') ??
    cameras.find((c) => c.kind === 'tele') ??
    cameras[0] ??
    null
  );
}

const STORAGE_KEY = 'fotoscan:kamera';

export function rememberCamera(deviceId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, deviceId);
  } catch {
    // Privater Modus oder gesperrter Speicher – dann eben ohne Merken.
  }
}

export function rememberedCamera(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
