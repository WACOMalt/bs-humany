export {
  type Feet,
  ObservationBuilder,
  type ObservationChannels,
  feetOf,
} from './observation.js';
export {
  MOTOR_NOISE_MODULE_ID,
  MotorNoiseModule,
  type MotorNoiseOptions,
  NoiseField,
  seededNormal,
  seededUniform,
} from './noise.js';
export { MlpPolicy, type PolicyFile } from './policy.js';
export {
  BODY_FINGERPRINT_VERSION,
  type BodyDescription,
  type BodyFingerprint,
  SENSE_MEANINGS,
  bodyFingerprint,
  compareBody,
  compareCord,
  senseFamily,
  senseMeaning,
  summariseDifferences,
} from './bodyFingerprint.js';
export {
  type Carried,
  type DriveOutput,
  NERVES_MODULE_ID,
  NervesModule,
  type NervesOptions,
  type PolicyNames,
  type TrainedBody,
} from './nervesModule.js';
export {
  DEFAULT_SPINAL_GAINS,
  MEASURED_SPINAL_GAINS,
  type ReflexGroup,
  SPINAL_CONDUCTION_DELAY_S,
  SPINAL_MODULE_ID,
  SPINAL_OFF,
  SpinalModule,
  type SpinalGains,
  type SpinalOptions,
} from './spinalModule.js';
