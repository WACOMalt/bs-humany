/**
 * The brain on screen: the policy's layers as pixels, redrawn every frame the nerves are in.
 *
 * From whichever brain is in a loop: this page's own policy when one has been handed the running
 * body, and otherwise the training showcase's, polled from the dashboard by the Brain panel.
 * Without either the panel hides and says so.
 */

import type { BrainPanel } from './brain.js';
import type { Simulation } from './simulation.js';
import { must } from './ui/dom.js';

export interface NervesView {
  /** Draw the brain in the loop for this frame, or hide the panel when there is none. */
  draw(sim: Simulation | undefined): void;
}

export function createNervesView(brain: BrainPanel): NervesView {
  /** The Activity panel's elements, found once, and the picture it draws into, made at the first draw. */
  const ui: {
    readonly control: HTMLElement;
    readonly canvas: HTMLCanvasElement;
    readonly note: HTMLElement;
    image: ImageData | null;
  } = {
    control: must<HTMLElement>('#nerves-control'),
    canvas: must<HTMLCanvasElement>('#nerves-activity'),
    note: must<HTMLElement>('#nerves-note'),
    image: null,
  };

  return {
    draw(sim) {
      const local = sim?.brainActive ? sim.nerves : undefined;
      const remote = local ? undefined : brain.remoteActivity();
      const layers: readonly ArrayLike<number>[] | undefined =
        local?.policy.layers ?? remote?.layers;
      if (!layers || layers.length === 0) {
        if (!ui.control.hidden) ui.control.hidden = true;
        return;
      }
      if (ui.control.hidden) ui.control.hidden = false;
      const context = ui.canvas.getContext('2d');
      if (!context) return;
      const width = ui.canvas.width;
      const height = ui.canvas.height;
      if (!ui.image || ui.image.width !== width || ui.image.height !== height) {
        ui.image = context.createImageData(width, height);
      }
      const data = ui.image.data;
      const rowHeight = Math.floor(height / layers.length);
      layers.forEach((layer: ArrayLike<number>, row: number) => {
        const n = layer.length;
        for (let px = 0; px < width; px++) {
          const v = layer[Math.floor((px / width) * n)] ?? 0;
          const m = Math.max(-1, Math.min(1, v));
          const red = m > 0 ? 40 + 215 * m : 40;
          const blue = m < 0 ? 40 - 215 * m : 40;
          const green = 40 + 30 * Math.abs(m);
          for (let py = row * rowHeight; py < (row + 1) * rowHeight - 1; py++) {
            const i = 4 * (py * width + px);
            data[i] = red;
            data[i + 1] = green;
            data[i + 2] = blue;
            data[i + 3] = 255;
          }
        }
      });
      context.putImageData(ui.image, 0, 0);
      if (local && sim) {
        // The policy in charge now, which after a hand-over is not the one the run opened with.
        const inCharge = sim.policyInCharge;
        const trained = inCharge?.trained;
        ui.note.textContent =
          `${inCharge?.task ? `${inCharge.task}: ` : ''}` +
          `${local.policy.sizes.join(' × ')} weights, ${local.evaluationsSoFar} evaluations` +
          (trained
            ? `; trained ${trained.generations} generations to fitness ${trained.fitness.toFixed(2)}`
            : '') +
          (local.unreadableSoFar ? `; ${local.unreadableSoFar} unreadable inputs` : '');
      } else if (remote) {
        ui.note.textContent =
          `${remote.name}, generation ${remote.generation}: ` +
          `${layers.map((l) => l.length).join(' × ')}, ` +
          `${remote.time.toFixed(2)} s into the episode${remote.up ? '' : ', down'}`;
      }
    },
  };
}
