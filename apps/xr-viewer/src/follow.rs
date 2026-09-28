//! Following a publisher: the files it writes -- the pose bridge, the muscle rings beside it, the
//! grab channel back -- opened together as one generation, and its status read ten times a second
//! by the clock, with what the panels and the terminal say when it goes quiet or stops moving.
//!
//! Nothing here waits on the publisher (ADR-012): opening is a map of files on tmpfs, and a poll
//! is a stat and a read of a small file. A publisher that is not there yet, or has gone, is simply
//! not there this poll, and the frame loop draws what it has.

use anyhow::Result;

/// Everything read from or written to one generation of the publisher's files.
pub(crate) struct Feeds {
    pub(crate) generation: u64,
    pub(crate) bridge: crate::bridge::PoseBridge,
    pub(crate) muscles: Option<crate::bridge::MuscleBridge>,
    pub(crate) grabs: crate::bridge::GrabIntentWriter,
    /// For each pack bone, its index in the bridge's bone order, matched by name once.
    pub(crate) pose_index: Vec<Option<usize>>,
    /// Which files these are, so a publisher that replaces them is noticed even when it keeps
    /// its generation.
    pub(crate) mapped: crate::bridge::MappedId,
}

impl Feeds {
    pub(crate) fn open(
        path: &std::path::Path,
        pack: &crate::pack::Pack,
        renderer: &mut crate::render::Renderer,
    ) -> Result<Self> {
        let bridge = crate::bridge::PoseBridge::open(path)?;
        // Matched by name once, because the pack and the pose are in different orders and the
        // pose may carry bones the pack has no mesh for.
        let pose_index: Vec<Option<usize>> = pack
            .bones
            .iter()
            .map(|bone| bridge.names.iter().position(|n| *n == bone.id))
            .collect();
        println!(
            "following {}: {} of {} pack bones have a pose, dataset scale {:.4}",
            path.display(),
            pose_index.iter().filter(|m| m.is_some()).count(),
            pack.bones.len(),
            bridge.dataset_scale
        );
        // The muscles, if the simulation has them: rings in their own bridge beside the poses,
        // swept into tubes every time a new frame arrives. A publisher with muscles off writes
        // no such file, which is not an error.
        let muscle_path = crate::bridge::muscle_path(path);
        let muscles = match crate::bridge::MuscleBridge::open(&muscle_path) {
            Ok(m) => {
                println!(
                    "muscles: {} bellies of {} rings, {} segments round",
                    m.units, m.rings, m.segments
                );
                renderer.enable_muscles(m.units, m.rings, m.segments)?;
                Some(m)
            }
            Err(e) => {
                if muscle_path.exists() {
                    println!("muscles: {e:#}");
                } else {
                    println!("muscles: none published");
                }
                None
            }
        };
        let mapped = crate::bridge::MappedId {
            pose: bridge.id,
            muscles: match &muscles {
                Some(m) => m.id,
                None => crate::bridge::file_id(&muscle_path),
            },
        };
        let grabs = crate::bridge::GrabIntentWriter::create(&std::path::PathBuf::from(format!(
            "{}-grab",
            path.display()
        )))?;
        let generation = crate::bridge::read_status(&std::path::PathBuf::from(format!(
            "{}-status.json",
            path.display()
        )))
        .map(|s| s.generation)
        .unwrap_or(0);
        Ok(Self {
            generation,
            mapped,
            bridge,
            muscles,
            grabs,
            pose_index,
        })
    }
}

/// How often the publisher's status is read: every publisher writes it about this often, so a
/// faster poll would read the same file twice and a slower one would lag a scenario switch.
pub(crate) const STATUS_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// The status file as it stands: when it was last modified, and its text.
pub(crate) fn read_status_file(path: &std::path::Path) -> std::io::Result<(Option<std::time::SystemTime>, String)> {
    let modified = std::fs::metadata(path)?.modified().ok();
    Ok((modified, std::fs::read_to_string(path)?))
}

/// Point the command log at whatever file is at its name now: a new publisher has just been
/// found, and it may have removed the old one.
pub(crate) fn reopen_commands(commands: &mut Option<crate::bridge::CommandWriter>) {
    if let Some(writer) = commands.as_mut() {
        if let Err(e) = writer.reopen() {
            println!("panel: could not reopen the command log: {e:#}");
        }
    }
}

/// The publisher's status as the viewer follows it: the last one that parsed, why the newest one
/// did not if it did not, and when it last changed.
#[derive(Default)]
pub(crate) struct StatusFeed {
    pub(crate) status: Option<crate::bridge::Status>,
    /// Why the file that is there now is not a status, in serde's words. The last good status is
    /// kept beside it, so the panels still show where things stood, but they say this at the
    /// top: a panel that has silently stopped changing is the thing this is here to prevent.
    pub(crate) error: Option<String>,
    /// When the status last changed. Every publisher renames a new file into place on every
    /// write and puts its wall-clock seconds in it, so the text changes whenever it is alive,
    /// and the modification time is compared too for one that writes the same text twice.
    seen: Option<std::time::Instant>,
    last: Option<(Option<std::time::SystemTime>, String)>,
}

impl StatusFeed {
    /// Take one reading of the status file, parsed only if it is not the reading before.
    pub(crate) fn observe(
        &mut self,
        reading: std::io::Result<(Option<std::time::SystemTime>, String)>,
        now: std::time::Instant,
    ) {
        match reading {
            // No file: the publisher has not started, or has stopped and cleaned up. There is
            // nothing to show, and nothing is wrong with a status that is not there.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if self.status.is_some() || self.error.is_some() {
                    println!("status: gone");
                }
                *self = Self::default();
            }
            Err(e) => self.fail(e.to_string()),
            Ok(reading) => {
                if self.last.as_ref() == Some(&reading) {
                    return;
                }
                self.seen = Some(now);
                match crate::bridge::parse_status(&reading.1) {
                    Ok(status) => {
                        if self.error.take().is_some() {
                            println!("status: readable again");
                        }
                        self.status = Some(status);
                    }
                    Err(e) => self.fail(e.to_string()),
                }
                self.last = Some(reading);
            }
        }
    }

    /// Keep the reason, and say it on the terminal once rather than ten times a second.
    fn fail(&mut self, why: String) {
        if self.error.as_deref() != Some(why.as_str()) {
            println!("status unreadable: {why}");
        }
        self.error = Some(why);
    }

    /// How long since the status last changed.
    pub(crate) fn age(&self) -> Option<std::time::Duration> {
        self.seen.map(|at| at.elapsed())
    }
}

/// What is wrong with the publisher, as far as the headset can tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    /// The status has not changed for this many whole seconds: whatever was writing it is gone
    /// or stuck, and nothing pressed on a panel will be read.
    Silent(u64),
    /// The status is fresh and says the run is not paused, but no new pose has come for a while.
    NotAdvancing,
}

impl Liveness {
    /// What the panels say, in words somebody in a headset can act on.
    pub fn message(&self) -> String {
        match self {
            Liveness::Silent(seconds) => format!(
                "Publisher silent for {seconds} s: the studio or publish:pose has stopped"
            ),
            Liveness::NotAdvancing => {
                "Simulation not advancing: the publisher is there but no new pose has come".to_string()
            }
        }
    }
}

/// A status this much older than the last one is a publisher that has stopped. Three seconds,
/// not one: the training showcase stops writing for 1.2 s between episodes, and every publisher
/// writes ten times a second while it lives.
const SILENT_AFTER: std::time::Duration = std::time::Duration::from_secs(3);
/// A status seen this recently is a publisher that is certainly still there.
const FRESH: std::time::Duration = std::time::Duration::from_secs(1);
/// A pose this old, from a run that is not paused, is a simulation that is not moving.
const POSE_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(1);
/// How much longer ago the last pose must be than the last status. Both stop together when a
/// publisher pauses between episodes, as the showcase does, and a status noticed a poll after the
/// last pose must not read as a publisher that talks without moving; one that is really stuck
/// goes on writing its status while the pose ages past this.
const TALKING_WITHOUT_MOVING: std::time::Duration = std::time::Duration::from_millis(500);

/// Whether to warn about the publisher, from how long ago its status last changed and a new pose
/// last came, and whether it says it is paused. Paused, a still body is what was asked for.
pub fn liveness(
    status_age: Option<std::time::Duration>,
    pose_age: Option<std::time::Duration>,
    paused: bool,
) -> Option<Liveness> {
    let status_age = status_age?;
    if status_age > SILENT_AFTER {
        return Some(Liveness::Silent(status_age.as_secs()));
    }
    let pose_age = pose_age?;
    let talking_without_moving = pose_age
        .checked_sub(status_age)
        .is_some_and(|gap| gap >= TALKING_WITHOUT_MOVING);
    if !paused && status_age <= FRESH && pose_age > POSE_STALE_AFTER && talking_without_moving {
        return Some(Liveness::NotAdvancing);
    }
    None
}

/// What the terminal was last told about the publisher's liveness, so it is told of a change
/// once, rather than every frame, and a silence is not reported again every second it lasts.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SaidLiveness {
    Fine,
    Silent,
    NotAdvancing,
}

impl SaidLiveness {
    pub(crate) fn report(self, now: Option<&Liveness>) -> Self {
        let next = match now {
            None => SaidLiveness::Fine,
            Some(Liveness::Silent(_)) => SaidLiveness::Silent,
            Some(Liveness::NotAdvancing) => SaidLiveness::NotAdvancing,
        };
        if next != self {
            match now {
                Some(l) => println!("publisher: {}", l.message()),
                None => println!("publisher: live again"),
            }
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: f64) -> Option<std::time::Duration> {
        Some(std::time::Duration::from_secs_f64(s))
    }

    #[test]
    fn a_paused_run_with_a_fresh_status_is_nothing_to_warn_about() {
        assert_eq!(liveness(secs(0.1), secs(30.0), true), None);
    }

    #[test]
    fn a_status_four_seconds_old_is_a_silent_publisher() {
        assert_eq!(liveness(secs(4.0), secs(4.0), false), Some(Liveness::Silent(4)));
        // Paused or not: a publisher that has stopped writing will not read a press either.
        assert_eq!(liveness(secs(4.0), None, true), Some(Liveness::Silent(4)));
    }

    #[test]
    fn a_fresh_status_over_a_pose_two_seconds_old_is_a_simulation_not_advancing() {
        assert_eq!(liveness(secs(0.1), secs(2.0), false), Some(Liveness::NotAdvancing));
    }

    #[test]
    fn the_showcase_between_episodes_is_not_a_warning() {
        // Status and poses stop together for 1.2 s. The status is noticed up to a poll after the
        // last pose, and neither reading is a warning.
        assert_eq!(liveness(secs(1.3), secs(1.3), false), None);
        assert_eq!(liveness(secs(1.1), secs(1.2), false), None);
        assert_eq!(liveness(secs(0.95), secs(1.05), false), None);
        // No status yet, or no feeds yet: nothing to measure against.
        assert_eq!(liveness(None, secs(9.0), false), None);
        assert_eq!(liveness(secs(0.1), None, false), None);
    }

    fn reading(text: &str) -> std::io::Result<(Option<std::time::SystemTime>, String)> {
        Ok((None, text.to_string()))
    }

    const STATUS: &str = r#"{"generation":1,"scenario":{"id":"a","title":"A"},"scenarios":[],
        "profile":"l1_standard","simSeconds":0,"speed":1,"paused":false,"muscles":false,
        "holding":[],"grabStrength":1,"wallSeconds":1.0}"#;

    #[test]
    fn a_status_is_seen_when_it_changes_and_not_when_it_is_read_again() {
        let mut feed = StatusFeed::default();
        let start = std::time::Instant::now();
        feed.observe(reading(STATUS), start);
        assert!(feed.status.is_some() && feed.error.is_none());
        assert_eq!(feed.seen, Some(start));
        // The same text again is a publisher that has not written since.
        let later = start + std::time::Duration::from_millis(100);
        feed.observe(reading(STATUS), later);
        assert_eq!(feed.seen, Some(start));
        // A new write moves it.
        let next = STATUS.replace("\"wallSeconds\":1.0", "\"wallSeconds\":1.1");
        feed.observe(reading(&next), later);
        assert_eq!(feed.seen, Some(later));
    }

    #[test]
    fn an_unreadable_status_is_said_rather_than_hidden_behind_the_last_good_one() {
        let mut feed = StatusFeed::default();
        let at = std::time::Instant::now();
        feed.observe(reading(STATUS), at);
        feed.observe(reading(&STATUS.replace("\"generation\":1", "\"generation\":null")), at);
        let why = feed.error.clone().expect("the error is kept");
        assert!(why.contains("null"), "{why}");
        assert!(feed.status.is_some(), "the last good status stays for the panels to show");
        // Readable again: the error goes.
        feed.observe(reading(&STATUS.replace("1.0", "2.0")), at);
        assert!(feed.error.is_none());
        // Gone: nothing to show and nothing wrong, and no age to warn about.
        feed.observe(Err(std::io::ErrorKind::NotFound.into()), at);
        assert!(feed.status.is_none() && feed.error.is_none() && feed.age().is_none());
    }
}
