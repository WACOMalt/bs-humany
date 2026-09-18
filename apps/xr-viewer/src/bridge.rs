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
use memmap2::{Mmap, MmapMut};
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

// ---------------------------------------------------------------------------------------------
// The muscles: rings, in a ring of their own, beside the poses.
// ---------------------------------------------------------------------------------------------

const MUSCLE_MAGIC: u32 = 0x4353_554d;
const MUSCLE_VERSION: u32 = 1;
const MUSCLE_SLOT_HEADER_BYTES: usize = 16;
pub const FLOATS_PER_RING: usize = 8;

pub struct MuscleFrame {
    pub tick: u64,
    /// `units * rings * 8`: centre xyz, orientation xyzw, radius, ring `r` of unit `u` at
    /// `u * rings + r`.
    pub rings: Vec<f32>,
}

/// The reading end of the muscle bridge, `<pose path>-muscles`: the same seqlocked ring as the
/// poses, holding belly rings rather than bones. Its layout is stated beside the pose bridge's in
/// `packages/pose-bridge/src/index.ts`.
pub struct MuscleBridge {
    map: Mmap,
    pub units: usize,
    pub rings: usize,
    pub segments: usize,
    pub slots: usize,
    slot_bytes: usize,
    scratch: Vec<f32>,
}

impl MuscleBridge {
    pub fn open(path: &Path) -> Result<Self> {
        let file = std::fs::File::open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        let map = unsafe { Mmap::map(&file) }.context("mapping the muscle bridge")?;
        if map.len() < HEADER_BYTES {
            bail!("{} is {} bytes, which is not even a header.", path.display(), map.len());
        }
        let u32_at = |at: usize| u32::from_le_bytes(map[at..at + 4].try_into().unwrap());
        if u32_at(0) != MUSCLE_MAGIC {
            bail!("{} is not a muscle bridge.", path.display());
        }
        if u32_at(4) != MUSCLE_VERSION {
            bail!("{} is muscle bridge version {}, and this reads {MUSCLE_VERSION}.", path.display(), u32_at(4));
        }
        let (units, rings, segments, slots, slot_bytes) = (
            u32_at(8) as usize,
            u32_at(12) as usize,
            u32_at(16) as usize,
            u32_at(20) as usize,
            u32_at(28) as usize,
        );
        let expected = HEADER_BYTES + slots * slot_bytes;
        if map.len() < expected || slot_bytes < MUSCLE_SLOT_HEADER_BYTES + units * rings * FLOATS_PER_RING * 4 {
            bail!("{} is {} bytes but its header describes {expected}.", path.display(), map.len());
        }
        Ok(Self {
            map,
            units,
            rings,
            segments,
            slots,
            slot_bytes,
            scratch: vec![0.0; units * rings * FLOATS_PER_RING],
        })
    }

    pub fn published(&self) -> u64 {
        unsafe { std::ptr::read_volatile(self.map.as_ptr().add(32) as *const u64) }
    }

    /// The newest complete frame, or `None` if there is none yet or it could not be read cleanly.
    pub fn newest(&mut self) -> Option<MuscleFrame> {
        let base_ptr = self.map.as_ptr();
        let newest = unsafe { std::ptr::read_volatile(base_ptr.add(24) as *const u32) };
        if newest == NO_FRAME || newest as usize >= self.slots {
            return None;
        }
        let base = HEADER_BYTES + newest as usize * self.slot_bytes;
        let floats = self.scratch.len();
        for _ in 0..4 {
            let seq = unsafe { std::ptr::read_volatile(base_ptr.add(base) as *const u64) };
            if seq == 0 || seq % 2 == 1 {
                continue;
            }
            let tick = u64::from_le_bytes(self.map[base + 8..base + 16].try_into().unwrap());
            let body = &self.map[base + MUSCLE_SLOT_HEADER_BYTES..base + MUSCLE_SLOT_HEADER_BYTES + floats * 4];
            for (i, c) in body.chunks_exact(4).enumerate() {
                self.scratch[i] = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
            }
            let again = unsafe { std::ptr::read_volatile(base_ptr.add(base) as *const u64) };
            if again != seq {
                continue;
            }
            return Some(MuscleFrame {
                tick,
                rings: self.scratch.clone(),
            });
        }
        None
    }
}

// ---------------------------------------------------------------------------------------------
// The other direction: what the hands are doing, for the simulation to act on.
// ---------------------------------------------------------------------------------------------

const GRAB_MAGIC: u32 = 0x4241_5247;
const GRAB_VERSION: u32 = 1;
pub const HANDS: usize = 2;
const GRAB_SLOT_BYTES: usize = 64;
const GRAB_BYTES: usize = HEADER_BYTES + HANDS * GRAB_SLOT_BYTES;

/// One hand's state, as the simulation wants it: in the simulation's own frame, not the room's.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GrabIntent {
    pub active: bool,
    /// Index into the pose bridge's bone order, or -1 for none.
    pub bone: i32,
    /// Where the grab began.
    pub point: [f32; 3],
    /// Where the hand is now.
    pub target: [f32; 3],
    pub strength: f32,
}

/// The writing end of the grab channel, the mirror of `PoseBridge`: two slots, one a hand,
/// rewritten every frame under the same seqlock. The layout is stated with the reader, in
/// `packages/pose-bridge/src/index.ts`.
pub struct GrabIntentWriter {
    map: MmapMut,
    seq: [u64; HANDS],
    written: u64,
}

impl GrabIntentWriter {
    pub fn create(path: &Path) -> Result<Self> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .with_context(|| format!("creating {}", path.display()))?;
        file.set_len(GRAB_BYTES as u64)?;
        let mut map = unsafe { MmapMut::map_mut(&file) }.context("mapping the grab channel")?;
        map[0..4].copy_from_slice(&GRAB_MAGIC.to_le_bytes());
        map[4..8].copy_from_slice(&GRAB_VERSION.to_le_bytes());
        map[8..12].copy_from_slice(&(HANDS as u32).to_le_bytes());
        map[12..16].copy_from_slice(&(GRAB_SLOT_BYTES as u32).to_le_bytes());
        Ok(Self {
            map,
            seq: [0; HANDS],
            written: 0,
        })
    }

    /// Overwrite one hand's slot. Odd, body, even: a reader that sees the same even sequence on
    /// both sides of its copy has a whole intent; any other reading is discarded on its side.
    pub fn publish(&mut self, hand: usize, intent: &GrabIntent) {
        let base = HEADER_BYTES + hand * GRAB_SLOT_BYTES;
        let ptr = self.map.as_mut_ptr();
        self.seq[hand] += 1;
        unsafe { std::ptr::write_volatile(ptr.add(base) as *mut u64, self.seq[hand]) };
        let body = &mut self.map[base + 8..base + 44];
        body[0..4].copy_from_slice(&(intent.active as u32).to_le_bytes());
        body[4..8].copy_from_slice(&intent.bone.to_le_bytes());
        for (i, v) in intent.point.iter().chain(intent.target.iter()).enumerate() {
            body[8 + i * 4..12 + i * 4].copy_from_slice(&v.to_le_bytes());
        }
        body[32..36].copy_from_slice(&intent.strength.to_le_bytes());
        self.seq[hand] += 1;
        unsafe { std::ptr::write_volatile(ptr.add(base) as *mut u64, self.seq[hand]) };
        self.written += 1;
        unsafe { std::ptr::write_volatile(ptr.add(16) as *mut u64, self.written) };
    }
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
    fn reads_the_muscle_rings_the_typescript_side_wrote() {
        // Two bellies of three rings, four segments, five frames round three slots; the numbers
        // the TypeScript test asserts about the same generator output.
        let path = fixture().with_file_name("pose-bridge.bin-muscles");
        let mut bridge = MuscleBridge::open(&path).expect("the muscle fixture opens");
        assert_eq!((bridge.units, bridge.rings, bridge.segments, bridge.slots), (2, 3, 4, 3));
        assert_eq!(bridge.published(), 5);
        let frame = bridge.newest().expect("a complete frame");
        assert_eq!(frame.tick, 40);
        assert_eq!(frame.rings.len(), 2 * 3 * FLOATS_PER_RING);
        // Ring 5 is unit 1, ring 2: centre y = 1 + 2/2 + 0.04, identity orientation, radius 0.054.
        let ring = &frame.rings[5 * 8..6 * 8];
        assert!((ring[1] - 2.04).abs() < 1e-5, "y {}", ring[1]);
        assert!((ring[6] - 1.0).abs() < 1e-6, "w {}", ring[6]);
        assert!((ring[7] - 0.054).abs() < 1e-5, "radius {}", ring[7]);
    }

    #[test]
    fn writes_a_grab_intent_where_the_typescript_reader_looks() {
        // The same offsets the TypeScript test builds by hand; the two tests pin one layout.
        let dir = std::env::temp_dir().join(format!("bs-humany-grab-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let mut writer = GrabIntentWriter::create(&dir).expect("the channel is created");
        writer.publish(
            0,
            &GrabIntent {
                active: true,
                bone: 17,
                point: [0.1, 1.2, -0.3],
                target: [0.15, 1.25, -0.35],
                strength: 1.0,
            },
        );
        writer.publish(1, &GrabIntent::default());
        writer.publish(1, &GrabIntent::default());
        let bytes = std::fs::read(&dir).expect("readable");
        let _ = std::fs::remove_file(&dir);
        assert_eq!(bytes.len(), GRAB_BYTES);
        let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let u64_at = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        let f32_at = |at: usize| f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        assert_eq!(u32_at(0), 0x4241_5247);
        assert_eq!(u32_at(4), 1);
        assert_eq!(u32_at(8), 2);
        assert_eq!(u32_at(12), 64);
        assert_eq!(u64_at(16), 3, "three slot writes");
        // Left hand, slot 0 at 64: even after one write, active, bone 17, the points, strength.
        assert_eq!(u64_at(64), 2);
        assert_eq!(u32_at(72), 1);
        assert_eq!(u32_at(76) as i32, 17);
        assert_eq!(f32_at(80), 0.1);
        assert_eq!(f32_at(84), 1.2);
        assert_eq!(f32_at(88), -0.3);
        assert_eq!(f32_at(92), 0.15);
        assert_eq!(f32_at(96), 1.25);
        assert_eq!(f32_at(100), -0.35);
        assert_eq!(f32_at(104), 1.0);
        // Right hand, slot 1 at 128: written twice, so its sequence is four, and it holds nothing.
        assert_eq!(u64_at(128), 4);
        assert_eq!(u32_at(136), 0);
        assert_eq!(u32_at(140) as i32, 0);
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

// ---------------------------------------------------------------------------------------------
// The panel's two files: status from the publisher, commands to it.
// ---------------------------------------------------------------------------------------------

#[derive(serde::Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Named {
    pub id: String,
    pub title: String,
}

/// What the publisher says about itself, four times a second, in `<pose path>-status.json`.
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Bumped every time the publisher rebuilds its bridge files; a reader that sees it change
    /// reopens them.
    pub generation: u64,
    pub scenario: Named,
    pub scenarios: Vec<Named>,
    pub profile: String,
    pub sim_seconds: f64,
    pub speed: f64,
    pub paused: bool,
    pub muscles: bool,
    pub holding: Vec<String>,
    pub grab_strength: f64,
}

/// The status as it stands, or `None` if there is none or it could not be parsed -- a file
/// renamed into place is whole or absent, so a parse failure means an older publisher.
pub fn read_status(path: &Path) -> Option<Status> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Commands to the publisher: one JSON object a line, appended to `<pose path>-commands.jsonl`.
/// The file is truncated when this opens, so the publisher starts reading it from the top.
pub struct CommandWriter {
    file: std::fs::File,
}

impl CommandWriter {
    pub fn create(path: &Path) -> Result<Self> {
        let file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .with_context(|| format!("creating {}", path.display()))?;
        file.set_len(0)?;
        Ok(Self { file })
    }

    pub fn send(&mut self, line: &str) -> Result<()> {
        use std::io::Write;
        // One write for the line and its newline, so the publisher never reads half a command.
        self.file.write_all(format!("{line}\n").as_bytes())?;
        Ok(())
    }
}
