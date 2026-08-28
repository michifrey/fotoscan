import { describe, expect, it } from 'vitest';
import { classify, describeCameras, preferred } from '../src/lib/lenses';

describe('classify', () => {
  it('erkennt die Bezeichnungen von iOS', () => {
    expect(classify('Rückkamera')).toBe('haupt');
    expect(classify('Rück-Ultraweitwinkelkamera')).toBe('ultraweit');
    expect(classify('Rück-Telefotokamera')).toBe('tele');
    expect(classify('Rück-Doppelkamera')).toBe('haupt');
    expect(classify('Frontkamera')).toBe('front');
  });

  it('erkennt englische Bezeichnungen', () => {
    expect(classify('Back Camera')).toBe('haupt');
    expect(classify('Back Ultra Wide Camera')).toBe('ultraweit');
    expect(classify('Back Telephoto Camera')).toBe('tele');
    expect(classify('Front Camera')).toBe('front');
  });

  it('lässt sich von „Rück" nicht vom Ultraweitwinkel ablenken', () => {
    // Beide Wörter stecken drin; das Ultraweitwinkel ist die genauere Aussage.
    expect(classify('Rück-Ultraweitwinkelkamera')).not.toBe('haupt');
  });

  it('erkennt einen Zoomfaktor als Teleobjektiv, nicht 0,5x als solches', () => {
    expect(classify('camera 3x zoom')).toBe('tele');
    expect(classify('0.5x back camera')).toBe('ultraweit');
  });
});

describe('describeCameras', () => {
  it('lässt Frontkameras weg', () => {
    const list = describeCameras([
      { deviceId: 'a', label: 'Back Camera' },
      { deviceId: 'b', label: 'Front Camera' },
    ]);
    expect(list.map((c) => c.deviceId)).toEqual(['a']);
  });

  it('deutet die Nummern von Android', () => {
    const list = describeCameras([
      { deviceId: 'a', label: 'camera2 0, facing back' },
      { deviceId: 'b', label: 'camera2 2, facing back' },
    ]);
    expect(list[0].kind).toBe('haupt');
    expect(list[0].name).toBe('Hauptkamera');
    // Nummer 2 ist irgendein weiteres Objektiv – ehrlicher ist ein neutraler Name.
    expect(list[1].kind).toBe('unbekannt');
    expect(list[1].name).toBe('Kamera 1');
  });

  it('nummeriert namenlose Kameras fortlaufend', () => {
    const list = describeCameras([
      { deviceId: 'a', label: '' },
      { deviceId: 'b', label: '' },
    ]);
    expect(list.map((c) => c.name)).toEqual(['Kamera 1', 'Kamera 2']);
  });
});

describe('preferred', () => {
  it('nimmt die Hauptkamera, nicht das Ultraweitwinkel', () => {
    const list = describeCameras([
      { deviceId: 'u', label: 'Back Ultra Wide Camera' },
      { deviceId: 'h', label: 'Back Camera' },
      { deviceId: 't', label: 'Back Telephoto Camera' },
    ]);
    expect(preferred(list)?.deviceId).toBe('h');
  });

  it('greift auf das Teleobjektiv zurück, wenn es nur Ultraweitwinkel und Tele gibt', () => {
    const list = describeCameras([
      { deviceId: 'u', label: 'Back Ultra Wide Camera' },
      { deviceId: 't', label: 'Back Telephoto Camera' },
    ]);
    expect(preferred(list)?.deviceId).toBe('t');
  });

  it('gibt null zurück, wenn keine Kamera da ist', () => {
    expect(preferred([])).toBeNull();
  });
});
