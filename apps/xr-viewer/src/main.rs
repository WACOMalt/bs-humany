//! A native OpenXR viewer for the skeleton, and the first thing here that is not a web view.
//!
//! What this is for is deciding whether the native route is worth taking, before weeks are spent
//! on it. The uncertain parts of that are not the drawing -- two hundred rigid meshes is nothing
//! -- they are whether this machine's OpenXR runtime cooperates, whether the mesh pack loads
//! cleanly outside JavaScript, and what frame budget there really is. So this answers those and
//! stops.
//!
//!   bs-humany-xr-viewer check-pack [dir]   load the mesh pack, report what is in it. No XR.
//!   bs-humany-xr-viewer probe              which runtime, which headset, which views. No session.
//!   bs-humany-xr-viewer session [seconds]  begin a session and run the frame loop. No drawing.
//!
//! The first needs no hardware at all. The second needs a runtime but no headset. Only the third
//! needs a headset, which is the order in which things stop being checkable from a terminal.

mod pack;
mod xr;

use anyhow::{Context, Result};
use std::path::PathBuf;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("check-pack") => check_pack(args.get(1).map(PathBuf::from)),
        Some("probe") => xr::probe(),
        Some("session") => {
            let seconds = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(5.0);
            xr::run_session(seconds)
        }
        other => {
            if let Some(word) = other {
                eprintln!("bs-humany-xr-viewer: no idea what '{word}' means.\n");
            }
            eprintln!("usage: bs-humany-xr-viewer <check-pack [dir] | probe | session [seconds]>");
            std::process::exit(2);
        }
    }
}

/// Load the pack and say what came out, in the terms somebody can check against the web build.
fn check_pack(dir: Option<PathBuf>) -> Result<()> {
    let dir = dir.unwrap_or_else(default_pack_dir);
    let pack = pack::load(&dir).with_context(|| format!("loading the mesh pack from {}", dir.display()))?;

    println!("pack: {}", dir.display());
    println!("  dataset   {}", pack.manifest.dataset.name);
    println!("  licence   {}", pack.manifest.dataset.license);
    for line in &pack.manifest.dataset.attribution {
        println!("            {line}");
    }
    println!("  stature   {:.4} m", pack.manifest.subject_stature);
    println!(
        "  bones     {}  vertices {}  triangles {}",
        pack.bones.len(),
        pack.vertex_count(),
        pack.triangle_count()
    );
    let (lo, hi) = pack.bounds();
    println!(
        "  bounds    x {:.3}..{:.3}   y {:.3}..{:.3}   z {:.3}..{:.3}",
        lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]
    );
    let bytes: usize = pack.bones.iter().map(|b| b.vertices.len() * 4 + b.indices.len() * 4).sum();
    println!("  in memory {:.1} MB interleaved with normals", bytes as f64 / 1048576.0);

    // The check that the normals are worth having rather than merely present: on a closed surface
    // they should be unit length and should not all point the same way.
    let mut worst = 0f32;
    let mut mean = [0f64; 3];
    let mut count = 0usize;
    for bone in &pack.bones {
        for v in bone.vertices.chunks_exact(6) {
            let n = [v[3], v[4], v[5]];
            let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if length > 0.0 {
                worst = worst.max((length - 1.0).abs());
                for k in 0..3 {
                    mean[k] += n[k] as f64;
                }
                count += 1;
            }
        }
    }
    let scale = if count > 0 { 1.0 / count as f64 } else { 0.0 };
    println!(
        "  normals   {count} non-zero, worst length error {worst:.2e}, mean ({:.3}, {:.3}, {:.3})",
        mean[0] * scale,
        mean[1] * scale,
        mean[2] * scale
    );
    println!("            (a mean near zero is a closed surface facing every way, as it should)");
    Ok(())
}

/// Where the pack lives in this repository, relative to the crate.
fn default_pack_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/assets-anatomical/data")
}
