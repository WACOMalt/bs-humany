//! The shapes the renderer draws that are not the pack's bones, built on the CPU in the pack's
//! vertex layout -- position, normal, and a slot index carried as a bit pattern:
//!
//! - once, at start-up, into the bones' own buffers (`flatten`): a cube a controller, a small
//!   cube a pointer mark, the floor grid, and a unit box a hand for the aim ray, which the frame
//!   loop stretches to its length (`ray_matrix`);
//! - once a scenario, the scenery's static boxes (`posed_box`);
//! - every frame, the muscle tubes swept from the belly rings (`tube_vertices`), over
//!   connectivity that depends only on the counts and is built once (`tube_indices`).
//!
//! No GPU here: the renderer copies what these build into its buffers.

use crate::math::{multiply, pose_matrix, rotation};
use crate::pack::Pack;
use crate::render::{CONTROLLERS, MARKERS, RAYS, Slots, TINT_BASE, TINT_STEPS};

/// The edge of a pointer mark, which is a small cube where the aim ray meets the panel.
pub const MARKER_EDGE: f32 = 0.012;
/// How thick an aim ray is drawn, in metres: a line to follow, not a beam to look at.
pub const RAY_WIDTH: f32 = 0.002;
/// How long an aim ray is drawn when it meets no panel, in metres: past arm's length, well short
/// of the far side of the room.
pub const RAY_REACH: f32 = 1.5;
/// The floor grid: lines this far apart, out to this far, this wide, all in metres.
const GRID_SPACING: f32 = 0.5;
const GRID_REACH: f32 = 5.0;
const GRID_WIDTH: f32 = 0.006;
/// The edge of a controller cube, in metres; a hand-sized thing, not a fingertip.
pub const CONTROLLER_EDGE: f32 = 0.06;

/// Every bone's vertices and indices in one pair of buffers, indices rebased as they are copied,
/// and after them the things that are not bones, each in the slot `slots` gives it: a cube for
/// each controller, a mark for each hand's pointer, the floor grid, and an aim ray a hand.
pub(crate) fn flatten(pack: &Pack, slots: &Slots) -> (Vec<f32>, Vec<u32>) {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for (bone, mesh) in pack.bones.iter().enumerate() {
        let base = (vertices.len() / 7) as u32;
        for vertex in mesh.vertices.chunks_exact(6) {
            vertices.extend_from_slice(&vertex[..6]);
            // The bone index rides in the vertex as a bit pattern rather than a number, because
            // the attribute is declared `uint` and this buffer is floats.
            vertices.push(f32::from_bits(bone as u32));
        }
        indices.extend(mesh.indices.iter().map(|i| i + base));
    }
    for hand in 0..CONTROLLERS {
        cube(slots.controller(hand) as u32, CONTROLLER_EDGE, &mut vertices, &mut indices);
    }
    for hand in 0..MARKERS {
        cube(slots.marker(hand) as u32, MARKER_EDGE, &mut vertices, &mut indices);
    }
    grid(slots.stage as u32, &mut vertices, &mut indices);
    for hand in 0..RAYS {
        ray(slots.ray(hand) as u32, &mut vertices, &mut indices);
    }
    (vertices, indices)
}

/// An aim ray's shape: a box one unit across and one long, running from its slot's origin down
/// -Z, the way OpenXR's aim pose points. The frame loop scales it by the ray's width across and
/// its length along, so one box serves every length, and a ray with nowhere to go is scaled to
/// nothing rather than drawn.
fn ray(slot: u32, vertices: &mut Vec<f32>, indices: &mut Vec<u32>) {
    let first = vertices.len();
    cube(slot, 1.0, vertices, indices);
    // The unit cube is centred on the origin; half a unit down -Z puts its near face there.
    for vertex in vertices[first..].chunks_exact_mut(7) {
        vertex[2] -= 0.5;
    }
}

/// The matrix an aim ray is drawn by: the aim pose, then the unit ray stretched to `length` and
/// thinned to `RAY_WIDTH`. Scaling a unit box unevenly is safe for its lighting: every face's
/// normal lies along an axis of the scale, so the shader's normalize restores it exactly.
pub(crate) fn ray_matrix(position: [f32; 3], orientation: [f32; 4], length: f32) -> [f32; 16] {
    let thin: [f32; 16] = [
        RAY_WIDTH, 0.0, 0.0, 0.0, //
        0.0, RAY_WIDTH, 0.0, 0.0, //
        0.0, 0.0, length, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ];
    multiply(&pose_matrix(position, orientation), &thin)
}

/// A static box as six flat faces, its half extents turned by its rotation and carried to its
/// position, all in the simulation's frame.
pub(crate) fn posed_box(slot: u32, b: &crate::bridge::StaticBox, vertices: &mut Vec<f32>, indices: &mut Vec<u32>) {
    let r = rotation(b.rotation);
    let turn = |v: [f32; 3]| {
        [
            r[0] * v[0] + r[3] * v[1] + r[6] * v[2],
            r[1] * v[0] + r[4] * v[1] + r[7] * v[2],
            r[2] * v[0] + r[5] * v[1] + r[8] * v[2],
        ]
    };
    let faces: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
        ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
        ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
    ];
    let h = b.half_extents;
    for (n, u, v) in faces {
        let base = (vertices.len() / 7) as u32;
        let normal = turn(n);
        for (su, sv) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            let local = [
                h[0] * (n[0] + su * u[0] + sv * v[0]),
                h[1] * (n[1] + su * u[1] + sv * v[1]),
                h[2] * (n[2] + su * u[2] + sv * v[2]),
            ];
            let p = turn(local);
            vertices.extend_from_slice(&[
                p[0] + b.position[0],
                p[1] + b.position[1],
                p[2] + b.position[2],
                normal[0],
                normal[1],
                normal[2],
                f32::from_bits(slot),
            ]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

/// The floor: lines every half metre out to five, as flat strips a hair above y = 0 so nothing
/// fights them, the two through the origin twice as wide. Normals up, so the key light lights it.
fn grid(slot: u32, vertices: &mut Vec<f32>, indices: &mut Vec<u32>) {
    let count = (GRID_REACH / GRID_SPACING) as i32;
    let y = 0.001;
    let mut strip = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]| {
        let base = (vertices.len() / 7) as u32;
        for p in [a, b, c, d] {
            vertices.extend_from_slice(&[p[0], p[1], p[2], 0.0, 1.0, 0.0, f32::from_bits(slot)]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    };
    for i in -count..=count {
        let at = i as f32 * GRID_SPACING;
        let w = if i == 0 { GRID_WIDTH * 2.0 } else { GRID_WIDTH } / 2.0;
        // Along Z at x = at, and along X at z = at.
        strip(
            [at - w, y, -GRID_REACH],
            [at + w, y, -GRID_REACH],
            [at + w, y, GRID_REACH],
            [at - w, y, GRID_REACH],
        );
        strip(
            [-GRID_REACH, y, at - w],
            [GRID_REACH, y, at - w],
            [GRID_REACH, y, at + w],
            [-GRID_REACH, y, at + w],
        );
    }
}

/// The triangles of every belly's tube, which depend only on the counts: ring `r` and ring `r+1`
/// of a unit are joined by a strip of `segments` quads, and units are not joined to each other.
pub(crate) fn tube_indices(units: usize, rings: usize, segments: usize) -> Vec<u32> {
    let mut indices = Vec::with_capacity(units * (rings - 1) * segments * 6);
    for unit in 0..units {
        for ring in 0..rings - 1 {
            let a = ((unit * rings + ring) * segments) as u32;
            let b = a + segments as u32;
            for k in 0..segments as u32 {
                let next = (k + 1) % segments as u32;
                // Outward, as the studio's sweep is: round the ring, then along it.
                indices.extend_from_slice(&[a + k, a + next, b + k, a + next, b + next, b + k]);
            }
        }
    }
    indices
}

/// Sweep every ring into `segments` vertices, seven floats each in the pack's vertex layout, all
/// owned by `slot`. `rings` is eight floats a ring -- centre, orientation, radius -- as the muscle
/// bridge carries them. Vertex `k` of a ring sits at angle `2 pi k / segments` in the ring's own
/// XY plane, and its normal is that same direction: the ring is a circle, so radial is normal.
///
/// `tension` is each unit's tendon force as a fraction of its maximum, in unit order, with
/// `rings_per_unit` rings to a unit; a unit with one carries a colour code from slack to taut
/// instead of `slot`, and the shader draws it under the world slot regardless.
pub fn tube_vertices(
    rings: &[f32],
    rings_per_unit: usize,
    segments: usize,
    slot: u32,
    tension: &[f32],
    out: &mut Vec<f32>,
) {
    out.clear();
    out.reserve(rings.len() / 8 * segments * 7);
    for (index, ring) in rings.chunks_exact(8).enumerate() {
        let unit = index / rings_per_unit.max(1);
        let slot = match tension.get(unit) {
            Some(t) if t.is_finite() => {
                TINT_BASE + (t.clamp(0.0, 1.0) * (TINT_STEPS - 1) as f32).round() as u32
            }
            _ => slot,
        };
        let centre = [ring[0], ring[1], ring[2]];
        let r = rotation([ring[3], ring[4], ring[5], ring[6]]);
        let radius = ring[7];
        for k in 0..segments {
            let angle = std::f32::consts::TAU * k as f32 / segments as f32;
            let (sin, cos) = angle.sin_cos();
            // The ring's X and Y columns, mixed by the angle: column-major, so X is r[0..3].
            let n = [
                r[0] * cos + r[3] * sin,
                r[1] * cos + r[4] * sin,
                r[2] * cos + r[5] * sin,
            ];
            out.extend_from_slice(&[
                centre[0] + radius * n[0],
                centre[1] + radius * n[1],
                centre[2] + radius * n[2],
                n[0],
                n[1],
                n[2],
                f32::from_bits(slot),
            ]);
        }
    }
}

/// A cube of edge `edge` about the origin, six flat-shaded faces, owned by one slot.
/// The slot's matrix is the grip pose, so the cube sits in the hand wherever the hand is.
fn cube(slot: u32, edge: f32, vertices: &mut Vec<f32>, indices: &mut Vec<u32>) {
    let h = edge / 2.0;
    // (normal, u, v) with u x v = normal, so the corners below wind the same way every face.
    let faces: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
        ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
        ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
    ];
    for (n, u, v) in faces {
        let base = (vertices.len() / 7) as u32;
        for (su, sv) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            for axis in 0..3 {
                vertices.push(h * (n[axis] + su * u[axis] + sv * v[axis]));
            }
            vertices.extend_from_slice(&n);
            vertices.push(f32::from_bits(slot));
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(m: &[f32; 16], v: [f32; 4]) -> [f32; 4] {
        let mut out = [0f32; 4];
        for row in 0..4 {
            for k in 0..4 {
                out[row] += m[k * 4 + row] * v[k];
            }
        }
        out
    }

    #[test]
    fn a_ring_sweeps_into_a_circle_of_its_radius_with_radial_normals() {
        // One ring at the identity, centred at y = 1, radius 0.05, four segments: the vertices
        // are the four compass points of a circle in the XY plane, and each normal points out.
        let ring = [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.05];
        let mut out = Vec::new();
        tube_vertices(&ring, 1, 4, 7, &[], &mut out);
        assert_eq!(out.len(), 4 * 7);
        let v = |k: usize| &out[k * 7..k * 7 + 7];
        assert!((v(0)[0] - 0.05).abs() < 1e-6 && (v(0)[1] - 1.0).abs() < 1e-6);
        assert!((v(1)[1] - 1.05).abs() < 1e-6, "quarter turn is +Y: {:?}", v(1));
        assert!((v(2)[0] + 0.05).abs() < 1e-6);
        assert!((v(3)[1] - 0.95).abs() < 1e-6);
        assert!((v(1)[4] - 1.0).abs() < 1e-6, "normal of the +Y vertex is +Y");
        assert_eq!(v(0)[6].to_bits(), 7);
        // Two rings of four make one strip of four quads: 24 indices, none past the 8 vertices.
        let idx = tube_indices(1, 2, 4);
        assert_eq!(idx.len(), 24);
        assert!(idx.iter().all(|&i| i < 8));
        // Units are not stitched: the last index of unit 0 never reaches unit 1's vertices.
        let two = tube_indices(2, 2, 4);
        assert!(two[..24].iter().all(|&i| i < 8) && two[24..].iter().all(|&i| i >= 8));
    }

    #[test]
    fn a_ray_runs_from_the_hand_down_its_aim_to_the_length_asked_for() {
        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        ray(213, &mut vertices, &mut indices);
        assert_eq!(indices.len(), 36);
        let mut z = (f32::MAX, f32::MIN);
        for v in vertices.chunks_exact(7) {
            assert_eq!(v[6].to_bits(), 213);
            assert!(v[0].abs() <= 0.5 + 1e-6 && v[1].abs() <= 0.5 + 1e-6);
            z = (z.0.min(v[2]), z.1.max(v[2]));
        }
        assert_eq!(z, (-1.0, 0.0), "the unit ray spans z in [-1, 0]");

        // Aimed straight ahead from a hand at (0.1, 1.2, -0.3): the ray ends 0.8 m down -Z, and
        // is RAY_WIDTH thick about the aim axis.
        let identity = [0.0, 0.0, 0.0, 1.0];
        let m = ray_matrix([0.1, 1.2, -0.3], identity, 0.8);
        let near = apply(&m, [0.0, 0.0, 0.0, 1.0]);
        let far = apply(&m, [0.0, 0.0, -1.0, 1.0]);
        let edge = apply(&m, [0.5, 0.0, -1.0, 1.0]);
        let close = |a: [f32; 4], b: [f32; 3]| (0..3).all(|i| (a[i] - b[i]).abs() < 1e-5);
        assert!(close(near, [0.1, 1.2, -0.3]), "{near:?}");
        assert!(close(far, [0.1, 1.2, -1.1]), "{far:?}");
        assert!(close(edge, [0.1 + RAY_WIDTH / 2.0, 1.2, -1.1]), "{edge:?}");

        // Turned a quarter to the left about Y, the aim points down -X, and the ray with it.
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let far = apply(&ray_matrix([0.0, 0.0, 0.0], [0.0, s, 0.0, s], 2.0), [0.0, 0.0, -1.0, 1.0]);
        assert!(close(far, [-2.0, 0.0, 0.0]), "{far:?}");
    }
}
