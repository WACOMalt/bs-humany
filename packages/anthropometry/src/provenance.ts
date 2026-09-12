/**
 * Transcription provenance for parameter tables.
 *
 * Every number in this package was copied from a publication by a person or an agent reading that
 * publication. Copying is error-prone, and a transposed digit in a mass fraction produces a model
 * that behaves plausibly and is wrong -- the exact failure mode the specification is built to
 * prevent.
 *
 * So each table carries a machine-readable verification status, and the status is surfaced in the
 * UI rather than living in a comment nobody reads. A table that has not been checked against the
 * source document by a human says so, out loud, wherever its numbers are used.
 *
 * This is not bureaucracy. It is the difference between "these are de Leva's numbers" and "these
 * are believed to be de Leva's numbers", and a research-grade tool has no business conflating the
 * two.
 */

export type VerificationStatus =
  /**
   * Transcribed and checked line by line against the source document by a human, with the check
   * recorded in `docs/validation/`.
   */
  | 'verified'
  /**
   * Transcribed, and passing every automated consistency check the table supports -- mass
   * fractions summing correctly, sub-segments decomposing, inertia tensors physically valid --
   * but **not yet checked against the source document by a human**.
   *
   * Automated checks catch a transposed digit that breaks an invariant. They cannot catch a value
   * that is internally consistent and simply not what the paper says.
   */
  | 'consistency-checked'
  /** Transcribed, no checks run. Not fit for use. */
  | 'unverified';

export interface TableProvenance {
  /** Bibliography key. */
  readonly source: string;
  /** Table, figure or page the values were read from. */
  readonly locator: string;
  readonly status: VerificationStatus;
  /** Open question tracking the outstanding human verification, where one is outstanding. */
  readonly openQuestion?: string;
  /** What the automated checks do and do not establish. Shown in the UI beside the status. */
  readonly note: string;
  /** Population the source sampled, and how that limits the values. Always surfaced. */
  readonly population: string;
}

/** True when a table is fit for a run the user has labelled a measurement. */
export function fitForMeasurement(provenance: TableProvenance): boolean {
  return provenance.status === 'verified';
}

/** One-line human-readable summary, for a UI badge or a report header. */
export function describeProvenance(provenance: TableProvenance): string {
  switch (provenance.status) {
    case 'verified':
      return `${provenance.source} (${provenance.locator}) -- verified against source`;
    case 'consistency-checked':
      return (
        `${provenance.source} (${provenance.locator}) -- consistency-checked, NOT yet verified ` +
        `against the source document${provenance.openQuestion ? ` (${provenance.openQuestion})` : ''}`
      );
    case 'unverified':
      return `${provenance.source} (${provenance.locator}) -- UNVERIFIED, not fit for use`;
  }
}
