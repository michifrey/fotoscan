import { describe, expect, it } from 'vitest';
import { complete, coverageFor, nextGap, progress, record, settled, worthTaking } from '../src/lib/coverage';
import type { Coverage } from '../src/lib/coverage';
import type { Quad } from '../src/lib/imaging/types';
import { rectQuad } from './synth';

/** Zwei Fotos auf einer 800 × 600 grossen Übersicht. */
const LINKS: Quad = rectQuad(60, 80, 300, 220, 0);
const RECHTS: Quad = rectQuad(430, 300, 300, 220, 0);
const TARGET = 2.5;

function fresh(): Coverage {
  return coverageFor([LINKS, RECHTS], 800, 600, TARGET);
}

/** Der Ausschnitt, den die Kamera an einer Stelle sieht. */
function view(x: number, y: number, w = 240, h = 180): Quad {
  return rectQuad(x, y, w, h, 0);
}

describe('Deckung des Blattes', () => {
  it('verlangt nur, wo Fotos liegen', () => {
    // Blankes Albumpapier in Nahaufnahme braucht niemand – und es liesse sich
    // mangels Struktur nicht einmal wiederfinden.
    const coverage = fresh();
    const { needed } = progress(coverage);

    expect(needed).toBeGreaterThan(20);
    expect(needed).toBeLessThan(coverage.cells.length * 0.5);
    expect(coverage.cells.filter((cell) => cell.needed).length).toBe(needed);
  });

  it('hakt eine Stelle ab, sobald sie scharf genug getroffen ist', () => {
    let coverage = fresh();
    const before = progress(coverage);
    coverage = record(coverage, view(60, 80), TARGET, false);
    const after = progress(coverage);

    expect(before.done).toBe(0);
    expect(after.done).toBeGreaterThan(0);
    expect(after.needed).toBe(before.needed);
  });

  it('lässt eine zu grob getroffene Stelle offen', () => {
    // Wer nicht näher herangeht, bringt keine Auflösung mit. Die Karte darf
    // das nicht als erledigt verbuchen, sonst ist am Ende nichts gewonnen.
    let coverage = fresh();
    coverage = record(coverage, view(60, 80), TARGET * 0.6, false);
    expect(progress(coverage).done).toBe(0);
  });

  it('verlangt über Glanz einen zweiten Blickwinkel', () => {
    let coverage = fresh();
    coverage = record(coverage, view(60, 80), TARGET, true);
    const once = progress(coverage).done;

    // Noch einmal von fast derselben Stelle: Derselbe Glanz, kein Gewinn.
    coverage = record(coverage, view(64, 83), TARGET, true);
    expect(progress(coverage).done).toBe(once);

    // Und nun aus deutlich anderer Richtung.
    coverage = record(coverage, view(160, 140), TARGET, true);
    expect(progress(coverage).done).toBeGreaterThan(once);
  });

  it('verlangt ohne Glanz keinen zweiten Durchgang', () => {
    // Die Gegenprobe: Überall zweimal abzufahren wäre die doppelte Mühe für
    // nichts. Wo nichts glänzt, genügt ein Durchgang.
    let coverage = fresh();
    coverage = record(coverage, view(60, 80), TARGET, false);
    const cells = coverage.cells.filter((cell) => cell.needed && cell.detail >= TARGET);

    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((cell) => settled(cell, TARGET))).toBe(true);
  });

  it('rät von einer Aufnahme ab, die nichts beiträgt', () => {
    let coverage = fresh();
    // Auf offenem Feld und scharf genug: lohnt sich.
    expect(worthTaking(coverage, view(60, 80), TARGET)).toBe(true);
    // Zu grob: bringt nichts, egal wo.
    expect(worthTaking(coverage, view(60, 80), TARGET * 0.5)).toBe(false);
    // Über blankem Papier: dort wird nichts gebraucht.
    expect(worthTaking(coverage, view(380, 20, 60, 50), TARGET)).toBe(false);

    // Und nachdem die Stelle abgehakt ist, lohnt sie sich nicht mehr.
    coverage = record(coverage, view(60, 80), TARGET, false);
    expect(worthTaking(coverage, view(60, 80), TARGET)).toBe(false);
  });

  it('weist den Weg zu dem, was noch fehlt', () => {
    let coverage = fresh();
    // Das linke Foto abgefahren – der Hinweis muss nach rechts unten zeigen.
    coverage = record(coverage, view(40, 60, 340, 260), TARGET, false);

    const gap = nextGap(coverage);
    expect(gap).not.toBeNull();
    expect(gap!.x).toBeGreaterThan(400);
    expect(gap!.y).toBeGreaterThan(250);
  });

  it('ist fertig, wenn alle Fotos abgefahren sind', () => {
    let coverage = fresh();
    expect(complete(coverage)).toBe(false);

    coverage = record(coverage, view(40, 60, 340, 260), TARGET, false);
    expect(complete(coverage)).toBe(false);

    coverage = record(coverage, view(410, 280, 340, 260), TARGET, false);
    expect(complete(coverage)).toBe(true);
    expect(nextGap(coverage)).toBeNull();
  });

  it('kommt mit einer Seite ohne erkannte Fotos zurecht', () => {
    const leer = coverageFor([], 800, 600, TARGET);
    expect(progress(leer).needed).toBe(0);
    expect(complete(leer)).toBe(false);
    expect(worthTaking(leer, view(100, 100), TARGET)).toBe(false);
  });
});
