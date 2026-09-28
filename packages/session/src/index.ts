/**
 * @bs-humany/session: the simulation session, with no DOM.
 *
 * What the studio, `publish-pose` and the training showcase share, and no more: the three of them
 * are the whole audience, so this exports what they use. Everything else stays private to the
 * package, and the tests that reach for it live here beside it rather than widening this list.
 */

export {
  type BackendId,
  DEFAULT_OUTPUT_FRAMERATE,
  MAX_TICKS_PER_ADVANCE,
  Simulation,
  type SimulationOptions,
} from './simulation.js';
export { GrabIntents } from './grabIntents.js';
export {
  type PublisherRun,
  type PublisherSettings,
  publisherMorphology,
  publisherStatus,
  scenarioDefinition,
} from './publisherStatus.js';
export {
  BEAD_RADIUS,
  DISC_HEIGHT,
  DISC_RADIUS,
  type TissueTable,
  barMesh,
  cylinderMesh,
  sphereMesh,
  tissueOf,
  tissueTable,
} from './tissue.js';
