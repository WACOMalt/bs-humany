/**
 * Angle units.
 *
 * **The data model is radians. Always.** Degrees exist only in UI display code and in the labels
 * of validation reports, converted at the boundary with these two functions.
 *
 * They are here, in a package everything depends on, so that there is exactly one place where the
 * conversion happens and it is greppable. A stray `* Math.PI / 180` inside a bone definition is a
 * review failure -- it means a degree value got into the data model.
 */

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const TWO_PI = Math.PI * 2;

/** Degrees to radians. Use **only** when reading a value from a UI control or a published table. */
export function degToRad(degrees: number): number {
  return degrees * DEG_TO_RAD;
}

/** Radians to degrees. Use **only** when writing a value to a UI control or a report. */
export function radToDeg(radians: number): number {
  return radians * RAD_TO_DEG;
}

/** Wrap to `(-pi, pi]`. */
export function wrapAngle(radians: number): number {
  const wrapped = (((radians + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI;
  return wrapped - Math.PI;
}

/** Signed shortest difference `a - b`, wrapped to `(-pi, pi]`. */
export function angleDifference(a: number, b: number): number {
  return wrapAngle(a - b);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
