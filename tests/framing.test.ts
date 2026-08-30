import { describe, expect, it } from 'vitest';
import { framing, framingText } from '../src/lib/framing';
import type { Light } from '../src/lib/framing';
import type { Exposure } from '../src/lib/imaging/exposure';
import { rectQuad } from './synth';

const HELL: Exposure = { level: 150, clipped: 0 };
const DUNKEL: Exposure = { level: 30, clipped: 0 };

const KEIN_LICHT: Light = { available: false, on: false, automatic: false };
const LICHT_AUS: Light = { available: true, on: false, automatic: true };
const LICHT_AN: Light = { available: true, on: true, automatic: true };
const LICHT_VON_HAND: Light = { available: true, on: false, automatic: false };

describe('Bildlage im Sucher', () => {
  it('meldet, wenn gar nichts erkannt ist', () => {
    expect(framing([], 480, 360, true, HELL)).toBe('leer');
    expect(framingText('leer', LICHT_AUS)).toContain('Keine Albumseite erkannt');
  });

  it('löst nicht aus, solange ein Foto bis an den Bildrand reicht', () => {
    // Sonst wird das angeschnittene Foto auch abgeschnitten gespeichert – und
    // der Sucher schweigt dazu.
    const angeschnitten = rectQuad(-20, 60, 300, 220, 0);
    expect(framing([angeschnitten], 480, 360, true, HELL)).toBe('rand');
    expect(framingText('rand', LICHT_AUS)).toContain('weiter weg');
  });

  it('wartet auf eine ruhige Kamera', () => {
    const foto = rectQuad(90, 70, 300, 220, 0);
    expect(framing([foto], 480, 360, false, HELL)).toBe('unruhig');
    expect(framingText('unruhig', LICHT_AUS)).toContain('ruhig halten');
  });

  it('gilt als bereit, wenn alles im Bild liegt und ruhig ist', () => {
    const links = rectQuad(40, 60, 170, 220, 0);
    const rechts = rectQuad(260, 60, 170, 220, 0);
    expect(framing([links, rechts], 480, 360, true, HELL)).toBe('bereit');
    expect(framingText('bereit', LICHT_AUS)).toBe('Seite erkannt');
  });

  it('nennt die Dunkelheit zuerst', () => {
    // Im Dunkeln findet die Erkennung nichts – „kein Foto erkannt" wäre dann
    // der falsche Rat, denn es fehlt nicht am Bildausschnitt.
    const foto = rectQuad(90, 70, 300, 220, 0);
    expect(framing([], 480, 360, true, DUNKEL)).toBe('dunkel');
    expect(framing([foto], 480, 360, true, DUNKEL)).toBe('dunkel');
    expect(framing([foto], 480, 360, true, HELL)).toBe('bereit');
  });

  it('sagt bei Dunkelheit, was mit dem Licht geschieht', () => {
    expect(framingText('dunkel', KEIN_LICHT)).toContain('mehr Licht');
    expect(framingText('dunkel', LICHT_AUS)).toContain('wird zugeschaltet');
    expect(framingText('dunkel', LICHT_AN)).toContain('Licht ist an');
    // Ohne Automatik – beim Einzelbild oder nach einem Tipp auf die Taste –
    // wird nicht von selbst geschaltet, sondern darauf hingewiesen.
    expect(framingText('dunkel', LICHT_VON_HAND)).toContain('antippen');
  });
});
