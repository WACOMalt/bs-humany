/**
 * The Spine panel's picture: what the cord is doing, drawn from the run it is in.
 *
 * The canvas and the note under it were in the page for a long time with nothing drawing them, so
 * the one place a person could see whether a stretch gain was doing anything was the body falling
 * over or not. This draws them: one band per reflex group, coloured by the drive the cord worked
 * out for it on the last tick -- red for excitation, blue for inhibition, on the same scale the
 * Nerves panel draws a policy's layers with -- and a note that counts the muscles past the set
 * point and the ones held at the ceiling, which are the two numbers the gains are tuned against.
 *
 * Only at the live edge and only for a run of this page's own. The drive is a tick wide and
 * nothing records it, so a replayed frame has no cord to show; and a followed bridge is somebody
 * else's run, whose cord this page cannot see. In either case the readout hides rather than
 * showing the newest tick's answer against a body that is somewhere else.
 */

import type { Simulation } from '@bs-humany/session';

/**
 * The panel's elements, found on first use rather than at module scope: the frame loop draws
 * this, and its first frame runs while main.ts is still being evaluated.
 */
let elements: {
  wrap: HTMLElement;
  canvas: HTMLCanvasElement;
  note: HTMLElement;
  image: ImageData | null;
} | null = null;

function spineElements(): typeof elements {
  if (!elements) {
    const wrap = document.querySelector<HTMLElement>('#spine-activity-wrap');
    const canvas = document.querySelector<HTMLCanvasElement>('#spine-activity');
    const note = document.querySelector<HTMLElement>('#spine-note');
    if (!wrap || !canvas || !note) return null;
    elements = { wrap, canvas, note, image: null };
  }
  return elements;
}

/**
 * What the note last said, as the numbers it was built from, so the text is rebuilt -- and the
 * element written -- only when one of them changes. Sixty frames a second of an unchanged note
 * would otherwise be sixty strings a second and a screen reader re-announcing it.
 */
let shown = { off: false, past: -1, ceiling: -1, units: -1 };

/** Draw the cord's activity for a run, or hide the readout when there is nothing to show. */
export function drawSpine(sim: Simulation | undefined, live: boolean): void {
  const ui = spineElements();
  if (!ui) return;
  const spine = sim?.spine;
  const units = sim?.muscles?.units.length ?? 0;
  if (!spine || !live) {
    if (!ui.wrap.hidden) ui.wrap.hidden = true;
    return;
  }
  if (ui.wrap.hidden) ui.wrap.hidden = false;

  const context = ui.canvas.getContext('2d');
  if (context) {
    const width = ui.canvas.width;
    const height = ui.canvas.height;
    if (!ui.image || ui.image.width !== width || ui.image.height !== height) {
      ui.image = context.createImageData(width, height);
    }
    const data = ui.image.data;
    const drive = spine.lastDrive;
    const groups = drive.length;
    for (let px = 0; px < width; px++) {
      // One band per group, a pixel's gap between neighbours when they are wide enough to have
      // one, so a row of forty groups still reads as forty rather than as a smear.
      const at = groups > 0 ? Math.floor((px / width) * groups) : -1;
      const edge =
        groups > 0 && groups * 4 <= width && Math.floor(((px + 1) / width) * groups) !== at;
      const v = at >= 0 ? (drive[at] as number) : 0;
      const m = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
      const red = edge ? 20 : m > 0 ? 40 + 215 * m : 40;
      const blue = edge ? 20 : m < 0 ? 40 - 215 * m : 40;
      const green = edge ? 20 : 40 + 30 * Math.abs(m);
      for (let py = 0; py < height; py++) {
        const i = 4 * (py * width + px);
        data[i] = red;
        data[i + 1] = green;
        data[i + 2] = blue;
        data[i + 3] = 255;
      }
    }
    context.putImageData(ui.image, 0, 0);
  }

  const gains = spine.gains;
  const off = gains.stretch === 0 && gains.velocity === 0;
  const past = spine.lastPastSetPoint;
  const ceiling = spine.lastAtCeiling;
  if (
    shown.off === off &&
    shown.past === past &&
    shown.ceiling === ceiling &&
    shown.units === units
  ) {
    return;
  }
  shown = { off, past, ceiling, units };
  const text = off
    ? 'Cord off: stretch and damping at zero.'
    : `${past} of ${units} muscles past the set point, ${ceiling} at the ceiling`;
  if (ui.note.textContent !== text) ui.note.textContent = text;
}
