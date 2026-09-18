//! Reading the skeleton mesh pack, which is two files and no library.
//!
//! `manifest.json` describes two hundred bones; `skeleton.bin` is every vertex position as f32
//! followed by every index as u32, one contiguous run each. A bone names its slice of both. The
//! indices are local to their bone -- they start at zero and address that bone's own vertices --
//! so a bone is a standalone mesh once its two slices are cut out.
//!
//! What the pack does not carry is normals. The web renderer computes them at load and so does
//! this, the same way: accumulate each triangle's cross product into its three vertices and
//! normalise. That weights by triangle area, which is what makes a curved bone shade smoothly
//! without a smoothing-angle threshold to tune.
//!
//! Nothing here touches Vulkan or OpenXR, which is deliberate. It is the half of this crate that
//! can be checked on a machine with no headset attached, and `--check-pack` is what checks it.

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::path::Path;

/// The manifest's own description of a bone. `centroid`, `min` and `max` are unused by the
/// renderer and kept because they are the manifest, and because a pose pipeline indexes by them.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct PackedBone {
    pub id: String,
    #[serde(rename = "vertexOffset")]
    pub vertex_offset: usize,
    #[serde(rename = "vertexCount")]
    pub vertex_count: usize,
    #[serde(rename = "indexOffset")]
    pub index_offset: usize,
    #[serde(rename = "indexCount")]
    pub index_count: usize,
    pub centroid: [f64; 3],
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[derive(Debug, Deserialize)]
pub struct Totals {
    pub vertices: usize,
    pub triangles: usize,
}

#[derive(Debug, Deserialize)]
pub struct Dataset {
    pub name: String,
    pub license: String,
    pub attribution: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub dataset: Dataset,
    #[serde(rename = "subjectStature")]
    pub subject_stature: f64,
    pub units: String,
    pub bones: Vec<PackedBone>,
    pub totals: Totals,
}

/// One bone, ready to hand to a graphics API: interleaved position and normal, local indices.
pub struct BoneMesh {
    /// Read by diagnostics rather than by the renderer, which draws every bone in one call.
    #[allow(dead_code)]
    pub id: String,
    /// `vertex_count * 6` floats: x, y, z, nx, ny, nz.
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
}

pub struct Pack {
    pub manifest: Manifest,
    pub bones: Vec<BoneMesh>,
}

impl Pack {
    pub fn vertex_count(&self) -> usize {
        self.bones.iter().map(|b| b.vertices.len() / 6).sum()
    }

    pub fn triangle_count(&self) -> usize {
        self.bones.iter().map(|b| b.indices.len() / 3).sum()
    }

    /// Axis-aligned bounds over every vertex, in metres. The sanity check a human can read.
    pub fn bounds(&self) -> ([f32; 3], [f32; 3]) {
        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for bone in &self.bones {
            for vertex in bone.vertices.chunks_exact(6) {
                for k in 0..3 {
                    lo[k] = lo[k].min(vertex[k]);
                    hi[k] = hi[k].max(vertex[k]);
                }
            }
        }
        (lo, hi)
    }
}

/// Load `manifest.json` and `skeleton.bin` from a directory holding the pack.
pub fn load(dir: &Path) -> Result<Pack> {
    let manifest_path = dir.join("manifest.json");
    let text = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("reading {}", manifest_path.display()))?;
    let manifest: Manifest = serde_json::from_str(&text)
        .with_context(|| format!("parsing {}", manifest_path.display()))?;
    if manifest.format != "bs-humany.skeleton-mesh/1" {
        bail!(
            "{} is format '{}', which this does not know how to read.",
            manifest_path.display(),
            manifest.format
        );
    }
    if manifest.units != "m" {
        bail!("the pack is in '{}' rather than metres.", manifest.units);
    }

    let bin_path = dir.join("skeleton.bin");
    let bin = std::fs::read(&bin_path).with_context(|| format!("reading {}", bin_path.display()))?;
    let position_bytes = manifest.totals.vertices * 3 * 4;
    let index_bytes = manifest.totals.triangles * 3 * 4;
    if bin.len() != position_bytes + index_bytes {
        bail!(
            "{} is {} bytes but the manifest describes {}. The two files are not a pair.",
            bin_path.display(),
            bin.len(),
            position_bytes + index_bytes
        );
    }

    let positions = read_f32(&bin[..position_bytes]);
    let indices = read_u32(&bin[position_bytes..]);

    let mut bones = Vec::with_capacity(manifest.bones.len());
    for bone in &manifest.bones {
        let first = bone.vertex_offset * 3;
        let last = (bone.vertex_offset + bone.vertex_count) * 3;
        if last > positions.len() || bone.index_offset + bone.index_count > indices.len() {
            bail!("bone '{}' names a slice the pack does not hold.", bone.id);
        }
        let slice = &positions[first..last];
        let index = &indices[bone.index_offset..bone.index_offset + bone.index_count];
        for (at, i) in index.iter().enumerate() {
            if *i as usize >= bone.vertex_count {
                bail!(
                    "bone '{}' index {at} is {i}, past its own {} vertices -- the pack's indices \
                     are supposed to be bone-local.",
                    bone.id,
                    bone.vertex_count
                );
            }
        }
        bones.push(BoneMesh {
            id: bone.id.clone(),
            vertices: interleave_with_normals(slice, index),
            indices: index.to_vec(),
        });
    }

    Ok(Pack { manifest, bones })
}

/// Positions and area-weighted vertex normals, interleaved as the vertex buffer wants them.
fn interleave_with_normals(positions: &[f32], indices: &[u32]) -> Vec<f32> {
    let count = positions.len() / 3;
    let mut normals = vec![0f32; count * 3];
    for triangle in indices.chunks_exact(3) {
        let (a, b, c) = (
            triangle[0] as usize * 3,
            triangle[1] as usize * 3,
            triangle[2] as usize * 3,
        );
        let u = [
            positions[b] - positions[a],
            positions[b + 1] - positions[a + 1],
            positions[b + 2] - positions[a + 2],
        ];
        let v = [
            positions[c] - positions[a],
            positions[c + 1] - positions[a + 1],
            positions[c + 2] - positions[a + 2],
        ];
        // Not normalised: the cross product's length is twice the triangle's area, which is the
        // weighting that makes a big face count for more than a sliver.
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        for corner in [a, b, c] {
            for k in 0..3 {
                normals[corner + k] += n[k];
            }
        }
    }

    let mut out = Vec::with_capacity(count * 6);
    for v in 0..count {
        let p = v * 3;
        let length = (normals[p] * normals[p] + normals[p + 1] * normals[p + 1]
            + normals[p + 2] * normals[p + 2])
            .sqrt();
        // A vertex no triangle touches keeps a zero normal rather than a NaN; it is also a vertex
        // nothing draws, so what it shades like does not arise.
        let scale = if length > 0.0 { 1.0 / length } else { 0.0 };
        out.extend_from_slice(&[
            positions[p],
            positions[p + 1],
            positions[p + 2],
            normals[p] * scale,
            normals[p + 1] * scale,
            normals[p + 2] * scale,
        ]);
    }
    out
}

fn read_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn read_u32(bytes: &[u8]) -> Vec<u32> {
    bytes
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}
