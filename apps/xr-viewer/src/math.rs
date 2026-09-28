//! The small linear algebra the viewer draws and aims with: column-major 4x4 matrices as GLSL
//! reads them, xyzw quaternions as OpenXR gives them, the eyes' asymmetric projections, and the
//! placement that stands the simulation's body in the room.
//!
//! Plain arrays and free functions, as they were inside the renderer. Every convention here --
//! column-major, Vulkan's depth range and downward Y, the placement's half turn rather than a
//! mirror -- is pinned by a test below, because each one gets a headset scene wrong in a way that
//! looks like some other bug.

/// Where the body is put relative to the stage origin, and which way it faces.
///
/// The pack stands the body at the origin with its feet at zero and its front toward -Z, and
/// OpenXR's stage space has the viewer facing -Z as well -- so left alone the two face the same
/// way and you arrive behind it. It is moved a metre and a half out and turned around, which puts
/// you looking at its front from across the room.
const STANDS_AT: [f32; 3] = [0.0, 0.0, -1.5];

/// Where the body stands and which way it faces: the matrix every bone is placed by. The
/// simulation's ground is lifted to the stage's floor, so a scenario with a raised ground still
/// has the body standing on the grid.
pub(crate) fn placement(ground_height: f32) -> [f32; 16] {
    translation(STANDS_AT[0], STANDS_AT[1] - ground_height, STANDS_AT[2], true)
}

/// The inverse of the placement, for a point: where in the simulation's own frame a point in the
/// room is. Rotation by half a turn about Y is its own inverse, so this is subtract, then flip.
pub(crate) fn unplace(p: [f32; 3], ground_height: f32) -> [f32; 3] {
    [
        -(p[0] - STANDS_AT[0]),
        p[1] - (STANDS_AT[1] - ground_height),
        -(p[2] - STANDS_AT[2]),
    ]
}

/// A rotation in the room, in the simulation's frame: conjugated by the placement's half turn
/// about Y, which is its own inverse.
pub(crate) fn unplace_rotation(q: [f32; 4]) -> [f32; 4] {
    let half_turn = [0.0, 1.0, 0.0, 0.0];
    quaternion_multiply(quaternion_multiply(half_turn, q), quaternion_conjugate(half_turn))
}

/// `a` then `b`, as xyzw quaternions: the rotation `b` applied after `a`... which is to say the
/// product `a * b` in the convention where `q * v` turns `v` by `q`.
pub(crate) fn quaternion_multiply(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

pub(crate) fn quaternion_conjugate(q: [f32; 4]) -> [f32; 4] {
    [-q[0], -q[1], -q[2], q[3]]
}

/// A uniform scale, which is how a pack at one stature is drawn at another.
pub(crate) fn scale_matrix(s: f32) -> [f32; 16] {
    [
        s, 0.0, 0.0, 0.0, //
        0.0, s, 0.0, 0.0, //
        0.0, 0.0, s, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ]
}

/// A rigid transform from a position and a quaternion, column-major.
pub(crate) fn pose_matrix(p: [f32; 3], q: [f32; 4]) -> [f32; 16] {
    let r = rotation(q);
    [
        r[0], r[1], r[2], 0.0, //
        r[3], r[4], r[5], 0.0, //
        r[6], r[7], r[8], 0.0, //
        p[0], p[1], p[2], 1.0,
    ]
}

/// The inverse of that: rotation transposed, translation carried back through it.
pub(crate) fn inverse_pose(p: [f32; 3], q: [f32; 4]) -> [f32; 16] {
    let r = rotation(q);
    let t = [
        -(r[0] * p[0] + r[1] * p[1] + r[2] * p[2]),
        -(r[3] * p[0] + r[4] * p[1] + r[5] * p[2]),
        -(r[6] * p[0] + r[7] * p[1] + r[8] * p[2]),
    ];
    [
        r[0], r[3], r[6], 0.0, //
        r[1], r[4], r[7], 0.0, //
        r[2], r[5], r[8], 0.0, //
        t[0], t[1], t[2], 1.0,
    ]
}

/// A vector turned by a quaternion.
pub(crate) fn rotate(v: [f32; 3], q: [f32; 4]) -> [f32; 3] {
    let r = rotation(q);
    [
        r[0] * v[0] + r[3] * v[1] + r[6] * v[2],
        r[1] * v[0] + r[4] * v[1] + r[7] * v[2],
        r[2] * v[0] + r[5] * v[1] + r[8] * v[2],
    ]
}

/// A quaternion as a 3x3 rotation, column-major.
pub(crate) fn rotation(q: [f32; 4]) -> [f32; 9] {
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    [
        1.0 - 2.0 * (y * y + z * z),
        2.0 * (x * y + z * w),
        2.0 * (x * z - y * w),
        2.0 * (x * y - z * w),
        1.0 - 2.0 * (x * x + z * z),
        2.0 * (y * z + x * w),
        2.0 * (x * z + y * w),
        2.0 * (y * z - x * w),
        1.0 - 2.0 * (x * x + y * y),
    ]
}

/// A plain translation, column-major.
pub(crate) fn translation_matrix(t: [f32; 3]) -> [f32; 16] {
    translation(t[0], t[1], t[2], false)
}

/// A translation, optionally turned half a circle about Y so the body faces the viewer.
fn translation(x: f32, y: f32, z: f32, facing_viewer: bool) -> [f32; 16] {
    let s = if facing_viewer { -1.0 } else { 1.0 };
    // Column-major, as GLSL reads it.
    [
        s, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, s, 0.0, //
        x, y, z, 1.0,
    ]
}

/// The two view-projection matrices for this frame, column-major, as the shader expects them.
pub fn view_projections(views: &[openxr::View], near: f32, far: f32) -> [f32; 32] {
    let mut out = [0f32; 32];
    for (eye, view) in views.iter().take(2).enumerate() {
        let projection = projection_from_fov(view.fov, near, far);
        let view_matrix = inverse_rigid(view.pose);
        let product = multiply(&projection, &view_matrix);
        out[eye * 16..eye * 16 + 16].copy_from_slice(&product);
    }
    out
}

/// An asymmetric projection, which is what a headset's four half-angles describe.
///
/// Not a field of view and an aspect ratio: a lens is off-centre and its four angles differ, so
/// the frustum is built from the tangents directly. Reverse-Z is not used and depth compares LESS,
/// so this maps near to 0 and far to 1 the Vulkan way rather than the OpenGL way.
fn projection_from_fov(fov: openxr::Fovf, near: f32, far: f32) -> [f32; 16] {
    let left = fov.angle_left.tan();
    let right = fov.angle_right.tan();
    let up = fov.angle_up.tan();
    let down = fov.angle_down.tan();
    let width = right - left;
    let height = down - up; // Vulkan's Y points down the screen, so this is deliberately inverted.
    [
        2.0 / width, 0.0, 0.0, 0.0, //
        0.0, 2.0 / height, 0.0, 0.0, //
        (right + left) / width, (down + up) / height, -far / (far - near), -1.0, //
        0.0, 0.0, -(far * near) / (far - near), 0.0,
    ]
}

/// The inverse of a pose, which is the view matrix.
fn inverse_rigid(pose: openxr::Posef) -> [f32; 16] {
    inverse_pose(
        [pose.position.x, pose.position.y, pose.position.z],
        [pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w],
    )
}

pub(crate) fn multiply(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut out = [0f32; 16];
    for column in 0..4 {
        for row in 0..4 {
            let mut sum = 0.0;
            for k in 0..4 {
                sum += a[k * 4 + row] * b[column * 4 + k];
            }
            out[column * 4 + row] = sum;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fov and pose the Index actually reported, so these are this headset's numbers rather
    /// than plausible ones.
    fn left_eye() -> openxr::Fovf {
        openxr::Fovf {
            angle_left: -1.00,
            angle_right: 0.81,
            angle_up: 0.96,
            angle_down: -0.95,
        }
    }

    fn apply(m: &[f32; 16], v: [f32; 4]) -> [f32; 4] {
        let mut out = [0f32; 4];
        for row in 0..4 {
            for k in 0..4 {
                out[row] += m[k * 4 + row] * v[k];
            }
        }
        out
    }

    fn ndc(m: &[f32; 16], point: [f32; 3]) -> [f32; 3] {
        let clip = apply(m, [point[0], point[1], point[2], 1.0]);
        [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]]
    }

    #[test]
    fn depth_maps_near_to_zero_and_far_to_one() {
        // Vulkan's convention, and the one the pipeline's LESS compare assumes. Getting this
        // backwards is a depth test that keeps the furthest surface, which looks like a skeleton
        // turned inside out rather than like a depth bug.
        let p = projection_from_fov(left_eye(), 0.05, 50.0);
        let near = ndc(&p, [0.0, 0.0, -0.05]);
        let far = ndc(&p, [0.0, 0.0, -50.0]);
        assert!((near[2] - 0.0).abs() < 1e-4, "near mapped to {}", near[2]);
        assert!((far[2] - 1.0).abs() < 1e-4, "far mapped to {}", far[2]);
    }

    #[test]
    fn the_fov_edges_land_on_the_edges_of_the_screen() {
        // The check that an asymmetric frustum is being built from the four half-angles rather
        // than from a symmetric field of view: each edge of the reported fov has to arrive at
        // exactly the corresponding edge of clip space, and they are not symmetric.
        let fov = left_eye();
        let p = projection_from_fov(fov, 0.05, 50.0);
        let at = -1.0f32;
        let left = ndc(&p, [fov.angle_left.tan() * -at, 0.0, at]);
        let right = ndc(&p, [fov.angle_right.tan() * -at, 0.0, at]);
        let up = ndc(&p, [0.0, fov.angle_up.tan() * -at, at]);
        let down = ndc(&p, [0.0, fov.angle_down.tan() * -at, at]);
        assert!((left[0] + 1.0).abs() < 1e-4, "left edge at x={}", left[0]);
        assert!((right[0] - 1.0).abs() < 1e-4, "right edge at x={}", right[0]);
        // Vulkan's Y runs down the framebuffer, so "up" in the world is -1 in clip space. An
        // unflipped Y is a scene rendered upside down, which in a headset is unmistakable and
        // deeply unpleasant.
        assert!((up[1] + 1.0).abs() < 1e-4, "up edge at y={}", up[1]);
        assert!((down[1] - 1.0).abs() < 1e-4, "down edge at y={}", down[1]);
    }

    #[test]
    fn straight_ahead_is_off_centre_because_the_lens_is() {
        // Not a symmetry check but the opposite: this headset's left eye sees 1.00 rad to its
        // left and 0.81 to its right, so the view axis is genuinely right of the image centre.
        // A projection that put it at zero would be one built from a single field of view.
        let p = projection_from_fov(left_eye(), 0.05, 50.0);
        let ahead = ndc(&p, [0.0, 0.0, -1.0]);
        assert!(ahead[0] > 0.10 && ahead[0] < 0.30, "ahead at x={}", ahead[0]);
    }

    #[test]
    fn the_view_matrix_undoes_the_eye_pose() {
        // A rigid inverse, checked the only way worth checking it: the eye's own position has to
        // land at the origin of view space, and a point a metre in front of a turned head has to
        // arrive a metre down -Z however the head is turned.
        let angle = 0.7f32;
        let pose = openxr::Posef {
            orientation: openxr::Quaternionf {
                x: 0.0,
                y: (angle / 2.0).sin(),
                z: 0.0,
                w: (angle / 2.0).cos(),
            },
            position: openxr::Vector3f {
                x: 0.3,
                y: 1.6,
                z: -0.2,
            },
        };
        let view = inverse_rigid(pose);
        let eye = apply(&view, [0.3, 1.6, -0.2, 1.0]);
        for k in 0..3 {
            assert!(eye[k].abs() < 1e-5, "the eye did not land at the origin: {eye:?}");
        }
        // One metre along the direction the head is facing, which for a +Y rotation of `angle`
        // from -Z is (-sin, 0, -cos).
        let front = [
            0.3 - angle.sin(),
            1.6,
            -0.2 - angle.cos(),
        ];
        let seen = apply(&view, [front[0], front[1], front[2], 1.0]);
        assert!(seen[0].abs() < 1e-5 && seen[1].abs() < 1e-5, "not straight ahead: {seen:?}");
        assert!((seen[2] + 1.0).abs() < 1e-5, "not one metre away: {seen:?}");
    }

    #[test]
    fn unplace_takes_a_room_point_back_to_where_the_simulation_thinks_it_is() {
        let sim = [0.2, 1.1, 0.3];
        let room = apply(&placement(0.0), [sim[0], sim[1], sim[2], 1.0]);
        let back = unplace([room[0], room[1], room[2]], 0.0);
        for axis in 0..3 {
            assert!((back[axis] - sim[axis]).abs() < 1e-6, "axis {axis}: {back:?}");
        }
    }

    #[test]
    fn a_rotation_in_the_room_matches_the_same_rotation_of_a_placed_vector() {
        // Turn a vector by q in the room, take it into the simulation's frame; that must equal
        // taking the vector into the simulation's frame and turning it by unplace_rotation(q).
        // Only directions, so the ground and the standing spot fall out.
        let q: [f32; 4] = [0.2, 0.5, -0.1, 0.83]; // normalised just below
        let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        let q = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
        let v = [0.3, 0.1, 0.7];
        let flip = |p: [f32; 3]| [-p[0], p[1], -p[2]];
        let a = flip(rotate(v, q));
        let b = rotate(flip(v), unplace_rotation(q));
        for axis in 0..3 {
            assert!((a[axis] - b[axis]).abs() < 1e-5, "{a:?} vs {b:?}");
        }
        let id = quaternion_multiply(q, quaternion_conjugate(q));
        assert!((id[3] - 1.0).abs() < 1e-5 && id[0].abs() < 1e-5);
    }

    #[test]
    fn the_body_is_turned_to_face_the_viewer_without_being_mirrored() {
        // Half a turn about Y, which has determinant +1. A mirror would also put the front
        // towards the viewer and would swap the body's left and right, which on an anatomical
        // model is the kind of wrong that gets published before anybody notices.
        let m = translation(0.0, 0.0, -1.5, true);
        let determinant = m[0] * m[5] * m[10];
        assert!((determinant - 1.0).abs() < 1e-6, "determinant {determinant}");
        // Anterior is -Z in the pack, and after the turn it points back towards the viewer.
        let anterior = apply(&m, [0.0, 0.0, -1.0, 0.0]);
        assert!(anterior[2] > 0.99, "the body faces away: {anterior:?}");
        // And it stands a metre and a half out, feet still on the floor.
        let feet = apply(&m, [0.0, 0.0, 0.0, 1.0]);
        assert_eq!([feet[0], feet[1], feet[2]], [0.0, 0.0, -1.5]);
    }
}
