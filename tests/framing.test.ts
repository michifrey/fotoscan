import { describe, expect, it } from 'vitest';
import { framing, framingText } from '../src/lib/framing';
import { rectQuad } from './synth';

describe('Bildlage im Sucher', () => {
  it('meldet, wenn gar nichts erkannt ist', () => {
    expect(framing([], 480, 360, true)).toBe('leer');
    expect(framingText('leer', 0)).toContain('Kein Foto erkannt');
  });

  it('löst nicht aus, solange ein Foto bis an den Bildrand reicht', () => {
    // Sonst wird das angeschnittene Foto auch angeschnitten gespeichert – und
    // der Sucher schweigt dazu.
    const angeschnitten = rectQuad(-20, 60, 300, 220, 0);
    expect(framing([angeschnitten], 480, 360, true)).toBe('rand');
    expect(framingText('rand', 1)).toContain('weiter weg');
  });

  it('wartet auf eine ruhige Kamera', () => {
    const foto = rectQuad(90, 70, 300, 220, 0);
    expect(framing([foto], 480, 360, false)).toBe('unruhig');
    expect(framingText('unruhig', 1)).toContain('ruhig halten');
  });

  it('gilt als bereit, wenn alles im Bild liegt und ruhig ist', () => {
    const links = rectQuad(40, 60, 170, 220, 0);
    const rechts = rectQuad(260, 60, 170, 220, 0);
    expect(framing([links, rechts], 480, 360, true)).toBe('bereit');
    expect(framingText('bereit', 2)).toBe('2 Fotos erkannt');
    expect(framingText('bereit', 1)).toBe('1 Foto erkannt');
  });
});
