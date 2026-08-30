import type { Quad } from './types';

/**
 * Das **wahre** Seitenverhältnis eines Rechtecks, aus seinem perspektivischen
 * Bild zurückgerechnet.
 *
 * Bisher nahm die Entzerrung die längste beobachtete Kante als Breite und die
 * längste als Höhe. Unter Perspektive ist das systematisch falsch: Die nahe
 * Kante eines schräg liegenden Abzugs ist länger als die ferne, und keine der
 * beiden ist die wahre. Gemessen an einer gerechneten Kamera mit bekannter
 * Brennweite und bekannten Rechtecken:
 *
 * | Format | Neigung | Kantenmethode | hier |
 * | --- | --- | --- | --- |
 * | 3:2 | 26°/17° | 1.577 (5.1 % daneben) | 1.5000 (0.00 %) |
 * | 4:3 | 26°/17° | 1.407 (5.5 % daneben) | 1.3333 (0.00 %) |
 * | 1:1 | 26°/17° | 1.062 (6.2 % daneben) | 1.0000 (0.00 %) |
 *
 * Sechs Prozent Verzerrung sieht man dem einzelnen Bild nicht an – aber jedes
 * Gesicht darin ist zu breit oder zu schmal, und das bleibt für immer so.
 *
 * Das Verfahren stammt von Zhang und He (*Whiteboard Scanning and Image
 * Enhancement*, 2003) und braucht ausser den vier Ecken nichts: Aus ihnen
 * fallen die beiden Fluchtpunkte, daraus die Brennweite, daraus das
 * Verhältnis. Der Hauptpunkt wird in der Bildmitte angenommen – bei einer
 * Telefonkamera trifft das nahe genug zu.
 *
 * Gibt `null` zurück, wenn die Rechnung entartet. Das ist genau der Fall der
 * frontalen Aufnahme: ohne Perspektive gibt es keine Fluchtpunkte, aus denen
 * sich etwas gewinnen liesse. Dort ist die Kantenmethode allerdings exakt, der
 * Rückfall kostet also nichts.
 */
export function trueAspect(quad: Quad, width: number, height: number): number | null {
  const u0 = (width - 1) / 2;
  const v0 = (height - 1) / 2;

  // Zhangs Reihenfolge: oben links, oben rechts, unten links, unten rechts.
  const m1: Vec = [quad[0].x, quad[0].y, 1];
  const m2: Vec = [quad[1].x, quad[1].y, 1];
  const m3: Vec = [quad[3].x, quad[3].y, 1];
  const m4: Vec = [quad[2].x, quad[2].y, 1];

  const d2 = dot(cross(m2, m4), m3);
  const d3 = dot(cross(m3, m4), m2);
  if (Math.abs(d2) < 1e-9 || Math.abs(d3) < 1e-9) return null;
  const k2 = dot(cross(m1, m4), m3) / d2;
  const k3 = dot(cross(m1, m4), m2) / d3;

  const n2 = sub(scale(m2, k2), m1);
  const n3 = sub(scale(m3, k3), m1);
  if (Math.abs(n2[2]) < 1e-9 || Math.abs(n3[2]) < 1e-9) return null;

  const squared =
    -(1 / (n2[2] * n3[2])) *
    (n2[0] * n3[0] -
      (n2[0] * n3[2] + n2[2] * n3[0]) * u0 +
      n2[2] * n3[2] * u0 * u0 +
      (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0));
  if (!(squared > 0)) return null;

  // Eine unglaubwürdige Brennweite heisst: Die Aufnahme ist fast frontal, und
  // die Fluchtpunkte liegen so weit draussen, dass sie nur noch Rundungsfehler
  // sind. Dann lieber nichts sagen.
  const focal = Math.sqrt(squared);
  const diagonal = Math.hypot(width, height);
  if (focal < diagonal * 0.2 || focal > diagonal * 12) return null;

  const norm = (n: Vec) =>
    (n[0] * n[0] +
      n[1] * n[1] -
      2 * u0 * n[0] * n[2] -
      2 * v0 * n[1] * n[2] +
      (squared + u0 * u0 + v0 * v0) * n[2] * n[2]) /
    squared;

  const along = norm(n2);
  const across = norm(n3);
  if (!(along > 0) || !(across > 0)) return null;

  const ratio = Math.sqrt(along / across);
  // Ein Abzug ist kein Bandmass. Was hier herauskommt, muss ein Bild sein
  // können, sonst ist die Rechnung an einer schiefen Ecke entgleist.
  return ratio > 0.2 && ratio < 5 ? ratio : null;
}

type Vec = [number, number, number];

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub(a: Vec, b: Vec): Vec {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec, k: number): Vec {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/**
 * Die Seitenverhältnisse, in denen Abzüge tatsächlich vorliegen.
 *
 * 6×6 quadratisch, 10×13, 9×12, 13×18, 8,9×12,7 und 10×15 – hochkant zählt
 * jeweils mit. Das ist nicht Zierde, sondern der Grund, warum die Rechnung
 * überhaupt eingesetzt werden kann: Aus einer verrauschten Schätzung wird eine
 * Entscheidung zwischen wenigen bekannten Werten, und die verträgt Rauschen
 * ungleich besser.
 */
export const PRINT_RATIOS = [1, 1.25, 4 / 3, 1.385, 1.43, 1.5];

/** Wie nah an einem Normformat die Schätzung liegen muss, damit sie zählt. */
const SNAP = 0.06;

/**
 * Das nächstgelegene Abzugsformat – oder `null`, wenn keines nah genug liegt.
 */
export function snapToPrint(ratio: number, window = SNAP): number | null {
  let best: number | null = null;
  let closest = Infinity;
  for (const format of PRINT_RATIOS) {
    for (const candidate of [format, 1 / format]) {
      const off = Math.abs(ratio - candidate) / candidate;
      if (off < closest) {
        closest = off;
        best = candidate;
      }
    }
  }
  return closest <= window ? best : null;
}
