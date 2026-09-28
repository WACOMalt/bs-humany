//! The hands as the runtime gives them: the OpenXR actions a controller is read through, bound
//! for every controller the viewer knows; the haptic ticks that say a press or a grab landed; and
//! what a hand's ray and trigger do to the panels, which is decided by where the press began.
//!
//! The grip is where a hand's cube is drawn and its squeeze grabs; the aim is the ray that points
//! at the panels, and the trigger presses what it points at. The stick is read here and spent in
//! `locomotion.rs`; the squeeze is read here and spent in `grab.rs`.

use anyhow::Result;

use crate::panel::{Hit, Placement};

/// Where a press began, which decides what it does until the trigger is let go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PressOn {
    /// On panel `which`'s face: that panel keeps the hand as its pointer until release.
    Face(usize),
    /// On panel `which`'s grab strip: the only press that carries a panel.
    Strip(usize),
    /// Anywhere else -- empty air, a bone, a hand holding a bone. It presses nothing.
    Air,
}

/// What a hand's ray does to the panels this frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Aim {
    /// Nothing: the ray meets no panel, or the hand is busy.
    Nothing,
    /// On panel `which`'s face at `at`, in points; `pressing` while a press begun there is held.
    Face { which: usize, at: egui::Pos2, pressing: bool },
    /// On panel `which`'s grab strip; `take` when a press begun on this strip is held.
    Strip { which: usize, at: egui::Pos2, take: bool },
}

/// The panel a ray meets first, and where: of panels that overlap on the ray, the nearer, which
/// is the one in front whatever order the panels are kept in.
fn nearest_hit(placements: &[Placement], from: [f32; 3], direction: [f32; 3]) -> Option<(usize, Hit)> {
    placements
        .iter()
        .enumerate()
        .filter_map(|(which, p)| p.hit(from, direction).map(|(t, hit)| (which, t, hit)))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(which, _, hit)| (which, hit))
}

/// What a hand's ray does to the panels, given where its press began, which this keeps: set when
/// the trigger goes down, from what the ray was on then, and cleared when it is let go.
///
/// A press begun on a face keeps that panel whatever the ray meets next, at the ray's point held
/// to the face's edges, so a drag past the edge still ends where it was aimed and never slides
/// onto a strip. If the panel is lost to the ray altogether -- no ray, or the panel behind it --
/// the press is over, and becomes one begun in the air, so that the ray coming back with the
/// trigger still held does not press again on whatever it comes back to. A busy hand, one
/// holding a bone, aims at nothing and its press, begun or held, presses nothing.
pub(crate) fn aim(
    placements: &[Placement],
    ray: Option<([f32; 3], [f32; 3])>,
    pressed: bool,
    busy: bool,
    press: &mut Option<PressOn>,
) -> Aim {
    let hit = if busy { None } else { ray.and_then(|(from, direction)| nearest_hit(placements, from, direction)) };
    if !pressed {
        *press = None;
    } else if press.is_none() || busy {
        *press = Some(match hit {
            _ if busy => PressOn::Air,
            Some((which, Hit::Face(_))) => PressOn::Face(which),
            Some((which, Hit::Grab(_))) => PressOn::Strip(which),
            None => PressOn::Air,
        });
    }
    if busy {
        return Aim::Nothing;
    }
    if let Some(PressOn::Face(which)) = *press {
        return match ray.and_then(|(from, direction)| placements[which].project(from, direction)) {
            Some(at) => Aim::Face { which, at, pressing: true },
            None => {
                *press = Some(PressOn::Air);
                Aim::Nothing
            }
        };
    }
    match hit {
        Some((which, Hit::Face(at))) => Aim::Face { which, at, pressing: false },
        Some((which, Hit::Grab(at))) => Aim::Strip { which, at, take: *press == Some(PressOn::Strip(which)) },
        None => Aim::Nothing,
    }
}

/// A haptic tick: how hard, 0..1, and for how long, in seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Tick {
    amplitude: f32,
    seconds: f32,
}

/// The tick a press gives as it lands on a panel's face: short and light, because every press
/// gives one, and a row of buttons pressed in turn would be a buzz if each were heavy.
pub(crate) const PRESS_TICK: Tick = Tick {
    amplitude: 0.3,
    seconds: 0.015,
};

/// The tick for taking hold and letting go -- a bone grabbed or released, a panel taken or put
/// down: longer and firmer, because the hand has changed what it is doing, and the eye is often
/// on the body rather than on the hand when it happens.
pub(crate) const FIRM_TICK: Tick = Tick {
    amplitude: 0.6,
    seconds: 0.040,
};

/// One interaction profile's bindings: which of its inputs each of the viewer's actions reads.
///
/// Every profile has a grip and an aim pose and a vibration, spelled alike, so those are not
/// listed. The rest differs by controller, and a path a profile has not got makes the runtime
/// refuse that profile's whole suggestion, so each is spelled exactly as the OpenXR
/// specification's list of interaction profiles spells it for that controller.
struct Binding {
    profile: &'static str,
    /// The grab: an analogue grip where the controller has one, which the runtime reads as a
    /// boolean at a threshold of its own; a click otherwise.
    squeeze: &'static str,
    /// The panels' press, analogue for the reason `Hands::trigger` gives.
    trigger: &'static str,
    /// What walks, turns and lifts: a thumbstick, or the Vive's trackpad. None on a controller
    /// with neither.
    stick: Option<&'static str>,
    /// What recentres: that same stick or pad, pressed in.
    recentre: Option<&'static str>,
    /// Whether the viewer cannot run without this profile. Only the Index's: it is the
    /// controller this was built against, and a runtime refusing it means the bindings are
    /// wrong, which should stop the viewer rather than leave it running with dead hands. Every
    /// other profile is a courtesy, and a refusal is said and passed over.
    required: bool,
}

/// The controllers the viewer is bound for. The runtime picks the one for the controller in
/// hand; one it knows no better binding for falls back to the simple profile, which every runtime
/// knows: a select that is both the grab and the press, and no stick.
const BINDINGS: &[Binding] = &[
    Binding {
        profile: "/interaction_profiles/valve/index_controller",
        squeeze: "squeeze/value",
        trigger: "trigger/value",
        stick: Some("thumbstick"),
        recentre: Some("thumbstick/click"),
        required: true,
    },
    Binding {
        profile: "/interaction_profiles/oculus/touch_controller",
        squeeze: "squeeze/value",
        trigger: "trigger/value",
        stick: Some("thumbstick"),
        recentre: Some("thumbstick/click"),
        required: false,
    },
    Binding {
        profile: "/interaction_profiles/microsoft/motion_controller",
        squeeze: "squeeze/click",
        trigger: "trigger/value",
        stick: Some("thumbstick"),
        recentre: Some("thumbstick/click"),
        required: false,
    },
    // Accepted only from an instance made with its extension, which `bring_up` asks for when the
    // runtime has it; without, the suggestion is refused like any other courtesy.
    Binding {
        profile: "/interaction_profiles/hp/mixed_reality_controller",
        squeeze: "squeeze/value",
        trigger: "trigger/value",
        stick: Some("thumbstick"),
        recentre: Some("thumbstick/click"),
        required: false,
    },
    // The Vive's trackpad is its stick: where the thumb rests on it is the deflection, and
    // pressing it in is the recentre.
    Binding {
        profile: "/interaction_profiles/htc/vive_controller",
        squeeze: "squeeze/click",
        trigger: "trigger/value",
        stick: Some("trackpad"),
        recentre: Some("trackpad/click"),
        required: false,
    },
    Binding {
        profile: "/interaction_profiles/khr/simple_controller",
        squeeze: "select/click",
        trigger: "select/click",
        stick: None,
        recentre: None,
        required: false,
    },
];

/// An interaction profile's path as the log and the panel say it: without the
/// `/interaction_profiles/` every one of them begins with, and "none" for the null path, which is
/// what the runtime says of a hand with no controller in it, or one it has not bound yet.
fn profile_name(path: &str) -> &str {
    if path.is_empty() {
        "none"
    } else {
        path.strip_prefix("/interaction_profiles/").unwrap_or(path)
    }
}

/// The tracked controllers as OpenXR actions: a grip pose, an aim pose, a squeeze and a trigger,
/// a stick and its click, per hand, and the vibration back. The grip is where the cube is drawn
/// and the squeeze grabs; the aim is the ray that points at the panel and the trigger presses what
/// it points at.
pub(crate) struct Hands {
    set: openxr::ActionSet,
    #[allow(dead_code)]
    grip: openxr::Action<openxr::Posef>,
    #[allow(dead_code)]
    aim: openxr::Action<openxr::Posef>,
    squeeze: openxr::Action<bool>,
    /// Analogue, not a click: the click a runtime derives from a half-pulled trigger flickers
    /// across its threshold, and every flicker was a release and a press to the panel.
    trigger: openxr::Action<f32>,
    thumbstick: openxr::Action<openxr::Vector2f>,
    /// The stick pressed in: back to where the viewer started, with the panels in front.
    recentre: openxr::Action<bool>,
    /// The controller's vibration, which is how a press, a grab or a panel taken is felt.
    haptic: openxr::Action<openxr::Haptic>,
    paths: [openxr::Path; crate::bridge::HANDS],
    pub(crate) grip_spaces: Vec<openxr::Space>,
    pub(crate) aim_spaces: Vec<openxr::Space>,
}

impl Hands {
    pub(crate) fn new(xr: &openxr::Instance, session: &openxr::Session<openxr::Vulkan>) -> Result<Self> {
        let paths = [
            xr.string_to_path("/user/hand/left")?,
            xr.string_to_path("/user/hand/right")?,
        ];
        let set = xr.create_action_set("hands", "Hands", 0)?;
        let grip = set.create_action::<openxr::Posef>("grip", "Grip pose", &paths)?;
        let aim = set.create_action::<openxr::Posef>("aim", "Aim pose", &paths)?;
        let squeeze = set.create_action::<bool>("grab", "Grab", &paths)?;
        let trigger = set.create_action::<f32>("point", "Press", &paths)?;
        let thumbstick = set.create_action::<openxr::Vector2f>("move", "Move", &paths)?;
        let recentre = set.create_action::<bool>("recentre", "Recentre", &paths)?;
        let haptic = set.create_action::<openxr::Haptic>("tick", "Tick", &paths)?;
        // Suggested per profile, from `BINDINGS`; the runtime picks the profile for the
        // controller in hand.
        let suggest = |binding: &Binding| -> Result<()> {
            let mut bindings = Vec::new();
            for side in ["left", "right"] {
                let input = |name: &str| xr.string_to_path(&format!("/user/hand/{side}/input/{name}"));
                if let Some(stick) = binding.stick {
                    bindings.push(openxr::Binding::new(&thumbstick, input(stick)?));
                }
                if let Some(click) = binding.recentre {
                    bindings.push(openxr::Binding::new(&recentre, input(click)?));
                }
                bindings.push(openxr::Binding::new(&grip, input("grip/pose")?));
                bindings.push(openxr::Binding::new(&aim, input("aim/pose")?));
                bindings.push(openxr::Binding::new(&squeeze, input(binding.squeeze)?));
                bindings.push(openxr::Binding::new(&trigger, input(binding.trigger)?));
                // Every profile here names the vibration `output/haptic`, so this is the one
                // path, spelled as they all spell it.
                bindings.push(openxr::Binding::new(
                    &haptic,
                    xr.string_to_path(&format!("/user/hand/{side}/output/haptic"))?,
                ));
            }
            xr.suggest_interaction_profile_bindings(xr.string_to_path(binding.profile)?, &bindings)?;
            Ok(())
        };
        for binding in BINDINGS {
            match suggest(binding) {
                Ok(()) => {}
                Err(e) if binding.required => {
                    return Err(e.context(format!("binding the {} controller", profile_name(binding.profile))));
                }
                Err(e) => println!(
                    "hands: the {} profile was refused ({e}); carrying on without it",
                    profile_name(binding.profile)
                ),
            }
        }
        session.attach_action_sets(&[&set])?;
        let grip_spaces = paths
            .iter()
            .map(|&path| grip.create_space(session, path, openxr::Posef::IDENTITY))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let aim_spaces = paths
            .iter()
            .map(|&path| aim.create_space(session, path, openxr::Posef::IDENTITY))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(Self {
            set,
            grip,
            aim,
            squeeze,
            trigger,
            thumbstick,
            recentre,
            haptic,
            paths,
            grip_spaces,
            aim_spaces,
        })
    }

    /// Which interaction profile the runtime is using for each hand, as `profile_name` says it.
    ///
    /// Asked when the runtime says the profiles changed, never every frame. A runtime that will
    /// not say is said on the terminal and read as no profile: this only ever feeds the log and a
    /// note on the panel, and neither is a reason to stop.
    pub(crate) fn profiles(
        &self,
        xr: &openxr::Instance,
        session: &openxr::Session<openxr::Vulkan>,
    ) -> [String; crate::bridge::HANDS] {
        std::array::from_fn(|hand| {
            let path = session.current_interaction_profile(self.paths[hand]).and_then(|path| {
                if path == openxr::Path::NULL {
                    Ok(String::new())
                } else {
                    xr.path_to_string(path)
                }
            });
            match path {
                Ok(path) => profile_name(&path).to_string(),
                Err(e) => {
                    println!("hands: the runtime would not say what the {} hand is ({e})", ["left", "right"][hand]);
                    profile_name("").to_string()
                }
            }
        })
    }

    /// Whether a hand's stick was pressed in since the last sync: the press, once, rather than
    /// every frame it is held, so a stick held in recentres once.
    pub(crate) fn recentre_pressed(&self, session: &openxr::Session<openxr::Vulkan>, hand: usize) -> Result<bool> {
        let state = self.recentre.state(session, self.paths[hand])?;
        Ok(state.is_active && state.current_state && state.changed_since_last_sync)
    }

    pub(crate) fn sync(&self, session: &openxr::Session<openxr::Vulkan>) -> Result<()> {
        session.sync_actions(&[openxr::ActiveActionSet::new(&self.set)])?;
        Ok(())
    }

    /// Where one of a hand's spaces is in `base` at `time`, if the runtime can say.
    pub(crate) fn locate(
        &self,
        space: &openxr::Space,
        base: &openxr::Space,
        time: openxr::Time,
    ) -> Result<Option<([f32; 3], [f32; 4])>> {
        let located = space.locate(base, time)?;
        let wanted = openxr::SpaceLocationFlags::POSITION_VALID
            | openxr::SpaceLocationFlags::ORIENTATION_VALID;
        if !located.location_flags.contains(wanted) {
            return Ok(None);
        }
        let p = located.pose.position;
        let q = located.pose.orientation;
        Ok(Some(([p.x, p.y, p.z], [q.x, q.y, q.z, q.w])))
    }

    pub(crate) fn squeezing(&self, session: &openxr::Session<openxr::Vulkan>, hand: usize) -> Result<bool> {
        let state = self.squeeze.state(session, self.paths[hand])?;
        Ok(state.is_active && state.current_state)
    }

    /// The thumbstick, x right and y forward, each -1..1; zero when the controller has none.
    pub(crate) fn thumbstick(&self, session: &openxr::Session<openxr::Vulkan>, hand: usize) -> Result<[f32; 2]> {
        let state = self.thumbstick.state(session, self.paths[hand])?;
        Ok(if state.is_active {
            [state.current_state.x, state.current_state.y]
        } else {
            [0.0, 0.0]
        })
    }

    /// Vibrate one hand's controller: a tick, at the runtime's own frequency for the device.
    ///
    /// A courtesy, never a reason to stop: a runtime that refuses one says so and the frame goes
    /// on, since the press or the grab it marks has already happened. A controller with no
    /// vibration, or none bound, is a no-op in OpenXR rather than an error.
    pub(crate) fn pulse(&self, session: &openxr::Session<openxr::Vulkan>, hand: usize, tick: Tick) {
        let vibration = openxr::HapticVibration::new()
            .amplitude(tick.amplitude)
            .duration(openxr::Duration::from_nanos((tick.seconds * 1e9) as i64))
            .frequency(openxr::FREQUENCY_UNSPECIFIED);
        if let Err(e) = self.haptic.apply_feedback(session, self.paths[hand], &vibration) {
            println!("hand {}: the runtime refused a haptic tick ({e})", ["left", "right"][hand]);
        }
    }

    /// How far the trigger is pulled, 0..1; a boolean binding reads as 0 or 1.
    pub(crate) fn trigger(&self, session: &openxr::Session<openxr::Vulkan>, hand: usize) -> Result<f32> {
        let state = self.trigger.state(session, self.paths[hand])?;
        Ok(if state.is_active { state.current_state } else { 0.0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::panel::{GRAB_WIDTH, Kind};

    #[test]
    fn every_controller_binds_the_same_actions_as_its_profile_spells_them() {
        // The Index's is the one that must not be refused; everything else is a courtesy.
        let required: Vec<&str> = BINDINGS.iter().filter(|b| b.required).map(|b| profile_name(b.profile)).collect();
        assert_eq!(required, ["valve/index_controller"]);
        for binding in BINDINGS {
            let name = profile_name(binding.profile);
            // A stick recentres by being pressed in, so a controller has both or neither.
            assert_eq!(binding.stick.is_some(), binding.recentre.is_some(), "{name}");
            if let (Some(stick), Some(click)) = (binding.stick, binding.recentre) {
                assert_eq!(click, format!("{stick}/click"), "{name}");
            }
        }
        for name in ["oculus/touch_controller", "microsoft/motion_controller", "htc/vive_controller", "khr/simple_controller"] {
            assert!(BINDINGS.iter().any(|b| profile_name(b.profile) == name), "no binding for {name}");
        }
        assert_eq!(profile_name(""), "none");
        assert_eq!(profile_name("/interaction_profiles/htc/vive_controller"), "htc/vive_controller");
    }

    /// The properties panel a metre ahead of the origin, facing it, at eye height.
    fn ahead(distance: f32) -> Placement {
        Placement::facing(Kind::Properties.size(), [0.0, 1.5, -distance], [0.0, 1.5, 0.0])
    }

    /// A ray from the origin at eye height to this point of `panel`.
    fn at(panel: &Placement, p: egui::Pos2) -> Option<([f32; 3], [f32; 3])> {
        let from = [0.0, 1.5, 0.0];
        let w = panel.to_world(p);
        Some((from, [w[0] - from[0], w[1] - from[1], w[2] - from[2]]))
    }

    #[test]
    fn of_two_panels_on_one_ray_the_nearer_is_hit_whatever_their_order() {
        let near = ahead(0.6);
        let far = ahead(1.2);
        let (from, direction) = at(&near, egui::pos2(320.0, 390.0)).unwrap();
        assert!(far.hit(from, direction).is_some() && near.hit(from, direction).is_some());
        assert_eq!(nearest_hit(&[far, near], from, direction).map(|(which, _)| which), Some(1));
        assert_eq!(nearest_hit(&[near, far], from, direction).map(|(which, _)| which), Some(0));
        // And a press is taken by the nearer one.
        let mut press = None;
        let aimed = aim(&[far, near], Some((from, direction)), true, false, &mut press);
        assert!(matches!(aimed, Aim::Face { which: 1, pressing: true, .. }), "{aimed:?}");
        assert_eq!(press, Some(PressOn::Face(1)));
    }

    #[test]
    fn a_press_begun_on_the_face_keeps_the_panel_and_never_carries_it() {
        let panel = [ahead(1.0)];
        let mut press = None;
        let begun = aim(&panel, at(&panel[0], egui::pos2(200.0, 300.0)), true, false, &mut press);
        assert!(matches!(begun, Aim::Face { which: 0, pressing: true, .. }), "{begun:?}");
        // Slid onto the strip with the trigger held: still the face, at the strip's inner side,
        // and nothing taken.
        let onto_strip = aim(&panel, at(&panel[0], egui::pos2(10.0, 300.0)), true, false, &mut press);
        match onto_strip {
            Aim::Face { which: 0, at, pressing: true } => assert!((at.x - GRAB_WIDTH).abs() < 1e-2, "{at:?}"),
            other => panic!("{other:?}"),
        }
        // Past the panel's right edge: still the face, at the edge.
        let past = aim(&panel, at(&panel[0], egui::pos2(900.0, 300.0)), true, false, &mut press);
        match past {
            Aim::Face { which: 0, at, pressing: true } => assert!((at.x - 640.0).abs() < 1e-2, "{at:?}"),
            other => panic!("{other:?}"),
        }
        // Let go on the strip: the press is over, and nothing was carried.
        let released = aim(&panel, at(&panel[0], egui::pos2(10.0, 300.0)), false, false, &mut press);
        assert!(matches!(released, Aim::Strip { take: false, .. }), "{released:?}");
        assert_eq!(press, None);
    }

    #[test]
    fn only_a_press_begun_on_the_strip_carries_the_panel() {
        let panel = [ahead(1.0)];
        let mut press = None;
        let taken = aim(&panel, at(&panel[0], egui::pos2(10.0, 300.0)), true, false, &mut press);
        assert!(matches!(taken, Aim::Strip { which: 0, take: true, .. }), "{taken:?}");
        assert_eq!(press, Some(PressOn::Strip(0)));
    }

    #[test]
    fn a_press_begun_in_the_air_presses_nothing_it_sweeps_across() {
        let panel = [ahead(1.0)];
        let mut press = None;
        // Down while pointing away from the panel.
        assert_eq!(aim(&panel, Some(([0.0, 1.5, 0.0], [0.0, 0.0, 1.0])), true, false, &mut press), Aim::Nothing);
        assert_eq!(press, Some(PressOn::Air));
        // Swept across the face and onto the strip, still held: a pointer, never a press or a
        // carry.
        let face = aim(&panel, at(&panel[0], egui::pos2(300.0, 300.0)), true, false, &mut press);
        assert!(matches!(face, Aim::Face { pressing: false, .. }), "{face:?}");
        let strip = aim(&panel, at(&panel[0], egui::pos2(10.0, 300.0)), true, false, &mut press);
        assert!(matches!(strip, Aim::Strip { take: false, .. }), "{strip:?}");
        // A hand holding a bone aims at nothing, pressed or not.
        let mut busy = None;
        assert_eq!(aim(&panel, at(&panel[0], egui::pos2(300.0, 300.0)), true, true, &mut busy), Aim::Nothing);
        assert_eq!(busy, Some(PressOn::Air));
    }

    #[test]
    fn a_press_that_loses_its_panel_does_not_press_again_when_the_ray_comes_back() {
        let panel = [ahead(1.0)];
        let mut press = None;
        aim(&panel, at(&panel[0], egui::pos2(300.0, 300.0)), true, false, &mut press);
        // The ray is lost with the trigger held: the panel lets go.
        assert_eq!(aim(&panel, None, true, false, &mut press), Aim::Nothing);
        // Back on a button with the trigger still held: a pointer, not a second press.
        let back = aim(&panel, at(&panel[0], egui::pos2(300.0, 300.0)), true, false, &mut press);
        assert!(matches!(back, Aim::Face { pressing: false, .. }), "{back:?}");
    }
}
