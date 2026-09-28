/**
 * The Health tab: whether the numbers are right. The compile report of the running body, the
 * resolved body's validity, the inertia audit and joint sweep of the body the panels describe,
 * what a frame costs, and the model's standing limitations.
 */

import type { ResolvedMorphology } from '@bs-humany/anthropometry';
import { compileArticulation } from '@bs-humany/compiler';
import type { HsdlDocument } from '@bs-humany/hsdl';
import { type ReportNote, groupReportNotes, inertiaAudit, jointSweep } from '@bs-humany/scenarios';
import type { Simulation } from '@bs-humany/session';
import { modelLimitations } from '@bs-humany/skeleton';
import { escapeHtml, messageOf, must, setText } from './dom.js';

export interface HealthPanelHost {
  readonly document: HsdlDocument;
  /** The Body select, whose profile the tables are of. */
  readonly profile: HTMLSelectElement;
  /** What the backend is called, beside the compile report. */
  readonly backendName: string;
  /** The body the sliders describe, resolved. */
  resolvedMorphology(): ResolvedMorphology;
  /** The stature and mass the sliders show, for the line naming the body. */
  stature(): number;
  mass(): number;
  /** The profile the running body was built on, or undefined with no run. */
  runningProfile(): string | undefined;
}

export interface HealthPanel {
  /**
   * Surface every warning from the compiler, the backend and the muscle paths (spec section 9.3).
   *
   * Grouped by kind, because an L3 body compiles with over a hundred warnings that are nearly all
   * one sentence said once a vertebra and once a rib; listed flat, the warning that is about
   * something else was somewhere in the middle of them. A kind said three times or more is one
   * line that says how many, and opens to list them. The summary names the body the report is
   * of -- the running one, which is not the Body select's once somebody has chosen another -- and
   * the backend.
   */
  showReports(sim: Simulation): void;
  /** Add a line to the compile report of the running body. */
  addReportLine(text: string): void;
  /** Capabilities as a definition list (spec section 9.3). */
  showCapabilities(sim: Simulation): void;
  /**
   * The compile report with no run to report on, or back from that.
   *
   * The report is of a run's compile, and it used to go on showing the last run's after the run
   * had gone -- under a Body select that might by then name another profile altogether. With no
   * run, its lists are emptied and a line says when it fills.
   */
  setCompileReportEmpty(empty: boolean): void;
  /**
   * The resolved body's validity problems, listed above the inertia audit, or nothing.
   *
   * They used to reach the console and nowhere else, which in the desktop shell is nowhere at all.
   */
  showBodyValidity(problems: readonly string[]): void;
  /**
   * Which body the tables describe, above them: the selected profile, the stature and the mass,
   * and whether that is the running body or the one the next run will build.
   *
   * The tables follow the Body select and the sliders, not the run, so with a run going and
   * another profile chosen they are of a body that is not the one on screen, and the compile
   * report above them is of the one that is. Saying which is the difference between two tables
   * that disagree and two tables of two bodies.
   */
  showValidationNote(): void;
  /**
   * Validation views (M4.8): the two report scenarios, for the current morphology and profile.
   *
   * The body's own validity problems (spec section 6.4) are listed by `showBodyValidity`, in the
   * panel above these, because they belong to the morphology whatever the profile.
   */
  showValidation(): void;
  /** The bones, triangles and build time of the skeleton on screen. */
  showMeshStats(bones: number, triangles: number, buildMs: number): void;
  /** The Cost panel's Mesh row: which pack the bones on screen are from, and why. */
  showMeshDetail(text: string, title?: string): void;
  /** What a frame costs, smoothed, and how many draws it took. */
  showFrameCost(frameMs: number, draws: number): void;
}

export function createHealthPanel(host: HealthPanelHost): HealthPanel {
  const report = must<HTMLUListElement>('#sim-report');
  const summary = must<HTMLElement>('#sim-report-summary');
  const capabilities = must<HTMLDListElement>('#capabilities');
  const validationNote = must<HTMLElement>('#validation-note');
  const statFrame = must<HTMLElement>('#stat-frame');
  const statDraws = must<HTMLElement>('#stat-draws');

  /** Why the tables are empty, while the selected profile does not compile. */
  let validationFailure: string | undefined;

  const setCompileReportEmpty = (empty: boolean): void => {
    must<HTMLElement>('#sim-report-empty').hidden = !empty;
    if (!empty) return;
    capabilities.replaceChildren();
    report.replaceChildren();
    summary.textContent = '';
  };

  const showValidationNote = (): void => {
    const note = validationNote;
    note.classList.toggle('error', validationFailure !== undefined);
    if (validationFailure !== undefined) {
      setText(note, validationFailure);
      return;
    }
    const profile = host.profile.selectedOptions[0]?.textContent?.trim() ?? host.profile.value;
    const running = host.runningProfile();
    setText(
      note,
      `${profile}, ${host.stature().toFixed(2)} m, ${host.mass().toFixed(1)} kg` +
        (running !== undefined && running !== host.profile.value
          ? ' (selected — takes effect on the next run)'
          : ''),
    );
  };

  const showValidation = (): void => {
    const morphology = host.resolvedMorphology();
    let compiled: ReturnType<typeof compileArticulation>['articulation'];
    try {
      compiled = compileArticulation(host.document, host.profile.value, morphology).articulation;
    } catch (error) {
      // Both tables say so, rather than go on showing the last body's numbers as though they were
      // this one's -- which is what returning quietly here used to do -- and so does the line that
      // names the body above them.
      const why = `Profile does not compile: ${messageOf(error)}`;
      const row = `<tbody><tr><td>${escapeHtml(why)}</td></tr></tbody>`;
      must<HTMLTableElement>('#inertia-audit').innerHTML = row;
      must<HTMLTableElement>('#joint-sweep').innerHTML = row;
      validationFailure = `${host.profile.value || 'No profile'}: ${why}`;
      showValidationNote();
      return;
    }
    validationFailure = undefined;
    showValidationNote();
    const audit = inertiaAudit(compiled, morphology);
    const inertiaTable = must<HTMLTableElement>('#inertia-audit');
    inertiaTable.innerHTML = `
    <thead><tr><th>Segment</th><th>Mass</th><th>Bones</th><th>CoM height</th><th>Ixx</th><th>Iyy</th><th>Izz</th></tr></thead>
    <tbody>${audit.rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.segment)}</td><td>${r.mass.toFixed(3)}</td><td>${r.bones}</td><td>${r.comHeight.toFixed(3)}</td>` +
          `<td>${r.diagonal[0].toExponential(2)}</td><td>${r.diagonal[1].toExponential(2)}</td><td>${r.diagonal[2].toExponential(2)}</td></tr>`,
      )
      .join('')}
      <tr><th>Total</th><td>${audit.totalMass.toFixed(3)}</td><td></td><td>${audit.comHeight.toFixed(3)}</td><td colspan="3">target ${audit.targetMass.toFixed(1)} kg</td></tr>
    </tbody>`;
    const sweep = jointSweep(compiled);
    const sweepTable = must<HTMLTableElement>('#joint-sweep');
    sweepTable.innerHTML = `
    <thead><tr><th>Joint</th><th>Axis</th><th>Range</th><th>At lower</th><th>At upper</th><th>Curve</th></tr></thead>
    <tbody>${sweep
      .map((r) => {
        const peak = Math.max(...r.moments.map((m) => Math.abs(m)), 1e-9);
        const points = r.moments
          .map(
            (m, i) =>
              `${((i / (r.moments.length - 1)) * 60).toFixed(1)},${(10 - (m / peak) * 9).toFixed(1)}`,
          )
          .join(' ');
        return (
          `<tr><td>${escapeHtml(r.joint)}</td><td>${escapeHtml(r.axis)}${r.defaulted ? '*' : ''}</td>` +
          `<td>${r.range[0].toFixed(2)} … ${r.range[1].toFixed(2)}</td><td>${r.atLower.toFixed(1)}</td><td>${r.atUpper.toFixed(1)}</td>` +
          `<td><svg class="sparkline" width="60" height="20" viewBox="0 0 60 20"><polyline fill="none" stroke="#6aa9ff" stroke-width="1" points="${points}"/></svg></td></tr>`
        );
      })
      .join('')}
    </tbody>`;
  };

  host.profile.addEventListener('change', showValidation);

  const limitations = must<HTMLUListElement>('#limitations');
  for (const limitation of modelLimitations()) {
    const item = window.document.createElement('li');
    item.textContent = limitation;
    limitations.appendChild(item);
  }

  return {
    showReports(sim) {
      report.innerHTML = '';
      setCompileReportEmpty(false);
      const notes: ReportNote[] = [
        ...sim.compileReport.notes.map((n) => ({ ...n, from: 'compiler' })),
        ...(sim.backendReport?.notes ?? []).map((n) => ({
          ...n,
          from: sim.backendReport?.backend ?? 'backend',
        })),
        // What the path solver could not build: a wrap it straight-lined, a via point it treats as
        // unconditional. Warnings and errors only, so they count with the rest.
        ...(sim.musclePath?.compileReport.problems ?? []).map((p) => ({
          severity: p.severity,
          feature: 'musclePath',
          message: `${p.path}: ${p.message}`,
          from: 'muscle path',
        })),
      ].filter((n) => n.severity !== 'info');
      const info = [...sim.compileReport.notes, ...(sim.backendReport?.notes ?? [])].filter(
        (n) => n.severity === 'info',
      ).length;
      const groups = groupReportNotes(notes);
      summary.textContent =
        `${sim.recording.profile} on ${host.backendName} · ` +
        `${notes.length} warning${notes.length === 1 ? '' : 's'}` +
        (groups.length < notes.length ? ` of ${groups.length} kinds` : '') +
        `, ${info} note${info === 1 ? '' : 's'}`;
      for (const group of groups) {
        const item = window.document.createElement('li');
        const first = group.notes[0];
        if (group.notes.length === 1 && first) {
          item.textContent = `[${first.from}] ${first.message}`;
        } else {
          // One line for the kind, the first of them as its example, and the rest folded under it.
          const details = window.document.createElement('details');
          const line = window.document.createElement('summary');
          line.textContent =
            `[${group.from}] ${group.notes.length} × ${group.feature}` +
            (first ? `, such as: ${first.message}` : '');
          const inner = window.document.createElement('ul');
          for (const note of group.notes) {
            const each = window.document.createElement('li');
            each.textContent = note.message;
            inner.appendChild(each);
          }
          details.append(line, inner);
          item.appendChild(details);
        }
        report.appendChild(item);
      }
      if (sim.passive && sim.passive.defaulted.length > 0) {
        const item = window.document.createElement('li');
        item.textContent =
          `[passive joints] ${sim.passive.defaulted.length} of ${sim.articulation.dofs.length} DoFs ` +
          'run on the default curve derived from range and inertia (OQ-008).';
        report.appendChild(item);
      }
    },
    addReportLine(text) {
      const item = window.document.createElement('li');
      item.textContent = text;
      report.appendChild(item);
    },
    showCapabilities(sim) {
      capabilities.innerHTML = '';
      for (const [key, value] of Object.entries(sim.capabilities)) {
        const dt = window.document.createElement('dt');
        dt.textContent = key.replace(/([A-Z])/g, ' $1').toLowerCase();
        const dd = window.document.createElement('dd');
        dd.textContent = String(value);
        capabilities.append(dt, dd);
      }
    },
    setCompileReportEmpty,
    showBodyValidity(problems) {
      must<HTMLUListElement>('#body-validity').replaceChildren(
        ...problems.map((problem) => {
          const item = window.document.createElement('li');
          item.textContent = problem;
          return item;
        }),
      );
      must<HTMLElement>('#body-validity-panel').hidden = problems.length === 0;
    },
    showValidationNote,
    showValidation,
    showMeshStats(bones, triangles, buildMs) {
      must<HTMLElement>('#stat-bones').textContent = String(bones);
      must<HTMLElement>('#stat-tris').textContent = triangles.toLocaleString();
      must<HTMLElement>('#stat-build').textContent = `${buildMs.toFixed(1)} ms`;
    },
    showMeshDetail(text, title = '') {
      const row = must<HTMLElement>('#stat-mesh');
      setText(row, text);
      row.title = title;
    },
    showFrameCost(frameMs, draws) {
      statFrame.textContent = `${frameMs.toFixed(1)} ms`;
      statDraws.textContent = String(draws);
    },
  };
}
