/**
 * Quaternion and rigid-transform arithmetic on typed arrays, for step-rate code.
 *
 * `@bs-humany/frames` returns fresh objects, which is right for build-time code and wrong inside
 * `step`. These helpers write into caller-owned `Float64Array`s at an offset. Layout is x y z w
 * for a rotation and x y z for a point, matching the channel fields.
 */

export function qSet(out: Float64Array, o: number, x: number, y: number, z: number, w: number) {
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = w;
}

/** out = a * b. `out` may alias either input. */
export function qMul(
  out: Float64Array,
  o: number,
  a: Float64Array,
  ao: number,
  b: Float64Array,
  bo: number,
): void {
  const ax = a[ao] as number;
  const ay = a[ao + 1] as number;
  const az = a[ao + 2] as number;
  const aw = a[ao + 3] as number;
  const bx = b[bo] as number;
  const by = b[bo + 1] as number;
  const bz = b[bo + 2] as number;
  const bw = b[bo + 3] as number;
  qSet(
    out,
    o,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  );
}

export function qConj(out: Float64Array, o: number, a: Float64Array, ao: number): void {
  qSet(
    out,
    o,
    -(a[ao] as number),
    -(a[ao + 1] as number),
    -(a[ao + 2] as number),
    a[ao + 3] as number,
  );
}

export function qFromAxisAngle(
  out: Float64Array,
  o: number,
  ax: number,
  ay: number,
  az: number,
  angle: number,
): void {
  const h = angle / 2;
  const s = Math.sin(h);
  qSet(out, o, ax * s, ay * s, az * s, Math.cos(h));
}

/** Rotate the point at `v[vo..]` by the quaternion at `q[qo..]`, writing to `out[o..]`. */
export function qRotate(
  out: Float64Array,
  o: number,
  q: Float64Array,
  qo: number,
  v: Float64Array,
  vo: number,
): void {
  const x = v[vo] as number;
  const y = v[vo + 1] as number;
  const z = v[vo + 2] as number;
  const qx = q[qo] as number;
  const qy = q[qo + 1] as number;
  const qz = q[qo + 2] as number;
  const qw = q[qo + 3] as number;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * Compose transforms: out = a ∘ b, each stored as position (3) then rotation (4), so a transform
 * occupies seven scalars at its offset. `out` must not alias `b`.
 */
export function tCompose(
  out: Float64Array,
  o: number,
  a: Float64Array,
  ao: number,
  b: Float64Array,
  bo: number,
): void {
  // position: a.p + a.r * b.p
  qRotate(out, o, a, ao + 3, b, bo);
  out[o] = (out[o] as number) + (a[ao] as number);
  out[o + 1] = (out[o + 1] as number) + (a[ao + 1] as number);
  out[o + 2] = (out[o + 2] as number) + (a[ao + 2] as number);
  qMul(out, o + 3, a, ao + 3, b, bo + 3);
}
