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
//!
//! ## Following a file that is replaced
//!
//! A map is of an inode, not of a name. A publisher that restarts, or rebuilds its bridges, puts
//! new files at the same names, and a reader still holding the old map would go on showing the
//! last frame of a run that has ended. So each reader records which file it mapped, as the
//! device and inode numbers, and `feeds_changed` says when the names now lead somewhere else.
//! The generation in the status says the same thing when the publisher bumps it, but a publisher
//! that restarts from generation 1, as `pnpm publish:pose` does, cannot be told from itself that
//! way; the inode can.

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
    /// Which file this mapped: taken from the open file rather than the name, so a file swapped
    /// in between the open and the look is seen as the change it is.
    pub id: Option<FileId>,
}

impl PoseBridge {
    pub fn open(path: &Path) -> Result<Self> {
        let file = std::fs::File::open(path)
            .with_context(|| format!("opening {} -- is `pnpm publish:pose` running?", path.display()))?;
        let map = unsafe { Mmap::map(&file) }.context("mapping the pose bridge")?;
        let id = open_file_id(&file);
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
            id,
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
    /// Which file this mapped, as `PoseBridge::id`.
    pub id: Option<FileId>,
}

impl MuscleBridge {
    pub fn open(path: &Path) -> Result<Self> {
        let file = std::fs::File::open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        let map = unsafe { Mmap::map(&file) }.context("mapping the muscle bridge")?;
        let id = open_file_id(&file);
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
            id,
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
// Which files are mapped, and whether the names still lead to them.
// ---------------------------------------------------------------------------------------------

/// A file's identity, device and inode, which a replacement at the same name does not keep.
pub type FileId = (u64, u64);

#[cfg(unix)]
fn open_file_id(file: &std::fs::File) -> Option<FileId> {
    use std::os::unix::fs::MetadataExt;
    file.metadata().ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn open_file_id(_file: &std::fs::File) -> Option<FileId> {
    None
}

/// The identity of whatever is at `path` now, or `None` if nothing is there -- or if this
/// platform has no inodes to ask about, in which case no replacement is ever seen and the
/// generation in the status is the only signal left.
#[cfg(unix)]
pub fn file_id(path: &Path) -> Option<FileId> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(not(unix))]
pub fn file_id(_path: &Path) -> Option<FileId> {
    None
}

/// The muscle ring's name beside a pose bridge's.
pub fn muscle_path(pose: &Path) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}-muscles", pose.display()))
}

/// What one set of feeds mapped: the pose ring, and the muscle ring or the fact there was none.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MappedId {
    pub pose: Option<FileId>,
    /// The muscle file that was at its name when the feeds opened, whether or not it could be
    /// mapped: one that exists and cannot be read must not look replaced at every poll.
    pub muscles: Option<FileId>,
}

/// Whether the files at `path` are no longer the ones `mapped` describes, so the feeds should be
/// opened again.
///
/// A pose file that is missing is not a change: a publisher between removing its files and
/// writing new ones, or one that has stopped and cleaned up, leaves the last frame standing
/// rather than a blank room, and the new file, when it comes, is a change. The muscle file is
/// different, because a publisher turns muscles off by removing it; one that comes or goes
/// while the pose file stays is a change too.
pub fn feeds_changed(path: &Path, mapped: &MappedId) -> bool {
    let Some(pose) = file_id(path) else { return false };
    if mapped.pose.is_some_and(|was| was != pose) {
        return true;
    }
    file_id(&muscle_path(path)) != mapped.muscles
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
    /// The hand's orientation now, xyzw, in the simulation's frame.
    pub rotation: [f32; 4],
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
        let body = &mut self.map[base + 8..base + 60];
        body[0..4].copy_from_slice(&(intent.active as u32).to_le_bytes());
        body[4..8].copy_from_slice(&intent.bone.to_le_bytes());
        for (i, v) in intent.point.iter().chain(intent.target.iter()).enumerate() {
            body[8 + i * 4..12 + i * 4].copy_from_slice(&v.to_le_bytes());
        }
        body[32..36].copy_from_slice(&intent.strength.to_le_bytes());
        for (i, v) in intent.rotation.iter().enumerate() {
            body[36 + i * 4..40 + i * 4].copy_from_slice(&v.to_le_bytes());
        }
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
                rotation: [0.0, 0.7071, 0.0, 0.7071],
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
        assert_eq!(f32_at(112), 0.7071, "rotation y at 44");
        assert_eq!(f32_at(120), 0.7071, "rotation w at 56");
        // Right hand, slot 1 at 128: written twice, so its sequence is four, and it holds nothing.
        assert_eq!(u64_at(128), 4);
        assert_eq!(u32_at(136), 0);
        assert_eq!(u32_at(140) as i32, 0);
    }

    #[test]
    fn an_open_hand_written_over_a_squeeze_reads_as_open() {
        // What the viewer writes when it stops drawing: the default intent in both slots, over
        // whatever the hands were doing. Both slots must then read inactive, completely written,
        // and the count must have moved, which is how a reader knows it was said.
        let path = std::env::temp_dir().join(format!("bs-humany-grab-open-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut writer = GrabIntentWriter::create(&path).expect("the channel is created");
        let squeeze = GrabIntent {
            active: true,
            bone: 17,
            point: [0.1, 1.2, -0.3],
            target: [0.15, 1.25, -0.35],
            strength: 1.0,
            rotation: [0.0, 0.0, 0.0, 1.0],
        };
        writer.publish(0, &squeeze);
        writer.publish(1, &squeeze);
        writer.publish(0, &GrabIntent::default());
        writer.publish(1, &GrabIntent::default());
        let bytes = std::fs::read(&path).expect("readable");
        let _ = std::fs::remove_file(&path);
        let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let u64_at = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        assert_eq!(u64_at(16), 4, "four slot writes");
        for base in [64, 128] {
            assert_eq!(u64_at(base) % 2, 0, "slot at {base} completely written");
            assert_eq!(u32_at(base + 8), 0, "slot at {base} active is 0");
        }
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

    #[test]
    fn the_status_every_publisher_writes_parses_with_everything_the_panels_show_and_without() {
        // Written by `pnpm generate:pose-bridge-fixture` from the typed sample every publisher's
        // status is held to, with every field filled and none of them at the default this side
        // falls back on. So each assertion below is a field this side reads and the contract
        // still sends under the same name: rename one on either side and its value comes back
        // as a default, or the file stops parsing, and this fails.
        let status = parse_status(include_str!("../fixtures/status.json")).expect("parses");
        assert_eq!(status.generation, 1_790_000_000_003);
        assert_eq!(status.scenario.id, "drop-standing-collapse");
        assert_eq!(status.scenario.title, "Drop and collapse");
        assert_eq!(status.scenarios.len(), 2);
        assert_eq!(status.scenarios[0].title, "Standing quietly");
        assert!(status.scenarios[1].description.starts_with("The rest pose dropped"));
        assert_eq!(status.profiles, ["l1_standard", "l3_anatomical"]);
        assert_eq!(status.profile, "l3_anatomical");
        assert_eq!((status.sim_seconds, status.speed), (1.5, 0.24));
        assert!(status.paused && status.muscles);
        assert_eq!(status.holding, ["radius_r"]);
        assert_eq!(status.grab_strength, 1.5);

        let st = &status.settings;
        assert!(st.muscles && st.passive && st.redistribute && st.gravity && st.floor);
        assert_eq!((st.sex, st.stature, st.mass), (0.25, 1.62, 58.0));
        assert_eq!((st.crural, st.brachial, st.leg_length), (1.02, 0.77, 1.03));
        assert_eq!((st.percentile, st.drop_height), (0.4, Some(0.35)));
        assert_eq!((st.fps, st.steps_per_second), (90.0, 1000.0));

        assert_eq!(status.drive_groups.len(), 2);
        assert_eq!(status.drive_groups[0].title, "Elbow flexors");
        assert_eq!(status.drive_groups[0].level, 20.0);
        assert_eq!(status.drive_groups[1].section, "Leg");

        let d = &status.diagnostics;
        assert_eq!((d.kinetic, d.potential, d.drift_mm), (12.5, 580.25, 0.75));
        assert_eq!((d.limits_worst, d.violations), (0.625, 2.0));
        assert_eq!((d.contacts, d.cost_ms), (14.0, 0.875));

        assert_eq!(status.ground_height, -0.05);
        assert_eq!(
            status.static_boxes,
            [StaticBox {
                half_extents: [0.5, 0.25, 0.3],
                position: [0.0, 0.25, -0.4],
                rotation: [0.0, 0.0, 0.0, 1.0],
            }]
        );
        assert_eq!(status.mode, "running");
        assert_eq!(status.overlays.get("tissue"), Some(&false));
        assert_eq!(status.overlays.get("muscles"), Some(&true));
        let p = &status.scenario_parameters[0];
        assert_eq!((p.id.as_str(), p.title.as_str(), p.unit.as_str()), ("clearance", "Drop height", "m"));
        assert_eq!((p.value, p.min, p.max, p.step), (0.3, 0.0, 1.5, 0.05));
        assert_eq!(status.muscle_readout.get("loaded").map(String::as_str), Some("12 of 234"));
        assert_eq!(status.tension, [0.125, 0.5]);
        let disc = &status.tissue.discs[0];
        assert_eq!((disc.bone.as_str(), disc.kind.as_str()), ("sacrum", "disc"));
        assert_eq!(disc.position, [0.017, 0.013, -0.051]);
        assert_eq!(disc.rotation, [-0.018, 0.6, -0.018, 0.8]);
        let bar = &status.tissue.bars[0];
        assert_eq!((bar.bone_a.as_str(), bar.bone_b.as_str()), ("sternum", "rib_2_r"));
        assert_eq!((bar.local_a, bar.local_b), ([0.02, 0.07, 0.04], [-0.01, -0.05, -0.07]));

        let b = &status.brain;
        assert!(b.active && b.following);
        assert_eq!(b.authority, 0.3);
        assert_eq!(b.selected, "stand-7");
        assert_eq!(b.checkpoints[0], Checkpoint { id: "stand-7".into(), name: "stand, generation 7".into() });
        assert_eq!(b.fit, "In the loop");
        assert!(b.training.starts_with("generation 7"));
        assert_eq!((b.reflex.stretch, b.reflex.velocity, b.reflex.set_point), (2.5, 0.125, 0.875));
        assert_eq!((b.reflex.inhibition, b.reflex.delay_seconds), (0.5, 0.03));
        assert_eq!(b.memory, 8);
        assert!(!b.can_start && b.can_stop && b.can_hand_over && !b.can_release);
        assert!(b.policy_note.starts_with("No dashboard server"));
        assert!(b.spine_note.contains("no reflexes"));
        let t = status.training.as_ref().expect("the training run");
        assert_eq!((t.task.as_str(), t.episode, t.generation, t.fitness), ("stand", 4, 7, 0.812));
        assert_eq!((status.recorded_seconds, status.playing, status.live), (Some(2.75), Some(true), Some(false)));

        // An older publisher that says none of that is still a status: every new key defaults.
        let before = r#"{"generation":1,"scenario":{"id":"a","title":"A"},"scenarios":[],
            "profile":"l1_standard","simSeconds":0,"speed":1,"paused":true,"muscles":false,
            "holding":[],"grabStrength":1}"#;
        let status: Status = serde_json::from_str(before).expect("parses");
        assert!(status.overlays.is_empty() && status.tissue.discs.is_empty());
        assert!(status.training.is_none() && !status.brain.active);
        assert_eq!(status.settings.drop_height, None);
        assert_eq!((status.recorded_seconds, status.playing, status.live), (None, None, None));
        let b = &status.brain;
        assert!(!b.can_start && !b.can_stop && !b.can_hand_over && !b.can_release);
        assert!(b.policy_note.is_empty() && b.spine_note.is_empty());
    }

    #[test]
    fn a_brain_from_before_the_button_flags_leaves_every_button_off() {
        // A desktop from before the flags sends its brain without them. The rest still reads, and
        // the headset offers no button it cannot stand behind rather than guessing at rules it no
        // longer keeps.
        let before = r#"{"serverUp":false,"active":true,"authority":0.3,"selected":"stand",
            "checkpoints":[{"id":"stand","name":"stand"}],"fit":"In the loop","training":"",
            "trainingRunning":false,"trainingStoppable":false,"following":false}"#;
        let brain: Brain = serde_json::from_str(before).expect("parses");
        assert!(brain.active && brain.selected == "stand");
        assert!(!brain.can_start && !brain.can_stop && !brain.can_hand_over && !brain.can_release);
        assert!(brain.policy_note.is_empty() && brain.spine_note.is_empty());
    }

    #[test]
    fn a_status_that_does_not_parse_says_why_and_a_missing_one_says_so() {
        // The panel shows serde's words, so they had better name the field.
        let Err(StatusError::Unreadable(why)) = parse_status(r#"{"generation":null}"#) else {
            panic!("a null generation parsed");
        };
        assert!(why.contains("null"), "{why}");
        let Err(StatusError::Unreadable(why)) = parse_status(r#"{"generation":1}"#) else {
            panic!("a status with no scenario parsed");
        };
        assert!(why.contains("scenario"), "{why}");
        let nowhere = scratch("no-status").join("status.json");
        assert_eq!(read_status(&nowhere).err(), Some(StatusError::Missing));
    }

    /// A directory of this test's own, emptied first, so parallel tests and earlier runs do not
    /// meet in it.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bs-humany-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    #[cfg(unix)]
    #[test]
    fn a_pose_file_renamed_over_the_mapped_one_is_seen_while_the_old_map_still_reads() {
        // What a publisher that restarts does: a new file at the same name. The viewer's map is
        // of the old inode, which lives on until it lets go, so it has to ask the name.
        let dir = scratch("feeds-changed");
        let path = dir.join("pose");
        std::fs::copy(fixture(), &path).expect("the fixture copies");
        std::fs::copy(fixture().with_file_name("pose-bridge.bin.json"), dir.join("pose.json"))
            .expect("the sidecar copies");
        let mut old = PoseBridge::open(&path).expect("the copy opens");
        let mapped = MappedId {
            pose: old.id,
            muscles: file_id(&muscle_path(&path)),
        };
        assert!(old.id.is_some() && mapped.muscles.is_none());
        assert!(!feeds_changed(&path, &mapped), "nothing has moved yet");

        // The new run's file: the same bytes except that no frame is published yet.
        let mut bytes = std::fs::read(fixture()).expect("readable");
        bytes[16..20].copy_from_slice(&NO_FRAME.to_le_bytes());
        let incoming = dir.join("pose.tmp");
        std::fs::write(&incoming, &bytes).expect("written");
        std::fs::rename(&incoming, &path).expect("renamed into place");

        assert!(feeds_changed(&path, &mapped), "the name leads to another file now");
        let frame = old.newest().expect("the old map still holds the old run");
        assert_eq!(frame.tick, 40);
        let mut new = PoseBridge::open(&path).expect("the new file opens");
        assert!(new.newest().is_none(), "the new file has published nothing");
        assert_ne!(new.id, old.id);

        // Once reopened, a muscle ring arriving beside the same pose file is a change too, and a
        // pose file that is simply gone is not: the last frame stands until a new one comes.
        let reopened = MappedId {
            pose: new.id,
            muscles: file_id(&muscle_path(&path)),
        };
        assert!(!feeds_changed(&path, &reopened));
        std::fs::copy(fixture().with_file_name("pose-bridge.bin-muscles"), muscle_path(&path))
            .expect("the muscle fixture copies");
        assert!(feeds_changed(&path, &reopened), "muscles appeared");
        std::fs::remove_file(&path).expect("removed");
        assert!(!feeds_changed(&path, &reopened), "a missing pose file keeps what is mapped");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_command_after_the_file_is_replaced_reaches_the_new_file() {
        let dir = scratch("commands");
        let path = dir.join("pose-commands.jsonl");
        std::fs::write(&path, "left over from before\n").expect("written");
        let mut writer = CommandWriter::create(&path).expect("created");
        writer.send(r#"{"kind":"pause"}"#).expect("sent");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"kind\":\"pause\"}\n");

        // A publisher restarts: it removes the file, and something is there again before the
        // next press. The press lands in the new file, after what it already holds.
        std::fs::remove_file(&path).expect("removed");
        std::fs::write(&path, "{\"kind\":\"reset\"}\n").expect("recreated");
        writer.send(r#"{"kind":"resume"}"#).expect("sent");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"kind\":\"reset\"}\n{\"kind\":\"resume\"}\n"
        );

        // Removed and not recreated: the press makes the file, so a publisher that comes later
        // finds it.
        std::fs::remove_file(&path).expect("removed");
        writer.send(r#"{"kind":"pause"}"#).expect("sent");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"kind\":\"pause\"}\n");

        // Reopened with the feeds: nothing already there is lost.
        writer.reopen().expect("reopened");
        writer.send(r#"{"kind":"reset"}"#).expect("sent");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"kind\":\"pause\"}\n{\"kind\":\"reset\"}\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
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

/// A scenario the picker offers.
#[derive(serde::Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ScenarioEntry {
    pub id: String,
    pub title: String,
    /// What the scenario is and what to watch for, as the desktop's note under its picker says.
    /// A publisher from before descriptions sends none, and the panel then shows none.
    #[serde(default)]
    pub description: String,
}

/// What the publisher says about itself, four times a second, in `<pose path>-status.json`.
///
/// The shape is `PanelStatus` in `packages/pose-bridge/src/panel.ts`, which every publisher is
/// typed against. `fixtures/status.json` is a sample of it with every field filled, written by
/// `pnpm generate:pose-bridge-fixture`, and the test below parses it: a field either side renames
/// fails there rather than reading as its default in the headset.
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Unique per publisher run (a publisher starts it at its start time in ms) and bumped on
    /// every rebuild of its bridge files; a reader that sees it change reopens them. A publisher
    /// that still starts from 1 is caught by the files' inodes instead -- see `feeds_changed`.
    pub generation: u64,
    pub scenario: Named,
    pub scenarios: Vec<ScenarioEntry>,
    pub profile: String,
    pub sim_seconds: f64,
    pub speed: f64,
    pub paused: bool,
    pub muscles: bool,
    pub holding: Vec<String>,
    pub grab_strength: f64,
    #[serde(default)]
    pub profiles: Vec<String>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub drive_groups: Vec<DriveGroup>,
    #[serde(default)]
    pub diagnostics: Diagnostics,
    #[serde(default)]
    pub ground_height: f64,
    #[serde(default)]
    pub static_boxes: Vec<StaticBox>,
    /// At rest, running, paused, or following the bridge: the studio's top-bar mode.
    #[serde(default)]
    pub mode: String,
    /// The overlays as the studio's viewport shows them, by name.
    #[serde(default)]
    pub overlays: std::collections::HashMap<String, bool>,
    #[serde(default)]
    pub scenario_parameters: Vec<ScenarioParameter>,
    #[serde(default)]
    pub muscle_readout: std::collections::HashMap<String, String>,
    /// Tendon force as a fraction of each unit's maximum, in the muscle bridge's unit order.
    #[serde(default)]
    pub tension: Vec<f32>,
    #[serde(default)]
    pub tissue: Tissue,
    #[serde(default)]
    pub brain: Brain,
    /// What the training showcase says of the run it is playing, when that is the publisher.
    #[serde(default)]
    pub training: Option<Training>,
    /// How far the studio's recording reaches, in the seconds `sim_seconds` counts, which is the
    /// playhead's time. The headless publisher and the showcase have no recording and send none.
    #[serde(default)]
    pub recorded_seconds: Option<f64>,
    /// Whether the studio is playing its recording back; `None` from a publisher with no replay.
    #[serde(default)]
    pub playing: Option<bool>,
    /// Whether the studio's playhead is on the live edge rather than scrubbed back.
    #[serde(default)]
    pub live: Option<bool>,
}

#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioParameter {
    pub id: String,
    pub title: String,
    pub value: f64,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    #[serde(default)]
    pub unit: String,
}

/// A disc or a bead at a held joint, in its parent bone's frame; a bar of cartilage between two
/// points in two bones' frames. The headset draws them from the poses it already has.
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tissue {
    #[serde(default)]
    pub discs: Vec<TissueDisc>,
    #[serde(default)]
    pub bars: Vec<TissueBar>,
}

#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TissueDisc {
    pub bone: String,
    pub kind: String,
    pub position: [f32; 3],
    #[serde(default = "identity")]
    pub rotation: [f32; 4],
}

#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TissueBar {
    pub bone_a: String,
    pub local_a: [f32; 3],
    pub bone_b: String,
    pub local_b: [f32; 3],
}

#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Brain {
    // The desktop also sends serverUp, trainingRunning and trainingStoppable. They are not read
    // here: they were the inputs to a copy of the desktop's button rules that this panel used to
    // keep, and the flags below are the desktop's own answer to the same question.
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub authority: f64,
    #[serde(default)]
    pub selected: String,
    #[serde(default)]
    pub checkpoints: Vec<Checkpoint>,
    #[serde(default)]
    pub fit: String,
    #[serde(default)]
    pub training: String,
    #[serde(default)]
    pub following: bool,
    /// The cord's gains, as the desktop's Spine panel has them.
    #[serde(default)]
    pub reflex: Reflex,
    /// Context units the policy carries between control steps; 0 is a memoryless policy.
    #[serde(default)]
    pub memory: u32,
    /// What the desktop's own Brain tab buttons would do if pressed now. The headset draws these
    /// rather than working them out again: the copy of the rules it used to keep here drifted
    /// from the desktop's, and refused Hand over whenever no dashboard was running although the
    /// desktop had long since stopped needing one. A publisher that does not send them parses to
    /// every button disabled, which is the safe way to be wrong.
    #[serde(default)]
    pub can_start: bool,
    #[serde(default)]
    pub can_stop: bool,
    #[serde(default)]
    pub can_hand_over: bool,
    #[serde(default)]
    pub can_release: bool,
    /// The line under the desktop's checkpoint list, said the same way here.
    #[serde(default)]
    pub policy_note: String,
    /// What the desktop's Spine panel says of the cord as it is set, so a change to the cord's
    /// defaults, or to what has been measured of it, is made in one place.
    #[serde(default)]
    pub spine_note: String,
}

/// The spinal reflex gains: what the cord does under the brain.
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Reflex {
    #[serde(default)]
    pub stretch: f64,
    #[serde(default)]
    pub velocity: f64,
    #[serde(default)]
    pub set_point: f64,
    #[serde(default)]
    pub inhibition: f64,
    #[serde(default)]
    pub delay_seconds: f64,
}

/// A checkpoint the dashboard lists, as the studio's brain panel names it.
#[derive(serde::Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Checkpoint {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Training {
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub episode: u64,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub fitness: f64,
}

/// A box in the scenery, in the simulation's frame.
#[derive(serde::Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StaticBox {
    pub half_extents: [f32; 3],
    pub position: [f32; 3],
    #[serde(default = "identity")]
    pub rotation: [f32; 4],
}

fn identity() -> [f32; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

/// Everything the panel can set, as the publisher currently has it.
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub muscles: bool,
    #[serde(default)]
    pub sex: f64,
    #[serde(default)]
    pub stature: f64,
    #[serde(default)]
    pub mass: f64,
    #[serde(default)]
    pub crural: f64,
    #[serde(default)]
    pub brachial: f64,
    #[serde(default)]
    pub leg_length: f64,
    /// The studio's free drop, which only a publisher that offers one sends: `pnpm publish:pose`
    /// always runs a scenario, which places the body itself, so it has no drop height to show.
    /// Absent rather than zero, so the panel can leave the slider out instead of offering one
    /// that reads 0 and does nothing.
    #[serde(default)]
    pub drop_height: Option<f64>,
    #[serde(default)]
    pub passive: bool,
    #[serde(default)]
    pub redistribute: bool,
    #[serde(default)]
    pub fps: f64,
    #[serde(default)]
    pub steps_per_second: f64,
    #[serde(default)]
    pub gravity: bool,
    #[serde(default)]
    pub floor: bool,
    #[serde(default)]
    pub percentile: f64,
}

#[derive(serde::Deserialize, Clone, Debug, Default)]
pub struct DriveGroup {
    pub title: String,
    pub level: f64,
    /// Arm, Hand, Leg, Trunk or Neck: the desktop's collapsed sections.
    #[serde(default)]
    pub section: String,
}

#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    #[serde(default)]
    pub kinetic: f64,
    #[serde(default)]
    pub potential: f64,
    #[serde(default)]
    pub drift_mm: f64,
    #[serde(default)]
    pub limits_worst: f64,
    #[serde(default)]
    pub violations: f64,
    #[serde(default)]
    pub contacts: f64,
    #[serde(default)]
    pub cost_ms: f64,
}

/// Why there is no status to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StatusError {
    /// No file: no publisher yet, or one that has stopped and cleaned up after itself.
    Missing,
    /// A file that is there and is not a status this reads, with the reader's own words for
    /// why. A file renamed into place is whole or absent, so this is a publisher and a viewer
    /// that disagree about the contract -- which is worth saying, where keeping the last status
    /// that did parse would show a panel that has quietly stopped changing.
    Unreadable(String),
}

impl std::fmt::Display for StatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StatusError::Missing => write!(f, "no status file"),
            StatusError::Unreadable(why) => write!(f, "{why}"),
        }
    }
}

/// A status from its text. serde's message names the field and the column, which is what a
/// reader needs to find which side of the contract moved.
pub fn parse_status(text: &str) -> std::result::Result<Status, StatusError> {
    serde_json::from_str(text).map_err(|e| StatusError::Unreadable(e.to_string()))
}

/// The status as it stands.
pub fn read_status(path: &Path) -> std::result::Result<Status, StatusError> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_status(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(StatusError::Missing),
        Err(e) => Err(StatusError::Unreadable(format!("{}: {e}", path.display()))),
    }
}

/// Commands to the publisher: one JSON object a line, appended to `<pose path>-commands.jsonl`.
/// The file is truncated when this is created, so the publisher starts reading it from the top.
///
/// A publisher that restarts removes the file along with the rest of its session, and the next
/// line appended to the old, unlinked one would reach nobody. So the writer keeps the name and
/// the identity of the file it holds, and before each line -- which is a press on a panel, not a
/// frame -- makes sure the name still leads to it, opening whatever is there now, or a new file,
/// if not. Reopening never truncates: the publisher may already have read part of what is there.
pub struct CommandWriter {
    path: std::path::PathBuf,
    file: std::fs::File,
    id: Option<FileId>,
}

impl CommandWriter {
    pub fn create(path: &Path) -> Result<Self> {
        let mut writer = Self::open(path)?;
        writer.file.set_len(0)?;
        writer.id = open_file_id(&writer.file);
        Ok(writer)
    }

    fn open(path: &Path) -> Result<Self> {
        let file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        let id = open_file_id(&file);
        Ok(Self {
            path: path.to_path_buf(),
            file,
            id,
        })
    }

    /// Open whatever is at the name now, appending, whether or not it has changed. Called when
    /// the feeds are reopened, which is the moment a new publisher is known to be there.
    pub fn reopen(&mut self) -> Result<()> {
        *self = Self::open(&self.path)?;
        Ok(())
    }

    pub fn send(&mut self, line: &str) -> Result<()> {
        use std::io::Write;
        let current = file_id(&self.path);
        if current.is_none() || current != self.id {
            self.reopen()?;
        }
        // One write for the line and its newline, so the publisher never reads half a command.
        self.file.write_all(format!("{line}\n").as_bytes())?;
        Ok(())
    }
}
