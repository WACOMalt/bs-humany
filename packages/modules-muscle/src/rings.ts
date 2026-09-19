/**
 * Each belly's rings, read out of the swept mesh: centre, orientation and radius, eight floats.
 *
 * Taken from the vertices rather than published by the sweep, because the sweep already put
 * everything needed there: a ring is a circle of `segments` vertices, so its centre is their
 * mean, its radius their mean distance from that centre, and its orientation the frame in which
 * the first vertex lies along X and the ring's own plane is the XY plane. Nothing is fitted --
 * these are exact for a circle, and the ring is a circle by construction. The studio's capture,
 * the muscle bridge and a training showcase all want the same eight floats, so this is where they
 * come from.
 */

export interface RingBuffers {
  /** 3 a ring. */
  readonly position: Float32Array;
  /** 4 a ring, xyzw. */
  readonly orientation: Float32Array;
  /** 1 a ring. */
  readonly radius: Float32Array;
}

export interface SweptMeshView {
  readonly position: ArrayLike<number>;
  readonly verticesPerUnit: number;
  readonly units: number;
}

/** Buffers for `units * rings` rings. */
export function ringBuffers(units: number, rings: number): RingBuffers {
  const total = units * rings;
  return {
    position: new Float32Array(total * 3),
    orientation: new Float32Array(total * 4),
    radius: new Float32Array(total),
  };
}

/** Fill `out` from the mesh; allocation-free, since this runs at the tick rate. */
export function extractMuscleRings(
  mesh: SweptMeshView,
  rings: number,
  segments: number,
  out: RingBuffers,
): void {
  for (let unit = 0; unit < mesh.units; unit++) {
    for (let ring = 0; ring < rings; ring++) {
      const base = 3 * (unit * mesh.verticesPerUnit + ring * segments);
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let v = 0; v < segments; v++) {
        cx += mesh.position[base + 3 * v] ?? 0;
        cy += mesh.position[base + 3 * v + 1] ?? 0;
        cz += mesh.position[base + 3 * v + 2] ?? 0;
      }
      cx /= segments;
      cy /= segments;
      cz /= segments;
      // X toward the first vertex, Z along the ring's normal, Y completing a right-handed set.
      let ax = (mesh.position[base] ?? 0) - cx;
      let ay = (mesh.position[base + 1] ?? 0) - cy;
      let az = (mesh.position[base + 2] ?? 0) - cz;
      const radius = Math.hypot(ax, ay, az);
      const quarter = 3 * Math.floor(segments / 4);
      let bx = (mesh.position[base + quarter] ?? 0) - cx;
      let by = (mesh.position[base + quarter + 1] ?? 0) - cy;
      let bz = (mesh.position[base + quarter + 2] ?? 0) - cz;
      if (radius > 1e-9) {
        ax /= radius;
        ay /= radius;
        az /= radius;
      }
      const bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl;
      by /= bl;
      bz /= bl;
      // Z = X cross Y, then Y squared back up so the three are orthonormal whatever the mesh's
      // rounding did.
      const zx = ay * bz - az * by;
      const zy = az * bx - ax * bz;
      const zz = ax * by - ay * bx;
      const yx = zy * az - zz * ay;
      const yy = zz * ax - zx * az;
      const yz = zx * ay - zy * ax;
      const at = unit * rings + ring;
      out.position[3 * at] = cx;
      out.position[3 * at + 1] = cy;
      out.position[3 * at + 2] = cz;
      out.radius[at] = radius;
      writeQuaternion(out.orientation, 4 * at, ax, ay, az, yx, yy, yz, zx, zy, zz);
    }
  }
}

/** A rotation matrix, given by its three columns, as an xyzw quaternion at `out[at..]`. */
function writeQuaternion(
  out: Float32Array,
  at: number,
  xx: number,
  xy: number,
  xz: number,
  yx: number,
  yy: number,
  yz: number,
  zx: number,
  zy: number,
  zz: number,
): void {
  const trace = xx + yy + zz;
  let w: number;
  let x: number;
  let y: number;
  let z: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (yz - zy) / s;
    y = (zx - xz) / s;
    z = (xy - yx) / s;
  } else if (xx > yy && xx > zz) {
    const s = Math.sqrt(1 + xx - yy - zz) * 2;
    w = (yz - zy) / s;
    x = s / 4;
    y = (xy + yx) / s;
    z = (xz + zx) / s;
  } else if (yy > zz) {
    const s = Math.sqrt(1 + yy - xx - zz) * 2;
    w = (zx - xz) / s;
    x = (xy + yx) / s;
    y = s / 4;
    z = (yz + zy) / s;
  } else {
    const s = Math.sqrt(1 + zz - xx - yy) * 2;
    w = (xy - yx) / s;
    x = (xz + zx) / s;
    y = (yz + zy) / s;
    z = s / 4;
  }
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = z;
  out[at + 3] = w;
}
