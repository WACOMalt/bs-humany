//! The reading end of the pose bridge.
//!
//! The simulation writes a file on tmpfs -- `packages/pose-bridge/src/index.ts` is where the
//! layout is stated and the reasons are argued -- and this maps it and reads the newest complete
//! frame whenever the renderer asks. It never waits: if there is no frame yet, or the one it
//! reached was mid-write, it says so and the renderer draws what it last had. That is ADR-012 as
//! code.
//!
//! ## The seqlock, from this side
//!
//! Take `newest`. Read that slot's `seq`; it has to be even and non-zero, or the slot is being
//! written or never was. Copy the body. Read `seq` again; if it moved, the copy straddled a write
//! and is thrown away. A handful of retries covers a writer that is genuinely in the middle of the
//! slot; more than that and something is wrong, and the frame is simply skipped -- the next
//! display refresh will ask again.
//!
//! ## Staleness, which ADR-012 requires this to know
//!
//! "The body is not moving" and "the simulation died" look identical from a pose. What tells them
//! apart is whether `published` is still advancing, so this remembers the last value it saw and
//! when it changed, and `stale_for` is how long ago that was. No clock is shared with the writer
//! for this; the reader's own is enough.
//!
//! ## Checked against what the other side wrote
//!
//! `fixtures/pose-bridge.bin` is written by the TypeScript side with a fixed clock, and the test
//! at the bottom reads it and pins the numbers. Two implementations of one layout in two languages
//! cannot share code; they can share a file, and a gate on each side of it.

use anyhow::{Context, Result, bail};
use memmap2::Mmap;
use std::path::Path;
use std::time::{Duration, Instant};

const MAGIC: u32 = 0x5048_5342;
const VERSION: u32 = 1;
const HEADER_BYTES: usize = 64;
const SLOT_HEADER_BYTES: usize = 32;
const NO_FRAME: u32 = 0xffff_ffff;
pub const FLOATS_PER_BONE: usize = 7;

/// One complete pose, copied out of the ring.
pub struct Frame {
    pub tick: u64,
    pub sim_time: f64,
    /// `bones * 7`: position xyz, orientation xyzw, in the sidecar's bone order.
    pub pose: Vec<f32>,
}

pub struct PoseBridge {
    map: Mmap,
    pub bones: usize,
    pub slots: usize,
    slot_bytes: usize,
    slots_offset: usize,
    /// Bone ids in the order every frame follows, from the sidecar.
    pub names: Vec<String>,
    /// What to multiply the mesh pack's vertices by before posing them.
    pub dataset_scale: f64,
    /// `bones * 7`, the pose the pack's vertices are relative to.
    pub rest: Vec<f32>,
    last_published: u64,
    last_change: Instant,
    scratch: Vec<f32>,
}

impl PoseBridge {
    pub fn open(path: &Path) -> Result<Self> {
        let file = std::fs::File::open(path)
            .with_context(|| format!("opening {} -- is `pnpm publish:pose` running?", path.display()))?;
        let map = unsafe { Mmap::map(&file) }.context("mapping the pose bridge")?;
        if map.len() < HEADER_BYTES {
            bail!("{} is {} bytes, which is not even a header.", path.display(), map.len());
        }
        let u32_at = |at: usize| u32::from_le_bytes(map[at..at + 4].try_into().unwrap());
        if u32_at(0) != MAGIC {
            bail!("{} is not a pose bridge.", path.display());
        }
        if u32_at(4) != VERSION {
            bail!("{} is pose bridge version {}, and this reads {VERSION}.", path.display(), u32_at(4));
        }
        let bones = u32_at(8) as usize;
        let slots = u32_at(12) as usize;
        let slot_bytes = u32_at(20) as usize;
        let dataset_scale = f64::from_le_bytes(map[24..32].try_into().unwrap());
        let rest_bytes = bones * FLOATS_PER_BONE * 4;
        let slots_offset = HEADER_BYTES + rest_bytes.div_ceil(64) * 64;
        let expected = slots_offset + slots * slot_bytes;
        if map.len() < expected {
            bail!(
                "{} is {} bytes but its header describes {expected}.",
                path.display(),
                map.len()
            );
        }
        let rest: Vec<f32> = map[HEADER_BYTES..HEADER_BYTES + rest_bytes]
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();

        let sidecar_path = path.with_file_name(format!(
            "{}.json",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("pose")
        ));
        let sidecar: Sidecar = serde_json::from_str(
            &std::fs::read_to_string(&sidecar_path)
                .with_context(|| format!("reading {}", sidecar_path.display()))?,
        )
        .with_context(|| format!("parsing {}", sidecar_path.display()))?;
        if sidecar.bones.len() != bones {
            bail!(
                "the sidecar names {} bones and the bridge holds {bones}.",
                sidecar.bones.len()
            );
        }

        Ok(Self {
            map,
            bones,
            slots,
            slot_bytes,
            slots_offset,
            names: sidecar.bones,
            dataset_scale,
            rest,
            last_published: 0,
            last_change: Instant::now(),
            scratch: vec![0.0; bones * FLOATS_PER_BONE],
        })
    }

    /// Frames the writer has published so far.
    pub fn published(&self) -> u64 {
        unsafe { std::ptr::read_volatile(self.map.as_ptr().add(32) as *const u64) }
    }

    /// How long since a new frame last appeared. Small while the simulation runs; growing when
    /// it has stopped, whether by finishing or by dying.
    pub fn stale_for(&self) -> Duration {
        self.last_change.elapsed()
    }

    /// The newest complete frame, or `None` if there is none yet or it could not be read cleanly.
    pub fn newest(&mut self) -> Option<Frame> {
        let published = self.published();
        if published != self.last_published {
            self.last_published = published;
            self.last_change = Instant::now();
        }
        let base_ptr = self.map.as_ptr();
        let newest = unsafe { std::ptr::read_volatile(base_ptr.add(16) as *const u32) };
        if newest == NO_FRAME || newest as usize >= self.slots {
            return None;
        }
        let base = self.slots_offset + newest as usize * self.slot_bytes;
        for _ in 0..4 {
            let seq = unsafe { std::ptr::read_volatile(base_ptr.add(base) as *const u64) };
            if seq == 0 || seq % 2 == 1 {
                continue;
            }
            let tick = u64::from_le_bytes(self.map[base + 8..base + 16].try_into().unwrap());
            let sim_time = f64::from_le_bytes(self.map[base + 16..base + 24].try_into().unwrap());
            let body = &self.map[base + SLOT_HEADER_BYTES
                ..base + SLOT_HEADER_BYTES + self.bones * FLOATS_PER_BONE * 4];
            for (i, c) in body.chunks_exact(4).enumerate() {
                self.scratch[i] = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
            }
            let again = unsafe { std::ptr::read_volatile(base_ptr.add(base) as *const u64) };
            if again != seq {
                continue;
            }
            return Some(Frame {
                tick,
                sim_time,
                pose: self.scratch.clone(),
            });
        }
        None
    }
}

#[derive(serde::Deserialize)]
struct Sidecar {
    bones: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/pose-bridge.bin")
    }

    #[test]
    fn reads_what_the_typescript_side_wrote() {
        // The same bytes the TypeScript unit test looks at, read by the other implementation.
        // Every number here is one that test asserts too; if the layout drifts on either side,
        // one of the two stops agreeing with the file.
        let mut bridge = PoseBridge::open(&fixture()).expect("the fixture opens");
        assert_eq!(bridge.bones, 3);
        assert_eq!(bridge.slots, 3);
        assert_eq!(bridge.names, ["pelvis", "femur_r", "tibia_r"]);
        assert!((bridge.dataset_scale - 1.7 / 1.6963).abs() < 1e-12);
        assert!((bridge.rest[1] - 0.9).abs() < 1e-6, "rest pelvis y {}", bridge.rest[1]);
        assert!((bridge.rest[3 * 7 - 1] - 1.0).abs() < 1e-6, "tibia rest w");
        assert_eq!(bridge.published(), 5);

        // Five publishes round three slots land the newest in slot 1, holding frame 4.
        let frame = bridge.newest().expect("a complete frame");
        assert_eq!(frame.tick, 40);
        assert!((frame.sim_time - 0.04).abs() < 1e-12);
        assert!((frame.pose[1] - 0.86).abs() < 1e-6, "pelvis y {}", frame.pose[1]);
        // Seven floats a bone, interleaved: the tibia is bone 2, so its z is at 2 * 7 + 2.
        assert!((frame.pose[16] - 4.0).abs() < 1e-6, "tibia z {}", frame.pose[16]);
        assert!((frame.pose[8] - 0.8).abs() < 1e-6, "femur y {}", frame.pose[8]);
        assert_eq!(frame.pose.len(), 3 * FLOATS_PER_BONE);
    }

    #[test]
    fn staleness_is_measured_by_the_reader_alone() {
        // A fixture never advances, so it is stale from the moment it is opened -- and the point
        // is that this needs no clock in common with whoever wrote it.
        let mut bridge = PoseBridge::open(&fixture()).expect("the fixture opens");
        let _ = bridge.newest();
        std::thread::sleep(Duration::from_millis(20));
        let _ = bridge.newest();
        assert!(bridge.stale_for() >= Duration::from_millis(20));
    }
}
