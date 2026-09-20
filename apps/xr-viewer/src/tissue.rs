//! The connective tissue, in the room.
//!
//! The studio's status carries a table of what is neither bone nor muscle: a disc or a bead at
//! every held joint, in its parent bone's frame, and a bar of cartilage between two points in two
//! bones' frames. The headset already has every bone's pose, so the shapes are built here from
//! the poses each frame -- the same shapes the studio's overlay draws and its export writes
//! (`apps/studio/src/tissue.ts`), so the two agree.
//!
//! The connectivity is fixed once from the table; the vertices are rebuilt each pose. A vertex
//! carries a colour code in its slot (`render::CODE_DISC` and so on) rather than a bone, and the
//! shader draws it under the world slot, like a muscle tube.

use crate::bridge::Tissue;
use crate::render::{CODE_BAR, CODE_BEAD, CODE_DISC, TINT_BASE};

pub const DISC_RADIUS: f32 = 0.014;
pub const DISC_HEIGHT: f32 = 0.005;
pub const BEAD_RADIUS: f32 = 0.006;
pub const BAR_RADIUS: f32 = 0.004;
const DISC_SIDES: usize = 16;
const BEAD_RINGS: usize = 6;
const BEAD_SIDES: usize = 8;
const BAR_SIDES: usize = 6;

/// A shape rigid in one bone: its vertices and normals in that bone's frame, and the bone.
struct Rigid {
    bone: usize,
    code: u32,
    /// (position, normal) pairs.
    local: Vec<([f32; 3], [f32; 3])>,
}

/// A bar between a point in one bone and a point in another.
struct Bar {
    bone_a: usize,
    local_a: [f32; 3],
    bone_b: usize,
    local_b: [f32; 3],
}

/// The tissue's fixed part: what each vertex is attached to, and how the vertices connect.
pub struct TissueShape {
    rigid: Vec<Rigid>,
    bars: Vec<Bar>,
    pub indices: Vec<u32>,
    pub vertex_count: usize,
}

impl TissueShape {
    /// From the status's table and the bridge's bone order; entries naming a bone the bridge
    /// does not carry are left out.
    pub fn new(tissue: &Tissue, names: &[String]) -> Self {
        let find = |name: &str| names.iter().position(|n| n == name);
        let mut rigid = Vec::new();
        let mut bars = Vec::new();
        let mut indices = Vec::new();
        let mut vertex_count = 0usize;
        for disc in &tissue.discs {
            let Some(bone) = find(&disc.bone) else { continue };
            let (mesh, code) = if disc.kind == "bead" {
                (sphere(BEAD_RADIUS, BEAD_RINGS, BEAD_SIDES), CODE_BEAD)
            } else {
                (cylinder(DISC_RADIUS, DISC_HEIGHT, DISC_SIDES), CODE_DISC)
            };
            let local = mesh
                .0
                .iter()
                .map(|(p, n)| {
                    let turned = crate::render::rotate(*p, disc.rotation);
                    (
                        [
                            turned[0] + disc.position[0],
                            turned[1] + disc.position[1],
                            turned[2] + disc.position[2],
                        ],
                        crate::render::rotate(*n, disc.rotation),
                    )
                })
                .collect::<Vec<_>>();
            let base = vertex_count as u32;
            indices.extend(mesh.1.iter().map(|i| base + i));
            vertex_count += local.len();
            rigid.push(Rigid { bone, code, local });
        }
        for bar in &tissue.bars {
            let (Some(bone_a), Some(bone_b)) = (find(&bar.bone_a), find(&bar.bone_b)) else {
                continue;
            };
            let base = vertex_count as u32;
            for i in 0..BAR_SIDES as u32 {
                let j = (i + 1) % BAR_SIDES as u32;
                let s = BAR_SIDES as u32;
                // Outward: round the near end, then along to the far one.
                indices.extend_from_slice(&[
                    base + i,
                    base + j,
                    base + s + i,
                    base + j,
                    base + s + j,
                    base + s + i,
                ]);
            }
            vertex_count += 2 * BAR_SIDES;
            bars.push(Bar {
                bone_a,
                local_a: bar.local_a,
                bone_b,
                local_b: bar.local_b,
            });
        }
        Self {
            rigid,
            bars,
            indices,
            vertex_count,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.vertex_count == 0
    }

    /// The vertices for this pose (`bones * 7`: position xyz, orientation xyzw, in the bridge's
    /// order), seven floats each as the renderer wants them.
    pub fn vertices(&self, pose: &[f32], out: &mut Vec<f32>) {
        out.clear();
        out.reserve(self.vertex_count * 7);
        let at = |bone: usize| {
            let p = &pose[bone * 7..bone * 7 + 7];
            ([p[0], p[1], p[2]], [p[3], p[4], p[5], p[6]])
        };
        for shape in &self.rigid {
            let (position, q) = at(shape.bone);
            for (p, n) in &shape.local {
                let world = crate::render::rotate(*p, q);
                let normal = crate::render::rotate(*n, q);
                out.extend_from_slice(&[
                    world[0] + position[0],
                    world[1] + position[1],
                    world[2] + position[2],
                    normal[0],
                    normal[1],
                    normal[2],
                    f32::from_bits(TINT_BASE + shape.code),
                ]);
            }
        }
        for bar in &self.bars {
            let (pa, qa) = at(bar.bone_a);
            let (pb, qb) = at(bar.bone_b);
            let a = add(crate::render::rotate(bar.local_a, qa), pa);
            let b = add(crate::render::rotate(bar.local_b, qb), pb);
            let axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let length = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt().max(1e-6);
            let n = [axis[0] / length, axis[1] / length, axis[2] / length];
            let pick = if n[1].abs() < 0.9 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] };
            let u = normalize(cross(n, pick));
            let v = cross(n, u);
            for end in [a, b] {
                for i in 0..BAR_SIDES {
                    let angle = std::f32::consts::TAU * i as f32 / BAR_SIDES as f32;
                    let (s, c) = angle.sin_cos();
                    let normal = [
                        u[0] * c + v[0] * s,
                        u[1] * c + v[1] * s,
                        u[2] * c + v[2] * s,
                    ];
                    out.extend_from_slice(&[
                        end[0] + normal[0] * BAR_RADIUS,
                        end[1] + normal[1] * BAR_RADIUS,
                        end[2] + normal[2] * BAR_RADIUS,
                        normal[0],
                        normal[1],
                        normal[2],
                        f32::from_bits(TINT_BASE + CODE_BAR),
                    ]);
                }
            }
        }
    }
}

type Mesh = (Vec<([f32; 3], [f32; 3])>, Vec<u32>);

/// A closed cylinder along local Y, centred at the origin: the studio's `cylinderMesh`.
fn cylinder(radius: f32, height: f32, sides: usize) -> Mesh {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    let h = height / 2.0;
    for i in 0..sides {
        let a = std::f32::consts::TAU * i as f32 / sides as f32;
        let (s, c) = a.sin_cos();
        vertices.push(([radius * c, h, radius * s], [c, 0.0, s]));
        vertices.push(([radius * c, -h, radius * s], [c, 0.0, s]));
    }
    let top = vertices.len() as u32;
    vertices.push(([0.0, h, 0.0], [0.0, 1.0, 0.0]));
    let bottom = top + 1;
    vertices.push(([0.0, -h, 0.0], [0.0, -1.0, 0.0]));
    for i in 0..sides as u32 {
        let n = (i + 1) % sides as u32;
        let (a0, a1, b0, b1) = (2 * i, 2 * i + 1, 2 * n, 2 * n + 1);
        indices.extend_from_slice(&[a0, b0, a1, b0, b1, a1, top, b0, a0, bottom, a1, b1]);
    }
    (vertices, indices)
}

/// A sphere centred at the origin: the studio's `sphereMesh`.
fn sphere(radius: f32, rings: usize, sides: usize) -> Mesh {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for r in 0..=rings {
        let phi = std::f32::consts::PI * r as f32 / rings as f32;
        for s in 0..=sides {
            let theta = std::f32::consts::TAU * s as f32 / sides as f32;
            let n = [phi.sin() * theta.cos(), phi.cos(), phi.sin() * theta.sin()];
            vertices.push(([radius * n[0], radius * n[1], radius * n[2]], n));
        }
    }
    let row = (sides + 1) as u32;
    for r in 0..rings as u32 {
        for s in 0..sides as u32 {
            let a = r * row + s;
            let b = a + row;
            // Outward, as the studio's sphere is: round the ring, then down to the next.
            indices.extend_from_slice(&[a, a + 1, b, a + 1, b + 1, b]);
        }
    }
    (vertices, indices)
}

fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn normalize(a: [f32; 3]) -> [f32; 3] {
    let n = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt().max(1e-6);
    [a[0] / n, a[1] / n, a[2] / n]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{TissueBar, TissueDisc};

    #[test]
    fn a_disc_rides_its_bone_and_a_bar_spans_two() {
        let names = vec!["l5".to_string(), "sacrum".to_string()];
        let tissue = Tissue {
            discs: vec![
                TissueDisc {
                    bone: "l5".into(),
                    kind: "disc".into(),
                    position: [0.0, 0.1, 0.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                },
                TissueDisc {
                    bone: "nowhere".into(),
                    kind: "bead".into(),
                    position: [0.0; 3],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                },
            ],
            bars: vec![TissueBar {
                bone_a: "l5".into(),
                local_a: [0.0; 3],
                bone_b: "sacrum".into(),
                local_b: [0.0; 3],
            }],
        };
        let shape = TissueShape::new(&tissue, &names);
        // The disc's 34 vertices and the bar's 12; the bead names no bone and is left out.
        assert_eq!(shape.vertex_count, 34 + 12);
        assert_eq!(shape.indices.len(), 16 * 12 + 6 * 6);
        assert!(shape.indices.iter().all(|&i| (i as usize) < shape.vertex_count));
        // l5 a metre up, the sacrum at the origin: the disc's centre lands at 1.1 m, the bar
        // runs from 1 m down to 0.
        let pose = [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        let mut out = Vec::new();
        shape.vertices(&pose, &mut out);
        assert_eq!(out.len(), shape.vertex_count * 7);
        let top = &out[32 * 7..32 * 7 + 3];
        assert!((top[1] - (1.1 + DISC_HEIGHT / 2.0)).abs() < 1e-6, "{top:?}");
        let bar_a = &out[34 * 7..34 * 7 + 3];
        let bar_b = &out[40 * 7..40 * 7 + 3];
        assert!((bar_a[1] - 1.0).abs() < BAR_RADIUS + 1e-6 && bar_b[1].abs() < BAR_RADIUS + 1e-6);
        assert_eq!(out[6].to_bits(), TINT_BASE + CODE_DISC);
        assert_eq!(out[34 * 7 + 6].to_bits(), TINT_BASE + CODE_BAR);
    }
}
