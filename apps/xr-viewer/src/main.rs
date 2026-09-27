//! The studio's headset renderer: the body in the room, native, outside the web view.
//!
//! It draws the bones from the mesh pack, posed from the pose bridge; the muscles as tubes swept
//! from the belly rings beside it, tinted by tension; and the connective tissue built from the
//! bone poses. Two egui panels -- the properties panel and the transport strip -- drive the studio
//! the way its own controls do, through the status the publisher writes and the commands this
//! appends. The controllers grab bones through the grab channel back, press and carry the panels,
//! and walk, turn and lift the viewer through the world. The desktop studio's **Connect VR
//! viewer** launches it on the studio's own run; `view --follow` on a command line follows
//! `pnpm publish:pose`, or any other publisher, instead.
//!
//!   bs-humany-xr-viewer check-pack [dir]   load the mesh pack, report what is in it. No XR.
//!   bs-humany-xr-viewer probe              which runtime, which headset, which views. No session.
//!   bs-humany-xr-viewer session [seconds]  begin a session and run the frame loop. No drawing.
//!   bs-humany-xr-viewer view [seconds]     draw the body, both eyes in one pass, until Ctrl-C.
//!   ...view [seconds] --follow [path]      ...posed by a publisher at `path` (default
//!                                          /dev/shm/bs-humany-pose), with its panels.
//!   ...view [seconds] --pack dir           ...with the mesh pack from `dir`; beside --follow in
//!                                          either order, which is how the studio launches it.
//!
//! With no `--pack` and no `BS_HUMANY_PACK_DIR`, the pack is `assets-anatomical/data` beside the
//! binary if there is one there, and otherwise this checkout's. Anything on the command line that
//! is not one of the above is refused with exit code 2, by name, before anything is opened.
//!
//! The first needs no hardware at all. The second needs a runtime but no headset. The last two
//! need a headset, which is the order in which things stop being checkable from a terminal.
//!
//! History: the crate began as a probe for deciding whether the native route is worth taking,
//! and answered that it is (the measurements are in the README) before becoming the renderer.

mod bridge;
mod geometry;
mod math;
mod pack;
mod panel;
mod render;
mod tissue;
mod xr;

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// The one line that says how to call this, printed under every complaint about the arguments.
const USAGE: &str = "usage: bs-humany-xr-viewer <check-pack [dir] | probe | session [seconds] \
                     | view [seconds] [--follow [path]] [--pack dir]>";

/// Where `--follow` with no path looks: the bridge `pnpm publish:pose` writes by default.
const DEFAULT_FOLLOW: &str = "/dev/shm/bs-humany-pose";

/// What the command line asked for, decided in full before anything is loaded or opened.
#[derive(Debug, PartialEq)]
enum Command {
    CheckPack { pack: Option<PathBuf> },
    Probe,
    Session { seconds: f32 },
    View { seconds: f32, follow: Option<PathBuf>, pack: Option<PathBuf> },
}

fn main() -> Result<()> {
    // Taken as text, and refused as a whole if some argument is not: a path that is not UTF-8 is
    // better named here than quietly mangled into one that does not exist.
    let args: Vec<String> = match std::env::args_os().skip(1).map(|a| a.into_string()).collect() {
        Ok(args) => args,
        Err(bad) => {
            eprintln!("bs-humany-xr-viewer: the argument {bad:?} is not valid text.\n{USAGE}");
            std::process::exit(2);
        }
    };
    // A mistyped flag stops here, by name, rather than being skipped: `--folow` used to draw the
    // rest pose and follow nothing, which looks exactly like a publisher that is not running.
    // Exit code 2 is the one command-line tools use for being called wrongly.
    let command = match parse(&args) {
        Ok(command) => command,
        Err(why) => {
            eprintln!("bs-humany-xr-viewer: {why}");
            std::process::exit(2);
        }
    };
    match command {
        Command::CheckPack { pack } => check_pack(&pack_dir(pack)),
        Command::Probe => xr::probe(),
        Command::Session { seconds } => xr::run_session(seconds),
        Command::View { seconds, follow, pack } => {
            let pack = load_pack(&pack_dir(pack))?;
            xr::view(&pack, seconds, follow.as_deref())
        }
    }
}

/// Read the arguments after the program's name into a [`Command`], or say what is wrong with them.
///
/// Every token has to mean something. `view` takes its seconds first, if at all, and then
/// `--follow` with an optional path and `--pack` with a required directory, in either order;
/// anything else is named and refused, with the usage line under it. The studio launches
/// `view --follow <bridge> --pack <dir>`, which is one of the shapes this accepts.
fn parse(args: &[String]) -> Result<Command, String> {
    let Some((verb, rest)) = args.split_first() else {
        return Err(format!("say what to do.\n{USAGE}"));
    };
    match verb.as_str() {
        "check-pack" => match rest {
            [] => Ok(Command::CheckPack { pack: None }),
            [dir] if !dir.starts_with('-') => Ok(Command::CheckPack { pack: Some(PathBuf::from(dir)) }),
            [dir, extra, ..] if !dir.starts_with('-') => {
                Err(unexpected("check-pack", extra, "one pack directory"))
            }
            [first, ..] => Err(unexpected("check-pack", first, "one pack directory")),
        },
        "probe" => match rest {
            [] => Ok(Command::Probe),
            [first, ..] => Err(unexpected("probe", first, "nothing")),
        },
        "session" => match rest {
            [] => Ok(Command::Session { seconds: 5.0 }),
            [seconds] => Ok(Command::Session { seconds: parse_seconds(seconds)? }),
            [_, extra, ..] => Err(unexpected("session", extra, "a number of seconds")),
        },
        "view" => parse_view(rest),
        other => Err(format!("no idea what '{other}' means.\n{USAGE}")),
    }
}

/// `view [seconds] [--follow [path]] [--pack dir]`.
fn parse_view(rest: &[String]) -> Result<Command, String> {
    const VALID: &str = "seconds first, then --follow [path] and --pack dir";
    let mut tokens = rest.iter().peekable();
    // Until Ctrl-C, or the runtime says stop, unless a number of seconds leads.
    let mut seconds = f32::INFINITY;
    if let Some(first) = tokens.next_if(|t| !t.starts_with("--")) {
        seconds = parse_seconds(first)?;
    }
    let mut follow: Option<PathBuf> = None;
    let mut pack: Option<PathBuf> = None;
    while let Some(token) = tokens.next() {
        match token.as_str() {
            // `--follow` alone means the bridge's default path; `--follow <path>` names one. A
            // path cannot start with `--`, which is what lets the next flag come straight after.
            "--follow" => {
                if follow.is_some() {
                    return Err(format!("--follow is given twice.\n{USAGE}"));
                }
                let path = tokens.next_if(|t| !t.starts_with("--"));
                follow = Some(PathBuf::from(path.map_or(DEFAULT_FOLLOW, String::as_str)));
            }
            // `--pack DIR`, for a viewer launched from somewhere other than this repository --
            // the studio's bundle, say. Here the directory is not optional: a bare `--pack` is
            // somebody who meant to name one and did not.
            "--pack" => {
                if pack.is_some() {
                    return Err(format!("--pack is given twice.\n{USAGE}"));
                }
                match tokens.next_if(|t| !t.starts_with("--")) {
                    Some(dir) => pack = Some(PathBuf::from(dir)),
                    None => return Err(format!("--pack needs a directory after it.\n{USAGE}")),
                }
            }
            other => return Err(unexpected("view", other, VALID)),
        }
    }
    Ok(Command::View { seconds, follow, pack })
}

/// A number of seconds to run for: positive, or refused by the token that was given.
fn parse_seconds(token: &str) -> Result<f32, String> {
    match token.parse::<f32>() {
        // `> 0.0` is false for NaN as well, which is the point of writing it this way round.
        Ok(seconds) if seconds > 0.0 => Ok(seconds),
        _ => Err(format!("'{token}' is not a positive number of seconds.\n{USAGE}")),
    }
}

/// The complaint about a token that has no place where it stands.
fn unexpected(verb: &str, token: &str, valid: &str) -> String {
    if token.starts_with('-') {
        format!("unknown option {token}; valid for {verb}: {valid}.\n{USAGE}")
    } else {
        format!("unexpected argument '{token}' to {verb}; valid: {valid}.\n{USAGE}")
    }
}

/// Load the pack and say what came out, in the terms somebody can check against the web build.
fn check_pack(dir: &Path) -> Result<()> {
    let pack = load_pack(dir)?;

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

/// Which mesh pack to load: the one named with `--pack` (or check-pack's directory), then
/// `BS_HUMANY_PACK_DIR`, then `assets-anatomical/data` beside this executable, then this checkout's.
///
/// Beside the executable is how a copy of the viewer carried away from the repository -- the
/// studio's tarball carries the two side by side -- finds its pack without being told. It counts
/// only where a manifest is there to read, so an empty directory of that name does not hide the
/// checkout's pack.
fn pack_dir(named: Option<PathBuf>) -> PathBuf {
    choose_pack_dir(
        named,
        std::env::var_os("BS_HUMANY_PACK_DIR").map(PathBuf::from),
        std::env::current_exe().ok().as_deref().and_then(Path::parent),
    )
}

/// [`pack_dir`] with what it reads from the process handed in, so that the order can be tested.
fn choose_pack_dir(named: Option<PathBuf>, from_env: Option<PathBuf>, exe_dir: Option<&Path>) -> PathBuf {
    named
        // Set but empty is the shell's way of unsetting, not a request for the working directory.
        .or(from_env.filter(|dir| !dir.as_os_str().is_empty()))
        .or_else(|| {
            exe_dir
                .map(|dir| dir.join("assets-anatomical/data"))
                .filter(|beside| beside.join("manifest.json").is_file())
        })
        .unwrap_or_else(checkout_pack_dir)
}

/// Where the pack lives in this repository, relative to the crate.
fn checkout_pack_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/assets-anatomical/data")
}

/// Load the pack from `dir`, and when that fails, say how to point the viewer at the right one:
/// the directory it tried is usually the checkout's, which is not there beside a copied binary.
fn load_pack(dir: &Path) -> Result<pack::Pack> {
    pack::load(dir).with_context(|| {
        format!(
            "loading the mesh pack from {}: pass --pack DIR or set BS_HUMANY_PACK_DIR \
             (packages/assets-anatomical/data in a checkout)",
            dir.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    fn view(seconds: f32, follow: Option<&str>, pack: Option<&str>) -> Command {
        Command::View { seconds, follow: follow.map(PathBuf::from), pack: pack.map(PathBuf::from) }
    }

    #[test]
    fn a_mistyped_flag_is_named_rather_than_ignored() {
        let why = parse(&args("view --folow")).unwrap_err();
        assert!(why.contains("--folow"), "{why}");
        assert!(why.contains(USAGE), "{why}");
    }

    #[test]
    fn a_pack_flag_with_no_directory_is_refused() {
        assert!(parse(&args("view --pack")).is_err());
        assert!(parse(&args("view --pack --follow")).is_err());
    }

    #[test]
    fn seconds_then_follow_and_pack() {
        assert_eq!(parse(&args("view 5 --follow /x --pack /p")), Ok(view(5.0, Some("/x"), Some("/p"))));
        assert_eq!(parse(&args("view --pack /p --follow /x")), Ok(view(f32::INFINITY, Some("/x"), Some("/p"))));
    }

    #[test]
    fn a_bare_follow_before_another_flag_follows_the_default_bridge() {
        assert_eq!(
            parse(&args("view --follow --pack /p")),
            Ok(view(f32::INFINITY, Some(DEFAULT_FOLLOW), Some("/p")))
        );
        assert_eq!(parse(&args("view --follow")), Ok(view(f32::INFINITY, Some(DEFAULT_FOLLOW), None)));
    }

    #[test]
    fn what_the_studio_launches_is_accepted() {
        // apps/studio/src-tauri/src/main.rs, xr_viewer_launch: view --follow BRIDGE_BASE --pack DIR.
        let studio = "view --follow /dev/shm/bs-humany-studio --pack /opt/bs-humany/assets-anatomical/data";
        assert_eq!(
            parse(&args(studio)),
            Ok(view(f32::INFINITY, Some("/dev/shm/bs-humany-studio"), Some("/opt/bs-humany/assets-anatomical/data")))
        );
    }

    #[test]
    fn seconds_must_be_a_positive_number() {
        let why = parse(&args("session abc")).unwrap_err();
        assert!(why.contains("'abc'"), "{why}");
        assert!(parse(&args("session 0")).is_err());
        assert!(parse(&args("view -1")).unwrap_err().contains("'-1'"));
        assert!(parse(&args("view NaN")).is_err());
        assert_eq!(parse(&args("session")), Ok(Command::Session { seconds: 5.0 }));
        assert_eq!(parse(&args("session 2.5")), Ok(Command::Session { seconds: 2.5 }));
        assert_eq!(parse(&args("view")), Ok(view(f32::INFINITY, None, None)));
        assert_eq!(parse(&args("view 3")), Ok(view(3.0, None, None)));
    }

    #[test]
    fn seconds_only_lead_and_nothing_is_left_over() {
        // After --follow, a token that is not a flag is the path, whatever it looks like.
        assert_eq!(parse(&args("view --follow 5")), Ok(view(f32::INFINITY, Some("5"), None)));
        assert!(parse(&args("view --pack /p 5")).unwrap_err().contains("'5'"));
        assert!(parse(&args("view 5 6")).is_err());
        assert!(parse(&args("view --follow /a --follow /b")).is_err());
        assert!(parse(&args("session 5 6")).is_err());
        assert!(parse(&args("session --follow")).unwrap_err().contains("--follow"));
        assert!(parse(&args("probe now")).is_err());
        assert!(parse(&args("check-pack /a /b")).unwrap_err().contains("'/b'"));
        assert!(parse(&args("check-pack --pack /a")).unwrap_err().contains("--pack"));
        assert_eq!(parse(&args("check-pack")), Ok(Command::CheckPack { pack: None }));
        assert_eq!(parse(&args("check-pack /a")), Ok(Command::CheckPack { pack: Some(PathBuf::from("/a")) }));
        assert_eq!(parse(&args("probe")), Ok(Command::Probe));
    }

    #[test]
    fn no_command_or_an_unknown_one_is_refused() {
        assert!(parse(&[]).unwrap_err().contains(USAGE));
        assert!(parse(&args("veiw")).unwrap_err().contains("veiw"));
    }

    #[test]
    fn the_pack_is_looked_for_in_order() {
        let from_env = || Some(PathBuf::from("/from-env"));
        assert_eq!(choose_pack_dir(Some(PathBuf::from("/named")), from_env(), None), PathBuf::from("/named"));
        assert_eq!(choose_pack_dir(None, from_env(), None), PathBuf::from("/from-env"));
        assert_eq!(choose_pack_dir(None, Some(PathBuf::new()), None), checkout_pack_dir());

        // Beside the executable, but only where a manifest is there to be read.
        let exe_dir = std::env::temp_dir().join(format!("bs-humany-pack-beside-{}", std::process::id()));
        let beside = exe_dir.join("assets-anatomical/data");
        std::fs::create_dir_all(&beside).unwrap();
        assert_eq!(choose_pack_dir(None, None, Some(&exe_dir)), checkout_pack_dir());
        std::fs::write(beside.join("manifest.json"), "{}").unwrap();
        assert_eq!(choose_pack_dir(None, None, Some(&exe_dir)), beside);
        assert_eq!(choose_pack_dir(None, from_env(), Some(&exe_dir)), PathBuf::from("/from-env"));
        std::fs::remove_dir_all(&exe_dir).unwrap();
    }
}
