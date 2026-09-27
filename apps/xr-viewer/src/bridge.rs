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
    fn the_studio_status_parses_with_everything_the_panels_show_and_without() {
        // What the studio and `pnpm publish:pose` write now, trimmed to one of each thing.
        let now = r#"{"generation":3,"scenario":{"id":"quiet-standing","title":"Quiet standing"},
            "scenarios":[{"id":"quiet-standing","title":"Quiet standing"}],"profile":"l3_anatomical",
            "simSeconds":1.5,"speed":0.24,"paused":false,"muscles":true,"holding":[],"grabStrength":1,
            "mode":"running","overlays":{"muscles":true,"tissue":false},
            "scenarioParameters":[{"id":"lean","title":"Lean","value":0.1,"min":0,"max":0.3,"step":0.01,"unit":"m"}],
            "muscleReadout":{"loaded":"12 of 234"},"tension":[0.1,0.5],
            "driveGroups":[{"title":"Elbow flexors","level":20,"section":"Arm"}],
            "tissue":{"discs":[{"bone":"sacrum","kind":"disc","position":[0.017,0.013,-0.051],
            "rotation":[-0.018,0.707,-0.018,0.707]}],"bars":[{"boneA":"sternum","localA":[0.02,0.07,0.04],
            "boneB":"rib_2_r","localB":[-0.01,-0.05,-0.07]}]},
            "brain":{"serverUp":true,"active":false,"authority":0.3,"selected":"stand-7",
            "checkpoints":[{"id":"stand-7","name":"stand, generation 7"}],"fit":"","training":"",
            "trainingRunning":true,"trainingStoppable":true,"following":false,
            "canStart":false,"canStop":true,"canHandOver":true,"canRelease":false,
            "policyNote":"No dashboard server: checkpoints trained here are kept in this browser.",
            "spineNote":"Stretch and Damping at zero is a body with no reflexes at all."},
            "training":{"task":"stand","episode":4,"generation":7,"fitness":0.812}}"#;
        let status: Status = serde_json::from_str(now).expect("parses");
        assert_eq!(status.mode, "running");
        assert_eq!(status.overlays.get("tissue"), Some(&false));
        assert_eq!(status.scenario_parameters[0].unit, "m");
        assert_eq!(status.drive_groups[0].section, "Arm");
        assert_eq!(status.tissue.discs[0].bone, "sacrum");
        assert_eq!(status.tissue.bars[0].bone_b, "rib_2_r");
        assert_eq!(status.brain.checkpoints[0].name, "stand, generation 7");
        assert!(!status.brain.can_start && status.brain.can_stop);
        assert!(status.brain.can_hand_over && !status.brain.can_release);
        assert!(status.brain.policy_note.starts_with("No dashboard server"));
        assert!(status.brain.spine_note.contains("no reflexes"));
        assert_eq!(status.training.as_ref().map(|t| t.generation), Some(7));
        // An older publisher that says none of that is still a status: every new key defaults.
        let before = r#"{"generation":1,"scenario":{"id":"a","title":"A"},"scenarios":[],
            "profile":"l1_standard","simSeconds":0,"speed":1,"paused":true,"muscles":false,
            "holding":[],"grabStrength":1}"#;
        let status: Status = serde_json::from_str(before).expect("parses");
        assert!(status.overlays.is_empty() && status.tissue.discs.is_empty());
        assert!(status.training.is_none() && !status.brain.active);
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
    #[serde(default)]
    pub drop_height: f64,
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
