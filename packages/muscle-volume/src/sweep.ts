/**
 * Procedural muscle volumes -- ticket N4.2, muscle spec section 9.4.
 *
 * A line of action cannot show a muscle bulge, and a bulging biceps is most of what anyone means
 * by watching a muscle work (section 9.1). This sweeps a cross-section along the solved path and
 * gives the belly a girth that follows from the muscle's own volume, so shortening thickens it.
 *
 * ## Where the bulge comes from
 *
 * Not from a simulation of the flesh -- that is N4.3's XPBD layer. From geometry. A belly holding
 * a given volume over a shorter length has to be thicker, by the square root of the ratio. Both
 * quantities are known every tick: the fiber length comes from `muscle.state`, and the volume
 * from the muscle's own parameters. That part is exact, and it is the part a viewer is judging.
 *
 * ## The volume is not quite a constant
 *
 * Muscle tissue is water and does not compress, so the *tissue* volume really is fixed. A muscle
 * belly is not only tissue: it is perfused, and how much blood it holds depends on what it is
 * doing. Shortening under load squeezes it out -- the muscle pump -- so a concentric contraction
 * measures slightly smaller. Lengthening under load raises intramuscular tension without that
 * expulsion and can measure slightly larger. Held at length, nothing moves and the volume sits
 * where it was.
 *
 * `perfusedVolume` applies that as a small modulation on the tissue volume, driven by the sign of
 * the fiber velocity and the activation that makes it a loaded contraction rather than a passive
 * stretch. It is deliberately small and deliberately separable: the geometry above does not know
 * about it, and a caller that wants the classical incompressible idealisation simply does not
 * call it.
 *
 * What it does not do is squash against bone, or bulge asymmetrically, or lag. Those want the
 * particle solver. This is the tier below, and it is honest about being a sweep.
 *
 * ## Belly and tendon
 *
 * The fibers occupy part of the path and the tendon the rest. The belly is centred on the path
 * and spans the fiber length; the tendon is drawn as a thin cord either side. Centring is a
 * simplification -- real tendon is usually longer at one end -- but which end is not something the
 * musculotendon model knows: it carries one tendon in series with the fibers and does not say
 * where along the path it sits. Splitting it evenly is the assumption that adds no information.
 *
 * ## The cross-section's size
 *
 * A muscle's volume is its physiological cross-sectional area times its fiber length, and its
 * area is its maximum isometric force divided by the specific tension of muscle tissue. That
 * last constant is the one number here without a cited source; see `SPECIFIC_TENSION`. It sets
 * how thick every muscle is drawn and nothing else -- the bulging, which is what the tier exists
 * for, is exact whatever value it takes.
 */

/**
 * Force a square metre of muscle fibre can exert, pascals.
 *
 * Published values cluster between 0.2 and 0.35 MPa and the spread is real: it depends on the
 * preparation, the species and how the area was measured. This is a display parameter -- Tier V
 * writes only to the render channel (M-ADR-004) -- so the consequence of the uncertainty is that
 * every muscle is drawn some per cent too thick or too thin, uniformly. The *change* in thickness
 * as a muscle contracts does not depend on it at all.
 *
 * Recorded as OQ-017 rather than cited, because a number in the middle of a published range is
 * not the same thing as a number read out of a paper.
 */
export const SPECIFIC_TENSION = 300_000;

/**
 * Shape of the belly along its length, as a fraction of the peak radius.
 *
 * `sqrt(sin(pi t))` gives a spindle that comes to a point at both ends and is fattest in the
 * middle, which is the shape of a fusiform muscle. It is also the profile whose volume integral
 * is a single term -- the belly's volume is exactly `2 r^2 L` -- so the peak radius that
 * conserves a given volume falls straight out with no numerical inversion.
 */
export function bellyProfile(t: number): number {
  return Math.sqrt(Math.sin(Math.PI * Math.min(1, Math.max(0, t))));
}

/** Peak radius of a spindle of this volume and length. From `V = 2 r^2 L`. */
export function peakRadius(volume: number, length: number): number {
  return length > 0 ? Math.sqrt(volume / (2 * length)) : 0;
}

/** A muscle's tissue volume, cubic metres, from what the fiber model already knows about it. */
export function muscleVolume(
  maxIsometricForce: number,
  optimalFiberLength: number,
  specificTension = SPECIFIC_TENSION,
): number {
  return (maxIsometricForce / specificTension) * optimalFiberLength;
}

/**
 * How far perfusion moves a belly's volume at full activation and full contraction velocity.
 *
 * Three per cent. Small on purpose: this is a fluid shift in and out of a tissue that does not
 * itself compress, not a change in how much muscle there is. Published figures for the effect
 * vary with the measurement -- ultrasound, MRI and plethysmography do not agree closely -- so
 * the magnitude is recorded as OQ-018 rather than cited, and like the specific tension above it
 * touches only what is drawn.
 */
export const PERFUSION_GAIN = 0.03;

/**
 * The volume a belly measures, given what the muscle is doing.
 *
 * Three cases, and the sign of the fiber velocity separates them:
 *
 *   - **Concentric**, shortening under load: volume falls, as the contraction pumps blood out.
 *   - **Eccentric**, lengthening under load: volume rises a little, tension without expulsion.
 *   - **Isometric**, not changing length: volume sits where it is.
 *
 * Activation is the other factor because the effect is about load, not motion: a relaxed muscle
 * dragged through its range is not pumping anything, and multiplying by activation is what makes
 * a passive stretch leave the volume alone.
 *
 * `fiberVelocity` is normalised the way `muscle.state` publishes it -- fiber lengths per second
 * over the maximum contraction velocity -- so the modulation saturates at the gain.
 */
export function perfusedVolume(
  tissueVolume: number,
  activation: number,
  fiberVelocity: number,
  gain = PERFUSION_GAIN,
): number {
  const velocity = fiberVelocity < -1 ? -1 : fiberVelocity > 1 ? 1 : fiberVelocity;
  const load = activation < 0 ? 0 : activation > 1 ? 1 : activation;
  return tissueVolume * (1 + gain * load * velocity);
}

/** A triangle mesh with room for one muscle, allocated once and rewritten every frame. */
export interface SweptMesh {
  /** Cross-sections along the muscle, including the two end points. */
  readonly rings: number;
  /** Vertices around each cross-section. */
  readonly segments: number;
  /** `3 * vertexCount`. */
  readonly position: Float32Array;
  /** `3 * vertexCount`, unit. */
  readonly normal: Float32Array;
  /** Triangle list. Fixed: the topology never changes, only where the vertices are. */
  readonly index: Uint32Array;
  readonly vertexCount: number;
}

/**
 * Build the mesh for one muscle, with its topology already wired.
 *
 * The index buffer is filled here and never touched again: a sweep's connectivity depends only on
 * how many rings and segments it has, so rebuilding it per frame would be work with a constant
 * answer. Only the positions and normals move.
 */
export function createSweptMesh(rings: number, segments: number): SweptMesh {
  if (rings < 2 || segments < 3) {
    throw new Error(`A sweep needs at least 2 rings and 3 segments; got ${rings} and ${segments}.`);
  }
  const vertexCount = rings * segments;
  const index = new Uint32Array((rings - 1) * segments * 6);

  let at = 0;
  for (let ring = 0; ring + 1 < rings; ring++) {
    for (let s = 0; s < segments; s++) {
      const next = (s + 1) % segments;
      const a = ring * segments + s;
      const b = ring * segments + next;
      const c = (ring + 1) * segments + s;
      const d = (ring + 1) * segments + next;
      index[at++] = a;
      index[at++] = c;
      index[at++] = b;
      index[at++] = b;
      index[at++] = c;
      index[at++] = d;
    }
  }

  return {
    rings,
    segments,
    position: new Float32Array(3 * vertexCount),
    normal: new Float32Array(3 * vertexCount),
    index,
    vertexCount,
  };
}

/** What a sweep needs to know about the muscle it is drawing. */
export interface SweepRequest {
  /** The solved path, `3 * pointCount` world metres, flattened. */
  readonly points: Float64Array;
  /** Where this muscle's points start, in points rather than floats. */
  readonly from: number;
  readonly pointCount: number;
  /** Tissue volume, cubic metres. Constant for a given muscle. */
  readonly volume: number;
  /** Current fiber length along the path, metres. The belly spans this much of it. */
  readonly bellyLength: number;
  /** Radius of the cord drawn where the tendon runs, metres. */
  readonly tendonRadius: number;
}

/**
 * Scratch for a sweep: the arc-length table and the frame carried along the path.
 *
 * Held by the caller so a render loop allocates nothing. One of these serves any number of
 * muscles in turn, as long as it was built for the longest path among them.
 */
export interface SweepScratch {
  readonly distance: Float64Array;
}

export function createSweepScratch(maxPoints: number): SweepScratch {
  return { distance: new Float64Array(Math.max(1, maxPoints)) };
}

const EPSILON = 1e-12;

/**
 * Sweep a cross-section along one muscle's path, writing into `out`.
 *
 * The frame carried along the path is rotation-minimising: each ring's reference direction is the
 * previous ring's, projected back square to the new tangent. Rebuilding a frame from a fixed
 * world axis instead would make the mesh spin about its own centre wherever the path turned
 * through vertical, which reads as the muscle twisting when only the camera moved.
 */
export function sweepMuscle(request: SweepRequest, scratch: SweepScratch, out: SweptMesh): void {
  const { points, from, pointCount, volume, bellyLength, tendonRadius } = request;
  const distance = scratch.distance;

  // Arc length to each point, so a ring at a given distance can be placed by interpolation.
  distance[0] = 0;
  for (let i = 1; i < pointCount; i++) {
    const a = 3 * (from + i - 1);
    const b = 3 * (from + i);
    distance[i] =
      (distance[i - 1] as number) +
      Math.hypot(
        (points[b] as number) - (points[a] as number),
        (points[b + 1] as number) - (points[a + 1] as number),
        (points[b + 2] as number) - (points[a + 2] as number),
      );
  }
  const total = distance[pointCount - 1] as number;
  if (total <= EPSILON || pointCount < 2) {
    out.position.fill(0);
    out.normal.fill(0);
    return;
  }

  // The belly, centred, clamped to the path it has to fit inside.
  const belly = Math.min(bellyLength, total);
  const bellyStart = (total - belly) / 2;
  const radiusPeak = peakRadius(volume, belly);

  // The carried frame. Seeded from whichever world axis is least aligned with the first tangent,
  // which is the only arbitrary choice in the whole sweep and is made once.
  let ux = 0;
  let uy = 0;
  let uz = 0;
  let seeded = false;

  for (let ring = 0; ring < out.rings; ring++) {
    const along = (total * ring) / (out.rings - 1);

    // Locate the ring on the polyline, and take the tangent from the segment it falls in.
    let at = 1;
    while (at < pointCount - 1 && (distance[at] as number) < along) at++;
    const d0 = distance[at - 1] as number;
    const d1 = distance[at] as number;
    const span = d1 - d0;
    const t = span > EPSILON ? (along - d0) / span : 0;
    const a = 3 * (from + at - 1);
    const b = 3 * (from + at);

    const px = (points[a] as number) + ((points[b] as number) - (points[a] as number)) * t;
    const py =
      (points[a + 1] as number) + ((points[b + 1] as number) - (points[a + 1] as number)) * t;
    const pz =
      (points[a + 2] as number) + ((points[b + 2] as number) - (points[a + 2] as number)) * t;

    let tx = (points[b] as number) - (points[a] as number);
    let ty = (points[b + 1] as number) - (points[a + 1] as number);
    let tz = (points[b + 2] as number) - (points[a + 2] as number);
    const tangent = Math.hypot(tx, ty, tz);
    if (tangent > EPSILON) {
      tx /= tangent;
      ty /= tangent;
      tz /= tangent;
    } else {
      tx = 0;
      ty = 1;
      tz = 0;
    }

    if (!seeded) {
      // Any direction square to the tangent will do; take the world axis the tangent leans on
      // least, so the cross product is well conditioned.
      const ax = Math.abs(tx);
      const ay = Math.abs(ty);
      const az = Math.abs(tz);
      const sx = ax <= ay && ax <= az ? 1 : 0;
      const sy = ay < ax && ay <= az ? 1 : 0;
      const sz = sx === 0 && sy === 0 ? 1 : 0;
      ux = ty * sz - tz * sy;
      uy = tz * sx - tx * sz;
      uz = tx * sy - ty * sx;
      seeded = true;
    }

    // Carry the frame: strip whatever component the previous reference has along the new tangent.
    const drift = ux * tx + uy * ty + uz * tz;
    ux -= tx * drift;
    uy -= ty * drift;
    uz -= tz * drift;
    let length = Math.hypot(ux, uy, uz);
    if (length <= EPSILON) {
      // The path doubled back on itself. Reseed rather than divide by nothing.
      ux = ty;
      uy = tz;
      uz = tx;
      const drift2 = ux * tx + uy * ty + uz * tz;
      ux -= tx * drift2;
      uy -= ty * drift2;
      uz -= tz * drift2;
      length = Math.hypot(ux, uy, uz) || 1;
    }
    ux /= length;
    uy /= length;
    uz /= length;

    // The second reference direction completes a right-handed frame with the tangent.
    const vx = ty * uz - tz * uy;
    const vy = tz * ux - tx * uz;
    const vz = tx * uy - ty * ux;

    // How thick the muscle is here: the spindle over the belly, a thin cord over the tendon.
    const withinBelly = belly > EPSILON ? (along - bellyStart) / belly : -1;
    const radius =
      withinBelly >= 0 && withinBelly <= 1
        ? Math.max(tendonRadius, radiusPeak * bellyProfile(withinBelly))
        : tendonRadius;

    for (let s = 0; s < out.segments; s++) {
      const angle = (2 * Math.PI * s) / out.segments;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const nx = ux * cos + vx * sin;
      const ny = uy * cos + vy * sin;
      const nz = uz * cos + vz * sin;
      const vertex = 3 * (ring * out.segments + s);
      out.position[vertex] = px + nx * radius;
      out.position[vertex + 1] = py + ny * radius;
      out.position[vertex + 2] = pz + nz * radius;
      // The surface normal of a swept tube is the radial direction, exactly where the radius is
      // not changing and closely enough elsewhere that a lit surface reads correctly.
      out.normal[vertex] = nx;
      out.normal[vertex + 1] = ny;
      out.normal[vertex + 2] = nz;
    }
  }
}

/**
 * Volume enclosed by a swept mesh, cubic metres, by the divergence theorem over its triangles.
 *
 * For tests rather than for rendering. It is the check that the bulge is real: a belly that
 * shortens must enclose the same volume it did before, and measuring the mesh is the only way to
 * know that the thing on screen does, rather than the formula that was meant to make it.
 */
export function enclosedVolume(mesh: SweptMesh): number {
  let total = 0;
  for (let i = 0; i + 2 < mesh.index.length; i += 3) {
    const a = 3 * (mesh.index[i] as number);
    const b = 3 * (mesh.index[i + 1] as number);
    const c = 3 * (mesh.index[i + 2] as number);
    const ax = mesh.position[a] as number;
    const ay = mesh.position[a + 1] as number;
    const az = mesh.position[a + 2] as number;
    const bx = mesh.position[b] as number;
    const by = mesh.position[b + 1] as number;
    const bz = mesh.position[b + 2] as number;
    const cx = mesh.position[c] as number;
    const cy = mesh.position[c + 1] as number;
    const cz = mesh.position[c + 2] as number;
    total += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(total);
}
