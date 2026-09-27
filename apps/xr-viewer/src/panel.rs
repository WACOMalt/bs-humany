//! The panels: the studio's controls, in the room.
//!
//! The studio's UI is a web page in a WebKit view, and there is no way to get that onto a Vulkan
//! image at headset rate. So the controls are drawn again here with egui -- immediate mode, one
//! function a frame, no state to keep in step -- and stood up in the room as quads. There are two,
//! as the desktop has two regions that are not the viewport:
//!
//! - the **properties panel**, its tabs down its left edge as the desktop's are: Body, World, Sim,
//!   Scene, Muscles, Brain, Training, Export, and under a Developer divider Health, with the same
//!   controls sending the same keys (the desktop's Align tab, which edits files, is not here);
//! - the **transport panel**, one horizontal strip: the run's Start, Pause and Reset, the mode,
//!   the playhead and its frame buttons, the grid, and the overlay toggles; and the headset's own
//!   Snap turn box, which is reported back to the viewer as a `LocalAction` and never sent on.
//!
//! Each has a **grab strip** down its left edge. A hand whose ray is on the strip when it pulls
//! the trigger takes the panel with it until the trigger is let go; the panel then stays where it
//! was put. A controller's aim ray is otherwise the pointer and its trigger the click, and a press
//! keeps the panel it began on, at the ray's point held to the face, until it is let go. A hand
//! aimed at a face scrolls it with its thumbstick. The panels'
//! geometry is here, the Vulkan that draws them is in `render.rs`, and what the buttons do goes
//! back to the publisher as commands through `bridge::CommandWriter`.
//!
//! Everything in points inside egui, at one millimetre a point in the room, so the 640-point
//! properties panel is 64 centimetres wide: text the size it would be on a poster at arm's
//! length, which is what a headset's resolution wants. egui rasterises it at two pixels a point,
//! and `render.rs` gives every texture a mip chain, so text read from across the room is averaged
//! rather than shimmering.

use crate::bridge::{Brain, ControlRange, Status};

/// Metres a point.
pub const POINT_METRES: f32 = 0.001;
/// The grab strip's width, in points, down every panel's left edge.
pub const GRAB_WIDTH: f32 = 36.0;

/// Which of the two panels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Properties,
    Transport,
}

impl Kind {
    /// The panel's size, in points.
    pub fn size(self) -> [f32; 2] {
        match self {
            Kind::Properties => [640.0, 780.0],
            Kind::Transport => [1000.0, 150.0],
        }
    }
}

/// Where a panel stands: an origin at its top-left corner and the directions its points run,
/// all in the world, and how big it is.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub origin: [f32; 3],
    pub right: [f32; 3],
    pub down: [f32; 3],
    pub normal: [f32; 3],
    pub size: [f32; 2],
}

/// What a ray meets on a panel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Hit {
    /// A point on the panel's face, in points.
    Face(egui::Pos2),
    /// The grab strip, at this point.
    Grab(egui::Pos2),
}

impl Placement {
    /// A panel centred at `centre`, upright, turned to face `toward` (usually where the viewer
    /// stands, the stage origin).
    pub fn facing(size: [f32; 2], centre: [f32; 3], toward: [f32; 3]) -> Self {
        let mut normal = [toward[0] - centre[0], 0.0, toward[2] - centre[2]];
        let length = (normal[0] * normal[0] + normal[2] * normal[2]).sqrt();
        if length < 1e-6 {
            normal = [0.0, 0.0, 1.0];
        } else {
            normal[0] /= length;
            normal[2] /= length;
        }
        // up x normal is the viewer's right when they face the panel.
        let right = [normal[2], 0.0, -normal[0]];
        let down = [0.0, -1.0, 0.0];
        let half = [size[0] * POINT_METRES / 2.0, size[1] * POINT_METRES / 2.0];
        let origin = [
            centre[0] - right[0] * half[0] - down[0] * half[1],
            centre[1] - right[1] * half[0] - down[1] * half[1],
            centre[2] - right[2] * half[0] - down[2] * half[1],
        ];
        Self {
            origin,
            right,
            down,
            normal,
            size,
        }
    }

    /// The matrix that stands a point (x, y, 0) up in the room, column-major.
    pub fn model(&self) -> [f32; 16] {
        let s = POINT_METRES;
        [
            self.right[0] * s, self.right[1] * s, self.right[2] * s, 0.0, //
            self.down[0] * s, self.down[1] * s, self.down[2] * s, 0.0, //
            self.normal[0], self.normal[1], self.normal[2], 0.0, //
            self.origin[0], self.origin[1], self.origin[2], 1.0,
        ]
    }

    /// Where a ray meets the panel's plane, if the plane is in front of the ray: how far along
    /// the ray, and the point in points, which may lie outside the panel.
    fn plane_point(&self, from: [f32; 3], direction: [f32; 3]) -> Option<(f32, egui::Pos2)> {
        let denominator = dot(direction, self.normal);
        if denominator.abs() < 1e-6 {
            return None;
        }
        let to_origin = [
            self.origin[0] - from[0],
            self.origin[1] - from[1],
            self.origin[2] - from[2],
        ];
        let t = dot(to_origin, self.normal) / denominator;
        if t < 0.02 {
            return None;
        }
        let at = [
            from[0] + direction[0] * t - self.origin[0],
            from[1] + direction[1] * t - self.origin[1],
            from[2] + direction[2] * t - self.origin[2],
        ];
        Some((t, egui::pos2(dot(at, self.right) / POINT_METRES, dot(at, self.down) / POINT_METRES)))
    }

    /// Where a ray meets the panel, if it does and the panel is in front of the ray: how far
    /// along the ray, so that of two panels on one ray the nearer can be chosen, and the grab
    /// strip or the face with the point in points.
    pub fn hit(&self, from: [f32; 3], direction: [f32; 3]) -> Option<(f32, Hit)> {
        let (t, p) = self.plane_point(from, direction)?;
        if p.x < 0.0 || p.y < 0.0 || p.x > self.size[0] || p.y > self.size[1] {
            return None;
        }
        Some((t, if p.x < GRAB_WIDTH { Hit::Grab(p) } else { Hit::Face(p) }))
    }

    /// Where a ray points on the panel's face even when it has left the panel: the plane's
    /// point held to the face's edges. A press keeps the panel it began on until it is let go,
    /// and this is where it is while the ray is off the edge, so a slider dragged past its end
    /// sits at its end rather than being dropped, and a drag never slides onto the grab strip.
    /// `None` only when the plane is not in front of the ray at all.
    pub fn project(&self, from: [f32; 3], direction: [f32; 3]) -> Option<egui::Pos2> {
        let (_, p) = self.plane_point(from, direction)?;
        Some(egui::pos2(p.x.clamp(GRAB_WIDTH, self.size[0]), p.y.clamp(0.0, self.size[1])))
    }

    /// The middle of the panel, in the room.
    pub fn centre(&self) -> [f32; 3] {
        self.to_world(egui::pos2(self.size[0] / 2.0, self.size[1] / 2.0))
    }

    /// A point on the panel, back in the room.
    pub fn to_world(self, p: egui::Pos2) -> [f32; 3] {
        let s = POINT_METRES;
        [
            self.origin[0] + self.right[0] * p.x * s + self.down[0] * p.y * s,
            self.origin[1] + self.right[1] * p.x * s + self.down[1] * p.y * s,
            self.origin[2] + self.right[2] * p.x * s + self.down[2] * p.y * s,
        ]
    }

    /// The panel as a hand holds it: its frame expressed in the hand's, so the hand can carry it.
    pub fn held_by(&self, hand_at: [f32; 3], hand_q: [f32; 4]) -> Held {
        let inverse = crate::math::quaternion_conjugate(hand_q);
        let origin = crate::math::rotate(
            [
                self.origin[0] - hand_at[0],
                self.origin[1] - hand_at[1],
                self.origin[2] - hand_at[2],
            ],
            inverse,
        );
        Held {
            origin,
            right: crate::math::rotate(self.right, inverse),
            down: crate::math::rotate(self.down, inverse),
            normal: crate::math::rotate(self.normal, inverse),
        }
    }

    /// Where the panel is now, carried by a hand that is here.
    pub fn carried(&self, held: &Held, hand_at: [f32; 3], hand_q: [f32; 4]) -> Self {
        let origin = crate::math::rotate(held.origin, hand_q);
        Self {
            origin: [origin[0] + hand_at[0], origin[1] + hand_at[1], origin[2] + hand_at[2]],
            right: crate::math::rotate(held.right, hand_q),
            down: crate::math::rotate(held.down, hand_q),
            normal: crate::math::rotate(held.normal, hand_q),
            size: self.size,
        }
    }
}

/// A panel's frame in the frame of the hand that took hold of it.
#[derive(Clone, Copy, Debug)]
pub struct Held {
    origin: [f32; 3],
    right: [f32; 3],
    down: [f32; 3],
    normal: [f32; 3],
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// What a button asked for.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Pause,
    Resume,
    Reset,
    /// One output frame forward (1) or back (-1), pausing if it was not.
    Step(i32),
    /// Go to this many simulated seconds.
    Scrub(f64),
    /// A muscle group's slider, 0..100.
    Drive(usize, f32),
    /// A setting by name; the publisher decides whether it rebuilds. `overlay.<name>` is a
    /// viewport overlay, `scenario.<id>` a scenario's own parameter.
    Set(String, serde_json::Value),
    /// The brain: select, setup, undoSetup, handover, release, authority, trainStart, trainStop,
    /// follow, and the cord's and the memory's sliders.
    Brain {
        action: &'static str,
        id: Option<String>,
        value: Option<f64>,
    },
}

impl Command {
    /// The line the publisher reads.
    pub fn to_json(&self) -> String {
        match self {
            Command::Pause => r#"{"kind":"pause"}"#.to_string(),
            Command::Resume => r#"{"kind":"resume"}"#.to_string(),
            Command::Reset => r#"{"kind":"reset"}"#.to_string(),
            Command::Step(frames) => format!(r#"{{"kind":"step","frames":{frames}}}"#),
            Command::Scrub(seconds) => format!(r#"{{"kind":"scrub","seconds":{seconds}}}"#),
            Command::Drive(group, value) => {
                format!(r#"{{"kind":"drive","group":{group},"value":{value}}}"#)
            }
            Command::Set(key, value) => {
                serde_json::json!({"kind": "set", "key": key, "value": value}).to_string()
            }
            Command::Brain { action, id, value } => {
                let mut object = serde_json::json!({"kind": "brain", "action": action});
                if let Some(id) = id {
                    object["id"] = serde_json::Value::String(id.clone());
                }
                if let Some(value) = value {
                    object["value"] = serde_json::json!(value);
                }
                object.to_string()
            }
        }
    }
}

fn set(key: &str, value: impl Into<serde_json::Value>) -> Command {
    Command::Set(key.to_string(), value.into())
}

/// One of egui's meshes, with the rectangle it may draw inside, in points. egui only drops a
/// shape that lies wholly outside its clip rectangle and leaves the cutting of the rest to the
/// renderer, so without the rectangle a scrolled row half out of its column draws over the
/// footer, the tabs or the room beyond the panel's edge.
pub struct Mesh {
    pub texture: egui::TextureId,
    pub clip: egui::Rect,
    pub vertices: Vec<egui::epaint::Vertex>,
    pub indices: Vec<u32>,
}

/// One frame of a panel: its meshes to draw, its texture changes to apply first, and what the
/// person pressed.
pub struct Frame {
    pub meshes: Vec<Mesh>,
    pub textures: egui::TexturesDelta,
    pub commands: Vec<Command>,
    /// What was pressed that is the headset's own business, which the viewer acts on itself and
    /// never writes to the command file. One at most: a press lands on one control.
    pub local: Option<LocalAction>,
}

/// A press that changes the viewer rather than the run: the publisher has no say in it and is
/// never told of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalAction {
    /// Snap turn on or off: whether the right stick turns in steps or smoothly.
    SnapTurn(bool),
}

/// What the viewer knows of itself that no publisher sends, for the panels to show.
#[derive(Clone, Debug, Default)]
pub struct Headset {
    /// The interaction profile the runtime is using for each hand, left then right, as
    /// `input::profile_name` says it; empty until the runtime has said.
    pub profiles: [String; 2],
    /// Whether the right stick turns in steps. The viewer's, and kept by the viewer: the panel
    /// only shows it and reports a press of it as a `LocalAction`.
    pub snap_turn: bool,
}

/// What the pointer is doing this frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pointer {
    pub at: Option<egui::Pos2>,
    pub pressed: bool,
    /// The thumbstick of a hand aimed at the panel, forward positive, past its dead zone: the
    /// wheel, since a headset has no other way to reach the bottom of a long tab.
    pub scroll: f32,
}

/// How fast a stick held full over scrolls, in points a second: most of the properties panel's
/// height in a second, quick enough to cross the Muscles tab and slow enough to stop on a row.
const SCROLL_SPEED: f32 = 900.0;

/// The properties panel's tabs, the desktop's in the desktop's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Tab {
    Body,
    World,
    Sim,
    Scene,
    Muscles,
    Brain,
    Training,
    Export,
    Health,
}

/// The tabs for working with the body, above the divider.
const TABS: [(Tab, &str); 8] = [
    (Tab::Body, "Body"),
    (Tab::World, "World"),
    (Tab::Sim, "Sim"),
    (Tab::Scene, "Scene"),
    (Tab::Muscles, "Muscles"),
    (Tab::Brain, "Brain"),
    (Tab::Training, "Training"),
    (Tab::Export, "Export"),
];

/// The tabs for working on the model, under a Developer divider as the desktop has them. The
/// desktop's Align is the other one there; it opens and saves files, which a headset cannot, so
/// it has never been drawn here.
const DEVELOPER_TABS: [(Tab, &str); 1] = [(Tab::Health, "Health")];

pub struct Panel {
    kind: Kind,
    ctx: egui::Context,
    started: std::time::Instant,
    was_pressed: bool,
    was_on: bool,
    tab: Tab,
    /// The slider being dragged, and its value, which is the panel's until it is let go and the
    /// publisher confirms it. Every other slider shows what the publisher last said.
    editing: Option<(String, f32)>,
    last_live_send: f64,
    /// Whether the panel is being carried, so the strip can say so.
    pub grabbed: bool,
    /// The properties panel's scroll area, as egui last named it, so a test can read its offset.
    #[cfg_attr(not(test), allow(dead_code))]
    scroll_id: Option<egui::Id>,
}

/// Which slider is being dragged and what it reads, and whether a pointer is on the panel at
/// all -- without which no slider is trusted, because egui reports a slider changed whenever
/// the value it is handed moves under it, and a live readout moves every status tick.
pub struct Editing {
    current: Option<(String, f32)>,
    on_panel: bool,
    /// When a live slider last sent, so a drag sends a few dozen times a second, not a few hundred.
    last_live_send: f64,
    now: f64,
}

/// A slider whose value comes from the status except while it is being dragged; `Some` on a
/// frame it should be sent. A `live` slider sends as it is dragged, throttled, and again on
/// release -- drives, the timeline, grab strength, which the run takes in its stride. One that is
/// not live sends only at the end of a drag or on a click, because what it sets rebuilds the run
/// and a stature dragged across its range must not rebuild fifty bodies on the way.
///
/// Its bounds and step are the publisher's, from the status's `controls` -- the one table the
/// desktop's sliders are held to -- and a key the publisher sent none for draws nothing: that
/// publisher does not honour it. The ranges written out here, and the snaps that rounded a value
/// once it was let go, used to be a second copy of the desktop's, which drifted from it.
fn slider(
    ui: &mut egui::Ui,
    editing: &mut Editing,
    s: &Status,
    key: &str,
    label: &str,
    from_status: f64,
    live: bool,
) -> Option<f64> {
    let range = *s.controls.get(key)?;
    slider_in(ui, editing, key, label, from_status, range, live)
}

/// `slider`, for a range the caller has rather than one from the table: a scenario's own
/// parameter, whose bounds and step travel with it. The slider moves in whole steps while it is
/// dragged, as the desktop's does, so what is let go of is what was shown, and the value sent is
/// written to the step's places rather than as the f32 the slider holds.
fn slider_in(
    ui: &mut egui::Ui,
    editing: &mut Editing,
    key: &str,
    label: &str,
    from_status: f64,
    range: ControlRange,
    live: bool,
) -> Option<f64> {
    let decimals = range.decimals();
    let bounds = (range.min as f32)..=(range.max as f32);
    slider_shown(ui, editing, key, label, from_status as f32, bounds, live, |s| {
        s.fixed_decimals(decimals).step_by(range.step)
    })
    .map(|value| range.snap(value as f64))
}

/// `slider`, with the number beside it written and read by `shown` rather than to a fixed number
/// of decimals: a drive slider, whose number is not its position.
#[allow(clippy::too_many_arguments)]
fn slider_shown(
    ui: &mut egui::Ui,
    editing: &mut Editing,
    key: &str,
    label: &str,
    from_status: f32,
    range: std::ops::RangeInclusive<f32>,
    live: bool,
    shown: impl for<'s> FnOnce(egui::Slider<'s>) -> egui::Slider<'s>,
) -> Option<f32> {
    let held = match &editing.current {
        Some((k, v)) if k == key => Some(*v),
        _ => None,
    };
    let mut value = held.unwrap_or(from_status);
    // The label beside the slider, as egui's own would be, but wrapped to what is left of the
    // row: egui never wraps a slider's text, and the Body tab's longer ones ran past the panel's
    // edge, where the panel's clip now cuts them off mid-word.
    let response = ui
        .horizontal(|ui| {
            let response = ui.add(shown(egui::Slider::new(&mut value, range)));
            ui.add(egui::Label::new(label).wrap());
            response
        })
        .inner;
    // Before the pointer is asked about: a drag whose ray was lost altogether ends with the
    // pointer gone and the press released in the same frame, and the value it reached is still
    // the one the person chose. Not the one the slider has just taken, which is where `run` put
    // that release -- off the panel, so that it clicks nothing -- and so the slider's minimum.
    if response.drag_stopped() {
        editing.current = None;
        return Some(if editing.on_panel { value } else { held.unwrap_or(value) });
    }
    if !editing.on_panel {
        if editing.current.as_ref().map(|(k, _)| k == key).unwrap_or(false) {
            editing.current = None;
        }
        return None;
    }
    if response.dragged() {
        let moved = editing.current.as_ref().map(|(k, v)| k != key || *v != value).unwrap_or(true);
        editing.current = Some((key.to_string(), value));
        if live && moved && editing.now - editing.last_live_send >= 0.05 {
            editing.last_live_send = editing.now;
            return Some(value);
        }
    }
    if response.clicked() {
        editing.current = None;
        return Some(value);
    }
    None
}

fn checkbox(ui: &mut egui::Ui, on: bool, label: &str) -> Option<bool> {
    let mut value = on;
    if ui.checkbox(&mut value, label).changed() {
        Some(value)
    } else {
        None
    }
}

fn heading(ui: &mut egui::Ui, text: &str) {
    ui.add_space(4.0);
    ui.label(egui::RichText::new(text).strong());
}

/// The panels' background, premultiplied: nearly opaque, so the room shows through only faintly.
const PANEL_FILL: egui::Color32 = egui::Color32::from_rgba_premultiplied(18, 20, 24, 235);
/// A label's text: brighter than egui's dark theme gives it, so that a note can sit below it and
/// still be read.
const BODY_TEXT: egui::Color32 = egui::Color32::from_gray(210);
/// A note's text. egui's `weak` blends the label colour halfway towards the theme's background,
/// which on this fill came out a grey of 83, about 2.4:1 -- well under WCAG's 4.5:1 for body
/// text, and in a headset, where the lenses soften text already, the long notes were the first
/// thing to go. This clears 4.5:1 over the fill whatever is behind the panel, and is still
/// visibly dimmer than a label.
const NOTE_TEXT: egui::Color32 = egui::Color32::from_gray(160);

fn note(ui: &mut egui::Ui, text: &str) {
    ui.label(egui::RichText::new(text).color(NOTE_TEXT));
}

/// What the controllers do, as the headset's own guide says it: in the waiting view, where
/// someone who has just put the headset on looks first, and at the foot of the Health tab.
/// README's "Moving about" says the same, from this list.
pub const CONTROLS: &[(&str, &str)] = &[
    ("Left stick", "walk, the way you are looking"),
    ("Right stick", "turn (left / right), rise or sink (forward / back)"),
    ("Grip on a bone", "grab it (the trigger, on a basic controller)"),
    ("Trigger at a panel", "press"),
    ("Stick, aimed at a panel", "scroll it"),
    ("Trigger on the dotted strip", "carry the panel"),
    ("Stick click", "recentre: back to the start, the panels in front of you"),
    ("Snap turn", "a box on the transport strip: the right stick turns in 30° steps"),
];

/// The controls, as two columns: the control, and what it does. Each row splits the width there
/// is in two afresh and wraps its text inside its half. An egui `Grid` keeps last frame's column
/// widths to place this frame's, and a first frame laid out before the scroll area knows its
/// width left the guide's second column past the panel's edge. Under it, which controllers the
/// runtime says are in hand: the guide is written for the Index, and somebody holding anything
/// else is told what the runtime made of it.
fn controls_guide(ui: &mut egui::Ui, headset: &Headset) {
    for (control, action) in CONTROLS {
        ui.columns(2, |columns| {
            columns[0].add(egui::Label::new(egui::RichText::new(*control).strong()).wrap());
            columns[1].add(egui::Label::new(*action).wrap());
        });
    }
    note(ui, &controllers_text(headset));
}

/// Which controllers the runtime says are in hand, in a sentence.
fn controllers_text(headset: &Headset) -> String {
    let [left, right] = &headset.profiles;
    if left.is_empty() && right.is_empty() {
        return "The runtime has not said yet which controllers are in hand.".to_string();
    }
    let said = |profile: &str| if profile.is_empty() { "none".to_string() } else { profile.to_string() };
    let text = format!("Controllers: left {}, right {}.", said(left), said(right));
    // The simple profile is what a runtime falls back to for a controller none of the others
    // fits, and it has no stick: said, since walking and turning then do nothing and nothing
    // else would say why.
    if left == "khr/simple_controller" || right == "khr/simple_controller" {
        format!("{text} The simple profile has no stick: one button both grabs and presses, and there is no walking, turning or recentre.")
    } else {
        text
    }
}

/// The snap-turn box: the viewer's own, so it is never greyed with the run's controls when the
/// publisher is silent, and works with no publisher at all.
fn snap_turn_box(ui: &mut egui::Ui, headset: &Headset, local: &mut Option<LocalAction>) {
    if let Some(on) = checkbox(ui, headset.snap_turn, "Snap turn") {
        *local = Some(LocalAction::SnapTurn(on));
    }
}

impl Panel {
    pub fn new(kind: Kind) -> Self {
        let ctx = egui::Context::default();
        ctx.set_pixels_per_point(2.0);
        let mut visuals = egui::Visuals::dark();
        // Every label's colour. egui's dark theme gives text a grey of 140, which a note in a
        // colour of its own could not sit below and still be read.
        visuals.widgets.noninteractive.fg_stroke.color = BODY_TEXT;
        ctx.set_visuals(visuals);
        // A click, to egui, is a press that moves under six points before release. Six points
        // here is six millimetres, and a hand pulling a trigger moves more than that -- so nearly
        // every press was a drag and buttons hardly ever fired. Four centimetres of travel and
        // three seconds still make a click; a slider drags regardless.
        ctx.options_mut(|options| {
            options.input_options.max_click_dist = 40.0;
            options.input_options.max_click_duration = 3.0;
        });
        ctx.style_mut(|style| {
            for font in style.text_styles.values_mut() {
                font.size *= 1.3;
            }
            style.spacing.button_padding = egui::vec2(12.0, 8.0);
            style.spacing.item_spacing = egui::vec2(10.0, 9.0);
            style.spacing.slider_width = 240.0;
            style.spacing.interact_size.y = 28.0;
            // A bar that is always there and wide enough to take with a ray, for a controller
            // with no stick; egui's default floats, thin, and only while a mouse is over it.
            style.spacing.scroll = egui::style::ScrollStyle {
                bar_width: 16.0,
                ..egui::style::ScrollStyle::solid()
            };
            // A drag across a note scrolls the tab rather than selecting its words, which a
            // headset can do nothing with.
            style.interaction.selectable_labels = false;
        });
        Self {
            kind,
            ctx,
            started: std::time::Instant::now(),
            was_pressed: false,
            was_on: false,
            tab: Tab::Body,
            editing: None,
            last_live_send: 0.0,
            grabbed: false,
            scroll_id: None,
        }
    }

    /// Lay the panel out for this frame and say what to draw and what was asked.
    ///
    /// `liveness` is what is wrong with the publisher, if anything, and `status_error` why its
    /// newest status could not be read; both are said at the top of the panel. While the
    /// publisher is silent the controls are drawn but greyed: nothing pressed would be read.
    /// `dt` is the seconds since the last frame, which the pointer's scroll is a rate over.
    /// `headset` is what the viewer knows of itself, which the panels show whether or not a
    /// publisher is there.
    #[allow(clippy::too_many_arguments)]
    pub fn run(
        &mut self,
        status: Option<&Status>,
        pointer: Pointer,
        dt: f32,
        feeds: &str,
        liveness: Option<&crate::follow::Liveness>,
        status_error: Option<&str>,
        headset: &Headset,
    ) -> Frame {
        let size = self.kind.size();
        let mut events = Vec::new();
        match pointer.at {
            Some(at) => {
                events.push(egui::Event::PointerMoved(at));
                // A wheel under the pointer, as a mouse's would be, so it scrolls whichever area
                // the ray is on. egui's wheel runs the other way to a stick: a positive delta
                // brings the top into view, which is what pushing forward should do. egui takes
                // a step of eight points or more for a mouse wheel's notch and spreads it over
                // the next tenth of a second; a stick is smooth already, and spreading it again
                // left the tab coasting on after the stick was let go, further at 90 Hz than at
                // 144. So the frame's travel is given as steps under that size, which egui
                // applies at once.
                let travel = pointer.scroll * SCROLL_SPEED * dt;
                let steps = (travel.abs() / 7.5).ceil() as usize;
                for _ in 0..steps {
                    events.push(egui::Event::MouseWheel {
                        unit: egui::MouseWheelUnit::Point,
                        delta: egui::vec2(0.0, travel / steps as f32),
                        modifiers: egui::Modifiers::default(),
                    });
                }
                if pointer.pressed != self.was_pressed {
                    events.push(egui::Event::PointerButton {
                        pos: at,
                        button: egui::PointerButton::Primary,
                        pressed: pointer.pressed,
                        modifiers: egui::Modifiers::default(),
                    });
                }
                self.was_on = true;
            }
            None => {
                if self.was_on {
                    if self.was_pressed {
                        // A press that wanders off the panel is released, not left held.
                        events.push(egui::Event::PointerButton {
                            pos: egui::pos2(-1.0, -1.0),
                            button: egui::PointerButton::Primary,
                            pressed: false,
                            modifiers: egui::Modifiers::default(),
                        });
                    }
                    events.push(egui::Event::PointerGone);
                }
                self.was_on = false;
            }
        }
        self.was_pressed = pointer.pressed && pointer.at.is_some();

        let input = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(size[0], size[1]),
            )),
            time: Some(self.started.elapsed().as_secs_f64()),
            predicted_dt: 1.0 / 144.0,
            events,
            focused: true,
            ..Default::default()
        };

        let mut commands = Vec::new();
        let mut local = None;
        let mut tab = self.tab;
        let mut editing = Editing {
            current: self.editing.take(),
            on_panel: pointer.at.is_some(),
            last_live_send: self.last_live_send,
            now: self.started.elapsed().as_secs_f64(),
        };
        let kind = self.kind;
        let grabbed = self.grabbed;
        let mut scroll_id = self.scroll_id;
        let live = !matches!(liveness, Some(crate::follow::Liveness::Silent(_)));
        let output = self.ctx.run(input, |ctx| {
            egui::CentralPanel::default()
                .frame(
                    egui::Frame::none()
                        .fill(PANEL_FILL)
                        .inner_margin(egui::Margin::ZERO),
                )
                .show(ctx, |ui| {
                    ui.horizontal_top(|ui| {
                        grab_strip(ui, size[1], grabbed);
                        match kind {
                            Kind::Properties => {
                                tab_column(ui, &mut tab, size[1]);
                                ui.add_space(8.0);
                                ui.vertical(|ui| {
                                    // What is left of the row, so the column and the scroll bar
                                    // at its right lie on the panel. A width worked out from the
                                    // strip and the tabs had drifted past the edge, and the bar
                                    // with it, into the room where nothing could reach it.
                                    ui.set_width(ui.available_width());
                                    ui.add_space(14.0);
                                    let warned = warnings(ui, status.is_some(), liveness, status_error, false);
                                    // Each tab its own offset, as a tab page would have: the
                                    // Muscles tab scrolled down to its Spine does not open the
                                    // Body tab half-way down.
                                    let scrolled = egui::ScrollArea::vertical()
                                        .id_salt(tab)
                                        .max_height(size[1] - 60.0 - warned)
                                        .show(ui, |ui| match status {
                                            Some(s) => {
                                                ui.add_enabled_ui(live, |ui| {
                                                    properties(ui, tab, s, &mut editing, &mut commands, feeds, headset)
                                                });
                                            }
                                            None => waiting(ui, feeds, status_error, Some(headset)),
                                        });
                                    scroll_id = Some(scrolled.id);
                                    ui.with_layout(egui::Layout::bottom_up(egui::Align::LEFT), |ui| {
                                        note(ui, feeds);
                                    });
                                });
                            }
                            Kind::Transport => {
                                ui.add_space(10.0);
                                ui.vertical(|ui| {
                                    ui.set_width(size[0] - GRAB_WIDTH - 20.0);
                                    // The strip is 150 points tall and full without a warning;
                                    // one takes its line out of the margin above, not the
                                    // overlays below.
                                    let warned = status.is_some() && (liveness.is_some() || status_error.is_some());
                                    ui.add_space(if warned { 2.0 } else { 12.0 });
                                    warnings(ui, status.is_some(), liveness, status_error, true);
                                    match status {
                                        Some(s) => transport(ui, s, live, &mut editing, &mut commands, headset, &mut local),
                                        None => {
                                            waiting(ui, feeds, status_error, None);
                                            snap_turn_box(ui, headset, &mut local);
                                        }
                                    }
                                });
                            }
                        }
                    });
                });
        });
        self.tab = tab;
        self.scroll_id = scroll_id;
        self.editing = editing.current;
        self.last_live_send = editing.last_live_send;

        let meshes = self
            .ctx
            .tessellate(output.shapes, output.pixels_per_point)
            .into_iter()
            .filter_map(|primitive| match primitive.primitive {
                egui::epaint::Primitive::Mesh(mesh) => Some(Mesh {
                    texture: mesh.texture_id,
                    clip: primitive.clip_rect,
                    vertices: mesh.vertices,
                    indices: mesh.indices,
                }),
                egui::epaint::Primitive::Callback(_) => None,
            })
            .collect();
        Frame {
            meshes,
            textures: output.textures_delta,
            commands,
            local,
        }
    }
}

/// The strip a hand takes hold of: a darker band down the left edge with a row of dots, lit
/// while the panel is being carried.
fn grab_strip(ui: &mut egui::Ui, height: f32, grabbed: bool) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(GRAB_WIDTH, height), egui::Sense::hover());
    let painter = ui.painter();
    let fill = if grabbed {
        egui::Color32::from_rgb(70, 110, 160)
    } else {
        egui::Color32::from_rgb(34, 38, 46)
    };
    painter.rect_filled(rect, 0.0, fill);
    let dots = egui::Color32::from_rgb(140, 150, 165);
    let centre = rect.center();
    for row in -3..=3 {
        for column in [-1.0, 1.0] {
            painter.circle_filled(
                egui::pos2(centre.x + column * 6.0, centre.y + row as f32 * 14.0),
                2.5,
                dots,
            );
        }
    }
}

/// The tabs, down the left as the desktop's are, the developer's under their divider.
fn tab_column(ui: &mut egui::Ui, tab: &mut Tab, height: f32) {
    let mut tab_button = |ui: &mut egui::Ui, t: Tab, name: &str| {
        if ui
            .add_sized([96.0, 40.0], egui::SelectableLabel::new(*tab == t, name))
            .clicked()
        {
            *tab = t;
        }
    };
    egui::Frame::none()
        .fill(egui::Color32::from_rgb(24, 27, 33))
        .inner_margin(egui::Margin::symmetric(6.0, 12.0))
        .show(ui, |ui| {
            ui.set_height(height - 24.0);
            ui.set_width(98.0);
            ui.vertical(|ui| {
                ui.label(egui::RichText::new("bs-humany").strong());
                ui.add_space(8.0);
                for (t, name) in TABS {
                    tab_button(ui, t, name);
                }
                // A rule and a quiet word rather than a button: it is a heading over the tabs
                // below it, and a ray that lands on it changes nothing.
                ui.add_space(6.0);
                ui.separator();
                ui.label(egui::RichText::new("Developer").small().color(NOTE_TEXT));
                for (t, name) in DEVELOPER_TABS {
                    tab_button(ui, t, name);
                }
            });
        });
}

/// What a panel says with no publisher to show. The properties panel, which has the room, adds
/// the controls guide, given the headset to say which controllers are in hand: this is the first
/// thing someone who has just put the headset on sees, and nothing else in the room says what the
/// sticks and buttons do. The transport strip is 150 points tall and has no room for it.
fn waiting(ui: &mut egui::Ui, feeds: &str, status_error: Option<&str>, guide: Option<&Headset>) {
    ui.label("Waiting for the publisher: start a run in the studio, or run `pnpm publish:pose`.");
    if let Some(why) = status_error {
        unreadable(ui, why);
    }
    note(ui, feeds);
    if let Some(headset) = guide {
        heading(ui, "Controls");
        controls_guide(ui, headset);
    }
}

/// A status file that is there and cannot be read: a publisher and a viewer that disagree about
/// the contract, in serde's words, which name the field.
fn unreadable_text(ui: &egui::Ui, why: &str) -> egui::RichText {
    egui::RichText::new(format!("status unreadable: {why}")).color(ui.visuals().error_fg_color)
}

fn unreadable(ui: &mut egui::Ui, why: &str) {
    let text = unreadable_text(ui, why);
    ui.label(text);
}

/// What is wrong with the publisher, at the top of a panel that is showing a status: the
/// liveness in the theme's warning colour, an unreadable status in its error colour. Returns the
/// height it took, so the scrolled part below can give it back. The waiting view says the status
/// error itself, since it has no status to be above.
///
/// `one_line` is for the transport strip, which is 150 points tall and full without a warning:
/// both go on one line there, cut short if they must be, and the properties panel, which has
/// the room, says them whole.
fn warnings(
    ui: &mut egui::Ui,
    showing_status: bool,
    liveness: Option<&crate::follow::Liveness>,
    status_error: Option<&str>,
    one_line: bool,
) -> f32 {
    if !showing_status || (liveness.is_none() && status_error.is_none()) {
        return 0.0;
    }
    let texts: Vec<egui::RichText> = liveness
        .map(|l| egui::RichText::new(l.message()).strong().color(ui.visuals().warn_fg_color))
        .into_iter()
        .chain(status_error.map(|why| unreadable_text(ui, why)))
        .collect();
    let top = ui.cursor().top();
    if one_line {
        ui.horizontal(|ui| {
            for text in texts {
                ui.add(egui::Label::new(text).truncate());
            }
        });
    } else {
        for text in texts {
            ui.label(text);
        }
    }
    ui.cursor().top() - top
}

fn properties(
    ui: &mut egui::Ui,
    tab: Tab,
    s: &Status,
    editing: &mut Editing,
    commands: &mut Vec<Command>,
    feeds: &str,
    headset: &Headset,
) {
    match tab {
        Tab::Body => body_tab(ui, s, editing, commands),
        Tab::World => world_tab(ui, s, editing, commands),
        Tab::Sim => sim_tab(ui, s, editing, commands),
        Tab::Scene => scene_tab(ui, s, editing, commands),
        Tab::Muscles => muscles_tab(ui, s, editing, commands),
        Tab::Brain => brain_tab(ui, s, editing, commands),
        Tab::Training => training_tab(ui, s, editing, commands),
        Tab::Export => export_tab(ui),
        Tab::Health => health_tab(ui, s, feeds, headset),
    }
}

// --- The transport -----------------------------------------------------------------------------

/// What the transport strip's timeline and Play button say, from the status alone.
#[derive(Debug, PartialEq)]
struct TransportView {
    /// Where the timeline's handle sits: the playhead, in simulated seconds.
    value: f32,
    /// The timeline's end, in whole seconds.
    end: f32,
    /// The speed beside the mode, and whether the playhead is on the live edge.
    label: String,
    play_label: &'static str,
    /// What Play sends as `set('play', …)`: the state it asks for, not a toggle, so that a
    /// publisher which checks the value can ignore a press made on a status a quarter of a second
    /// old, rather than undo what the button said.
    play_sends: bool,
}

/// The timeline and Play as the desktop has them. The studio sends `simSeconds` as the time of
/// the frame it is showing -- the playhead, scrubbed back or replaying -- with how far its
/// recording reaches, whether it is playing that recording back and whether it is on the live
/// edge. The headless publisher and the showcase have no recording: their playhead is the run's
/// own time, as it always was, and Play is Play.
fn transport_view(s: &Status) -> TransportView {
    let playhead = s.sim_seconds;
    // The range grows in whole seconds, so the handle never sits on an end that moves under it,
    // and reaches the end of the recording rather than the playhead, so a scrubbed-back handle
    // is not at the end of a bar that stops where it is.
    let reach = s.recorded_seconds.unwrap_or(playhead).max(playhead);
    let playing = s.playing == Some(true);
    // The playhead's time is not repeated here: the timeline's own number says it, and the row
    // had room for it once but not twice once a long run's seconds ran to three figures.
    let mut label = if s.paused { "paused".to_string() } else { format!("{:.2}x life", s.speed) };
    if s.live == Some(true) {
        label.push_str(" · live");
    }
    TransportView {
        value: playhead as f32,
        end: (reach as f32).ceil().max(1.0),
        label,
        play_label: if playing { "Pause" } else { "Play" },
        play_sends: !playing,
    }
}

/// The transport strip with a publisher to show. `live` is whether the publisher is there to read
/// a press: the run's controls are greyed while it is silent, and the snap-turn box, which is the
/// viewer's own, is not.
fn transport(
    ui: &mut egui::Ui,
    s: &Status,
    live: bool,
    editing: &mut Editing,
    commands: &mut Vec<Command>,
    headset: &Headset,
    local: &mut Option<LocalAction>,
) {
    ui.add_enabled_ui(live, |ui| {
        run_row(ui, s, editing, commands);
        overlay_boxes(ui, s, commands);
    });
    // The overlay row is full, so the viewer's own box starts the line the hands' note has
    // always had, which is there whether or not a hand is holding anything now. A little shorter
    // than the panel's rows, which is what lets that line fit under both warnings at once: 24
    // points is still two and a half centimetres for a ray to find. Set around the row rather
    // than in it, because a row takes its height from its parent's spacing as it begins.
    ui.scope(|ui| {
        ui.spacing_mut().interact_size.y = 24.0;
        ui.horizontal(|ui| {
            snap_turn_box(ui, headset, local);
            if !s.holding.is_empty() {
                ui.separator();
                note(ui, &format!("Holding {}", s.holding.join(" and ")));
            }
        });
    });
}

/// The run's row: Start or Pause, Reset, the mode, Play and the frame buttons, and the timeline.
fn run_row(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    ui.horizontal(|ui| {
        // Seven buttons, the mode, the speed and the timeline share one row a metre wide. The
        // panel's padding either side of a button's text is trimmed here, where the row is full;
        // the buttons keep their height, which is what a ray has to find.
        ui.spacing_mut().button_padding.x = 8.0;
        let at_rest = s.mode == "rest";
        if s.paused {
            if ui.button(if at_rest { "▶ Start sim" } else { "▶ Resume" }).clicked() {
                commands.push(Command::Resume);
            }
        } else if ui.button("❚❚ Pause sim").clicked() {
            commands.push(Command::Pause);
        }
        if ui.button("↺ Reset").clicked() {
            commands.push(Command::Reset);
        }
        ui.add_space(10.0);
        let mode = match s.mode.as_str() {
            "following" => "Following the bridge",
            "running" => "Own run",
            "paused" => "Own run, paused",
            "rest" => "At rest",
            _ => {
                if s.paused {
                    "Paused"
                } else {
                    "Running"
                }
            }
        };
        ui.label(egui::RichText::new(mode).strong());
        let view = transport_view(s);
        ui.label(view.label);
        ui.add_space(10.0);
        if ui.button(view.play_label).clicked() {
            commands.push(set("play", view.play_sends));
        }
        if ui.button("◀").clicked() {
            commands.push(Command::Step(-1));
        }
        if ui.button("▶").clicked() {
            commands.push(Command::Step(1));
        }
        if ui.button("Live").clicked() {
            commands.push(set("live", true));
        }
        // What is left of the row, less the number and the unit after it, up to the 260 points it
        // had: a fixed 260 ran the number off the strip's right edge, out of reach of any ray,
        // and the Pause and the live mark the row now carries would have pushed it further.
        // The unit goes in the number's box rather than in a label after it, which, wrapped to a
        // sliver of row, stood its letter on a line of its own below the strip.
        ui.style_mut().spacing.slider_width = (ui.available_width() - 140.0).clamp(120.0, 260.0);
        let timeline = slider_shown(ui, editing, "timeline", "", view.value, 0.0..=view.end, true, |s| {
            s.fixed_decimals(2).suffix(" s")
        });
        if let Some(seconds) = timeline {
            commands.push(Command::Scrub(seconds as f64));
        }
    });
}

/// The overlay boxes: the three the headset draws, then the five only the desktop does.
///
/// Muscle paths are the desktop's: the lines it draws from origin to insertion. What the headset
/// draws of the muscles is their volumes, the tubes swept from the belly rings, so those follow
/// the Muscle volumes box alone -- they used to follow either box, and a desktop showing paths
/// with volumes off still got tubes in the headset.
fn overlay_boxes(ui: &mut egui::Ui, s: &Status, commands: &mut Vec<Command>) {
    ui.horizontal_wrapped(|ui| {
        // A little closer than the panel's spacing: the eight boxes and their heading only just
        // fill the strip's width, and a second line would push the row below it off the strip.
        ui.spacing_mut().item_spacing.x = 6.0;
        // Each box as the publisher last said it, or, from one that says nothing, as a fresh
        // studio starts: the three drawn here and the desktop's muscle paths on, the rest off.
        let shown = |name: &str, fresh: bool| s.overlays.get(name).copied().unwrap_or(fresh);
        for (name, label) in [
            ("grid", "Grid"),
            ("muscleVolumes", "Muscle volumes"),
            ("tissue", "Connective tissue"),
        ] {
            if let Some(v) = checkbox(ui, shown(name, true), label) {
                commands.push(set(&format!("overlay.{name}"), v));
            }
        }
        ui.separator();
        // A heading and not a note: it names the boxes after it, which a dim note beside bright
        // checkboxes did not read as doing.
        heading(ui, "Desktop view:");
        for (name, label, fresh) in [
            ("muscles", "Muscle paths", true),
            ("proxies", "Proxies", false),
            ("axes", "Axes", false),
            ("com", "Centres of mass", false),
            ("contacts", "Contacts", false),
        ] {
            if let Some(v) = checkbox(ui, shown(name, fresh), label) {
                commands.push(set(&format!("overlay.{name}"), v));
            }
        }
    });
}

// --- The properties tabs ------------------------------------------------------------------------

fn body_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    let st = &s.settings;
    heading(ui, "Who");
    let rows: [(&str, &str, f64); 4] = [
        ("sex", "skeletal proportions, 0 F .. 1 M", st.sex),
        ("stature", "stature m", st.stature),
        ("mass", "body mass kg", st.mass),
        ("percentile", "ANSUR II percentile", st.percentile),
    ];
    for (key, label, value) in rows {
        if let Some(v) = slider(ui, editing, s, key, label, value, false) {
            commands.push(set(key, v));
        }
    }
    // The desktop's notes, said as it says them: what the proportions slider changes today, and
    // that the percentile follows the body rather than only setting it.
    note(ui, "Skeletal proportions change the segment mass distribution (de Leva) and the ANSUR stature and mass behind the percentile; not bone shape or placement yet.");
    note(ui, "The percentile sets stature and mass together from the distribution for the current blend, and reads back where the current stature sits. Each change rebuilds the body.");
    // The crural and brachial indices and the relative leg length had sliders here that sent
    // keys the body never used: the measured skeleton is one subject scaled by stature. The
    // desktop greys its own out; here, where a slider is one more thing to aim past, they are
    // gone, and the values the desktop's greyed sliders show are said with the reason.
    heading(ui, "Proportions");
    note(
        ui,
        &format!(
            "Crural index {:.2}, brachial index {:.2}, relative leg length {:.2}: not applied yet. The measured skeleton is one subject scaled by stature; per-segment lengths need landmark-derived joint frames.",
            st.crural, st.brachial, st.leg_length
        ),
    );
    heading(ui, "Inspector");
    ui.label(if s.holding.is_empty() {
        "Squeeze a controller on a bone to grab it.".to_string()
    } else {
        format!("Holding {}", s.holding.join(" and "))
    });
    note(ui, "The bone inspector is on the desktop: click a bone there.");
}

fn world_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    let st = &s.settings;
    heading(ui, "Forces");
    if let Some(v) = checkbox(ui, st.gravity, "Gravity") {
        commands.push(set("gravity", v));
    }
    if let Some(v) = checkbox(ui, st.floor, "Floor collision") {
        commands.push(set("floor", v));
    }
    heading(ui, "Tissues");
    if let Some(v) = checkbox(ui, st.passive, "Passive joint resistance") {
        commands.push(set("passive", v));
    }
    if let Some(v) = checkbox(ui, st.redistribute, "Spinal redistribution") {
        commands.push(set("redistribute", v));
    }
    note(ui, "The discs and the costal cartilage are part of the skeleton and have no switch; the Connective tissue overlay shows them. These two take effect on the next run.");
    heading(ui, "Start pose");
    // Only a publisher with a free drop sends one. The headless publisher always runs a scenario,
    // and a slider there would read 0 and move nothing, so it says where the start pose is set.
    if let Some(height) = st.drop_height {
        if let Some(v) = slider(ui, editing, s, "dropHeight", "drop height m", height, false) {
            commands.push(set("dropHeight", v));
        }
        note(ui, "For a free drop only; a scenario places the body itself.");
    } else {
        note(ui, "The scenario places the body; its own parameters are under Scene.");
    }
    heading(ui, "The hand");
    if let Some(v) = slider(ui, editing, s, "grabStrength", "grab strength", s.grab_strength, true) {
        commands.push(set("grabStrength", v));
    }
    note(ui, "Squeeze a controller on a bone to pull the body about. At 1x a hold carries a good fraction of the body's weight.");
}

fn sim_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    let st = &s.settings;
    heading(ui, "Time");
    if let Some(v) = slider(ui, editing, s, "stepsPerSecond", "simulation steps / s", st.steps_per_second, false) {
        commands.push(set("stepsPerSecond", v));
    }
    if let Some(v) = slider(ui, editing, s, "fps", "output frames / s", st.fps, false) {
        commands.push(set("fps", v));
    }
    note(ui, "A second of simulated time is a second of the timeline, always. Changing the step rate starts a new run.");
    heading(ui, "Recording");
    note(ui, "The capture budget is set on the desktop.");
    heading(ui, "Run");
    let d = &s.diagnostics;
    egui::Grid::new("diagnostics").num_columns(2).show(ui, |ui| {
        ui.label("Kinetic");
        ui.label(format!("{:.1} J", d.kinetic));
        ui.end_row();
        ui.label("Potential");
        ui.label(format!("{:.1} J", d.potential));
        ui.end_row();
        ui.label("Joint drift");
        ui.label(format!("{:.1} mm", d.drift_mm));
        ui.end_row();
        ui.label("Nearest stop");
        ui.label(if d.violations > 0.0 {
            format!("{} past a stop", d.violations as i64)
        } else {
            format!("{}% of range", (d.limits_worst * 100.0).round() as i64)
        });
        ui.end_row();
        ui.label("Contacts");
        ui.label(format!("{}", d.contacts as i64));
        ui.end_row();
        ui.label("Tick rate");
        ui.label(tick_rate_text(s));
        ui.end_row();
        ui.label("Cost / tick");
        ui.label(format!("{:.3} ms", d.cost_ms));
        ui.end_row();
    });
}

/// The Sim tab's tick rate, as the desktop's Run readout says it: how fast steps are coming out
/// against how finely a second is divided, and so how fast against life. The status's speed is
/// simulated seconds a wall second, which is that ratio already.
fn tick_rate_text(s: &Status) -> String {
    let declared = s.settings.steps_per_second;
    if s.paused {
        format!("{declared:.0} Hz steps · paused")
    } else if s.speed > 0.0 {
        format!("{:.0} Hz of {declared:.0} steps · {:.2}x life", s.speed * declared, s.speed)
    } else {
        format!("{declared:.0} Hz steps")
    }
}

fn scene_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    heading(ui, "Scenario");
    ui.horizontal_wrapped(|ui| {
        for candidate in &s.scenarios {
            let current = candidate.id == s.scenario.id;
            if ui.selectable_label(current, &candidate.title).clicked() && !current {
                commands.push(set("scenario", candidate.id.clone()));
            }
        }
    });
    if let Some(description) = scenario_description(s) {
        note(ui, description);
    }
    for p in &s.scenario_parameters {
        // Trimmed, because the studio's units are readout suffixes with their own leading space
        // (` m`), and a label that adds one of its own showed two.
        let unit = p.unit.trim();
        let label = if unit.is_empty() { p.title.clone() } else { format!("{} {unit}", p.title) };
        let key = format!("scenario.{}", p.id);
        let range = ControlRange { min: p.min, max: p.max, step: p.step };
        if let Some(v) = slider_in(ui, editing, &key, &label, p.value, range, false) {
            commands.push(set(&key, v));
        }
    }
    if let Some(v) = checkbox(ui, s.settings.muscles, "Muscles") {
        commands.push(set("muscles", v));
    }
    note(ui, "A scenario that needs muscles turns them on itself. Muscles start with the next run.");
    heading(ui, "Body");
    // By the desktop picker's names, sending the ids a `set profile` takes.
    ui.horizontal_wrapped(|ui| {
        for profile in &s.profiles {
            let current = profile.id() == s.profile;
            if ui.selectable_label(current, profile.title()).clicked() && !current {
                commands.push(set("profile", profile.id()));
            }
        }
    });
    note(ui, "Rebuilds the body; the bridges reopen.");
}

/// What the chosen scenario is, as the desktop's note under its picker says it, when the
/// publisher sent it: the sliders under the picker mean little without it.
fn scenario_description(s: &Status) -> Option<&str> {
    s.scenarios
        .iter()
        .find(|candidate| candidate.id == s.scenario.id)
        .map(|candidate| candidate.description.as_str())
        .filter(|description| !description.is_empty())
}

/// The excitation a drive slider at `position` (0..100) asks of its muscles, as a fraction: the
/// square of its travel. `driveForSlider` in packages/scenarios/src/muscleGroups.ts is the rule
/// the publisher applies to what is sent, and the one this must agree with; the square gives the
/// low end of the slider the fine control that a muscle's weak, postural range needs.
fn drive_excitation(position: f64) -> f64 {
    (position / 100.0).powi(2)
}

/// A drive slider's number, as the desktop prints it: the excitation as a percentage, whole above
/// one per cent and to a tenth below it, so that a slider nudged off zero does not read 0%.
fn excitation_text(position: f64) -> String {
    let percent = drive_excitation(position) * 100.0;
    if percent > 0.0 && percent < 1.0 {
        format!("{percent:.1}%")
    } else {
        // Halves up, as the desktop's Math.round does; `{:.0}` would take them to even.
        format!("{}%", percent.round() as i64)
    }
}

/// A number typed into a drive slider, read as the excitation it shows, back to the position that
/// asks for it.
fn position_from_excitation_text(text: &str) -> Option<f64> {
    let percent: f64 = text.trim().trim_end_matches('%').trim().parse().ok()?;
    if !percent.is_finite() || percent < 0.0 {
        return None;
    }
    Some((percent / 100.0).sqrt() * 100.0)
}

/// The Muscles tab's readout rows, by the key the publisher sends each under: the five body
/// sections the drive groups fall into, in the order the desktop lists them, then the three
/// counts. The elbow and knee rows this used to show covered four groups of thirty-five.
const MUSCLE_READOUT_ROWS: [(&str, &str); 8] = [
    ("section.arm", "Arm"),
    ("section.hand", "Hand"),
    ("section.leg", "Leg"),
    ("section.trunk", "Trunk"),
    ("section.neck", "Neck"),
    ("loaded", "Loaded"),
    ("wrapping", "Wrapping"),
    ("strained", "Out of range"),
];

fn muscles_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    if s.muscles {
        drive_and_readout(ui, s, editing, commands);
    } else {
        ui.label("Muscles are off for this run. Turn them on under Scene.");
    }
    // The cord stays with muscles off, as it does on the desktop: its gains are the next run's,
    // and one set now is the cord that run starts with once muscles are back on.
    spine(ui, s, editing, commands);
}

/// The Muscles tab's drive sliders and what they are pulling with, for a run that has muscles.
fn drive_and_readout(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    heading(ui, "Drive");
    // One collapsed section a region, as the desktop has them; a group with no section named
    // goes under the one before it, so an older publisher still shows every slider.
    ui.style_mut().spacing.slider_width = 200.0;
    let mut sections: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, group) in s.drive_groups.iter().enumerate() {
        let name = if group.section.is_empty() { "Groups".to_string() } else { group.section.clone() };
        match sections.iter_mut().find(|(n, _)| *n == name) {
            Some((_, members)) => members.push(i),
            None => sections.push((name, vec![i])),
        }
    }
    for (name, members) in sections {
        egui::CollapsingHeader::new(&name).default_open(false).show(ui, |ui| {
            for i in members {
                let group = &s.drive_groups[i];
                let key = format!("drive{i}");
                // The number beside it is the excitation, as the desktop's is; what is sent is
                // still the slider's position, which the publisher squares.
                let sent = slider_shown(ui, editing, &key, &group.title, group.level as f32, 0.0..=100.0, true, |s| {
                    s.custom_formatter(|position, _| excitation_text(position))
                        .custom_parser(position_from_excitation_text)
                });
                if let Some(v) = sent {
                    commands.push(Command::Drive(i, v));
                }
            }
        });
    }
    note(ui, "Each slider drives its muscles on both sides at once; the number is the excitation, the square of the slider's travel.");
    heading(ui, "Readout");
    note(ui, "Tendon force summed over every drive group in each body section, both sides.");
    egui::Grid::new("muscle-readout").num_columns(2).show(ui, |ui| {
        for (key, label) in MUSCLE_READOUT_ROWS {
            ui.label(label);
            ui.label(s.muscle_readout.get(key).cloned().unwrap_or_else(|| "—".to_string()));
            ui.end_row();
        }
    });
}

/// A button on the Brain tab: its label, whether the desktop says it would do anything now, and
/// the action it sends.
struct BrainButton {
    label: &'static str,
    enabled: bool,
    action: &'static str,
}

/// The Brain tab's two rows of policy buttons, from the desktop's own flags: setting the tabs up
/// as the chosen checkpoint was trained and taking that back, then handing over and releasing.
///
/// Choosing a checkpoint in the list only shows it, on the desktop and here. The desktop's list
/// used to set its tabs up from the checkpoint's recipe as it was chosen, restarting a running
/// body, and the headset's list did the same through it; the change is these buttons' now. Hand
/// over sets the tabs up first when they differ, so it can restart the run too, and the desktop's
/// note under the list says what would change.
fn brain_buttons(b: &Brain) -> [[BrainButton; 2]; 2] {
    [
        [
            BrainButton { label: "Set up as trained", enabled: b.can_set_up, action: "setup" },
            BrainButton { label: "Undo set-up", enabled: b.can_undo_set_up, action: "undoSetup" },
        ],
        [
            BrainButton { label: "Hand over control", enabled: b.can_hand_over, action: "handover" },
            BrainButton { label: "Release", enabled: b.can_release, action: "release" },
        ],
    ]
}

/// One row of them, sending what is pressed.
fn brain_button_row(ui: &mut egui::Ui, row: &[BrainButton; 2], commands: &mut Vec<Command>) {
    ui.horizontal(|ui| {
        for button in row {
            if ui.add_enabled(button.enabled, egui::Button::new(button.label)).clicked() {
                commands.push(Command::Brain { action: button.action, id: None, value: None });
            }
        }
    });
}

fn brain_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    let b = &s.brain;
    heading(ui, "Policy in the loop");
    ui.label("Checkpoint");
    ui.horizontal_wrapped(|ui| {
        if ui.selectable_label(b.selected.is_empty(), "None").clicked() && !b.selected.is_empty() {
            commands.push(Command::Brain { action: "select", id: Some(String::new()), value: None });
        }
        for checkpoint in &b.checkpoints {
            let current = checkpoint.id == b.selected;
            if ui.selectable_label(current, &checkpoint.name).clicked() && !current {
                commands.push(Command::Brain { action: "select", id: Some(checkpoint.id.clone()), value: None });
            }
        }
    });
    // The desktop's own note, said here as it says it there, and under the list as it is there:
    // with a checkpoint chosen, how it was trained and what Set up as trained would change, which
    // is what somebody choosing one wants to read before pressing anything. This used to be a note
    // of the headset's own sending everyone to a terminal whenever no dashboard was running, which
    // had stopped being true: the desktop lists what it trained and shipped without one.
    if !b.policy_note.is_empty() {
        note(ui, &b.policy_note);
    }
    // Every button on this tab is enabled exactly when the desktop's is, from the flags it sends:
    // the rules live in one place on the desktop, and a copy of them kept here drifted from it.
    let [set_up, hand_over] = brain_buttons(b);
    brain_button_row(ui, &set_up, commands);
    if let Some(v) = slider(ui, editing, s, "brain.authority", "authority", b.authority, false) {
        commands.push(Command::Brain { action: "authority", id: None, value: Some(v) });
    }
    note(ui, "The most one output may add to or take from a group's excitation.");
    brain_button_row(ui, &hand_over, commands);
    if !b.fit.is_empty() {
        note(ui, &b.fit);
    }
    heading(ui, "Activity");
    note(ui, if b.active { "The policy is in the loop; its activity bitmap is on the desktop." } else { "No policy in the loop." });
}

/// The Muscles tab's Spine: the cord, under whatever drives the muscles. It was the Brain tab's
/// until the desktop moved it to Muscles, and it moved here with it.
fn spine(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    // The cord, under whatever the brain is doing. The same five gains the desktop offers, with
    // the same keys, because a person in the headset is setting the same body up.
    heading(ui, "Spine");
    note(ui, "The reflexes: a muscle pulled past its set point excites itself and inhibits its opposite. Needs no training, and it is most of what holds a body up. Stretch and Damping at zero is a body with no reflexes at all.");
    let b = &s.brain;
    let r = &b.reflex;
    for (key, label, value, action) in [
        ("spine.stretch", "stretch", r.stretch, "reflexStretch"),
        ("spine.velocity", "damping", r.velocity, "reflexVelocity"),
        ("spine.setPoint", "set point", r.set_point, "reflexSetPoint"),
        ("spine.inhibition", "reciprocal", r.inhibition, "reflexInhibition"),
        ("spine.delay", "conduction s", r.delay_seconds, "reflexDelay"),
    ] {
        if let Some(v) = slider(ui, editing, s, key, label, value, false) {
            commands.push(Command::Brain { action, id: None, value: Some(v) });
        }
    }
    // What depends on the cord's setting and on what has been measured of it comes from the
    // desktop, which is the one place it is kept. The measured table that used to be copied here
    // went stale with every change to the cord; it lives in docs/validation/reflex-gains.md.
    note(ui, "Stretch is a strain: 0.1 is a fibre a tenth longer than optimal.");
    if !b.spine_note.is_empty() {
        note(ui, &b.spine_note);
    }
}

/// The Training tab: training a checkpoint on the desktop's machine, and following one being
/// trained. It was the foot of the Brain tab until the desktop gave it a tab of its own.
fn training_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    let b = &s.brain;
    heading(ui, "Training");
    note(ui, "Generations, population, episode seconds and workers are as set on the desktop.");
    if let Some(v) = slider(ui, editing, s, "train.memory", "memory", b.memory as f64, false) {
        commands.push(Command::Brain { action: "memory", id: None, value: Some(v) });
    }
    note(ui, if b.memory == 0 {
        "No memory: the policy answers the instant it is shown and nothing else."
    } else {
        "Context the policy carries from one control step to the next, fed back from its own last answer."
    });
    ui.horizontal_wrapped(|ui| {
        // Start trains in the desktop's own window when it has no server, so it is the desktop's
        // flag that says whether it can, not whether a server is up.
        if ui.add_enabled(b.can_start, egui::Button::new("Start training")).clicked() {
            commands.push(Command::Brain { action: "trainStart", id: None, value: None });
        }
        // The desktop's rule includes the showcase, which outlives the trainer and which the
        // studio goes on following until it is stopped, and a run in the desktop's own window.
        if ui.add_enabled(b.can_stop, egui::Button::new("Stop training")).clicked() {
            commands.push(Command::Brain { action: "trainStop", id: None, value: None });
        }
        // The one button says which way it goes, because the headset has no other way to stop.
        let follow = if b.following { "Stop following" } else { "Follow bridge" };
        if ui.button(follow).clicked() {
            commands.push(Command::Brain { action: "follow", id: None, value: None });
        }
    });
    if !b.training.is_empty() {
        note(ui, &b.training);
    }
    if let Some(t) = &s.training {
        note(ui, &format!(
            "showcase: {} episode {} of generation {}, fitness {:.3}",
            t.task, t.episode, t.generation, t.fitness
        ));
    }
}

fn export_tab(ui: &mut egui::Ui) {
    heading(ui, "Recording");
    ui.horizontal(|ui| {
        ui.add_enabled(false, egui::Button::new("Export recording"));
        ui.add_enabled(false, egui::Button::new("Export for Blender"));
    });
    note(ui, "Exports need a file dialog, which a headset has not got: take the headset off and press these on the desktop. The recording is the same one.");
    heading(ui, "Session");
    note(ui, "Save and Load are on the desktop's top bar.");
}

fn health_tab(ui: &mut egui::Ui, s: &Status, feeds: &str, headset: &Headset) {
    heading(ui, "Compile report");
    note(ui, "The compile report, the inertia audit and the joint sweep are on the desktop's Health tab.");
    heading(ui, "This run");
    ui.label(format!(
        "{} on {}, {} steps / s, {} fps out",
        if s.muscles { "muscles" } else { "bones only" },
        s.profile_title(),
        s.settings.steps_per_second,
        s.settings.fps
    ));
    // The energies, the drift and the contacts were said here a second time; they are the Sim
    // tab's Run readout, as they are on the desktop.
    note(ui, "Energy, drift, contacts and the tick rate are under Sim.");
    heading(ui, "The bridge");
    ui.label(feeds);
    // The guide the waiting view shows, kept here for once a publisher is running and the
    // waiting view has gone: a tab of its own would be one the desktop has not got.
    heading(ui, "Controls");
    controls_guide(ui, headset);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ray_from_the_viewer_lands_where_it_points() {
        // A panel centred half a metre up and a metre ahead, facing the origin. A ray from the
        // origin straight at its centre hits the middle point; one at its top-left corner hits
        // (0, 0), which is on the grab strip; one pointing away misses.
        let size = Kind::Properties.size();
        let panel = Placement::facing(size, [0.0, 0.5, -1.0], [0.0, 0.5, 0.0]);
        let Some((t, Hit::Face(centre))) = panel.hit([0.0, 0.5, 0.0], [0.0, 0.0, -1.0]) else {
            panic!("misses the face");
        };
        assert!((centre.x - size[0] / 2.0).abs() < 1e-3 && (centre.y - size[1] / 2.0).abs() < 1e-3);
        // A metre along a unit ray: the distance, so the nearer of two panels can be told.
        assert!((t - 1.0).abs() < 1e-5, "{t}");
        let corner = panel.to_world(egui::pos2(0.0, 0.0));
        let Some((_, Hit::Grab(back))) = panel.hit([0.0, 0.5, 0.0], [corner[0], corner[1] - 0.5, corner[2]]) else {
            panic!("misses the strip");
        };
        assert!(back.x.abs() < 1e-3 && back.y.abs() < 1e-3, "{back:?}");
        assert!(panel.hit([0.0, 0.5, 0.0], [0.0, 0.0, 1.0]).is_none());
        // Points map through the model matrix to the same place `to_world` says.
        let m = panel.model();
        let p = egui::pos2(100.0, 50.0);
        let via_model = [
            m[0] * p.x + m[4] * p.y + m[12],
            m[1] * p.x + m[5] * p.y + m[13],
            m[2] * p.x + m[6] * p.y + m[14],
        ];
        let direct = panel.to_world(p);
        for axis in 0..3 {
            assert!((via_model[axis] - direct[axis]).abs() < 1e-6);
        }
        // The viewer's right is the panel's right: x grows toward +X for a panel ahead.
        assert!(panel.right[0] > 0.99, "{:?}", panel.right);
    }

    #[test]
    fn a_carried_panel_goes_where_the_hand_goes() {
        let size = Kind::Transport.size();
        let panel = Placement::facing(size, [0.0, 1.0, -1.0], [0.0, 1.0, 0.0]);
        let hand_at = [0.3, 0.9, -0.6];
        let hand_q = [0.0, 0.0, 0.0, 1.0];
        let held = panel.held_by(hand_at, hand_q);
        // The hand where it was: the panel where it was.
        let same = panel.carried(&held, hand_at, hand_q);
        for axis in 0..3 {
            assert!((same.origin[axis] - panel.origin[axis]).abs() < 1e-6);
        }
        // The hand moved half a metre up: so did the panel, unturned.
        let moved = panel.carried(&held, [0.3, 1.4, -0.6], hand_q);
        assert!((moved.origin[1] - panel.origin[1] - 0.5).abs() < 1e-6);
        assert!((moved.right[0] - panel.right[0]).abs() < 1e-6);
        // The hand turned a quarter about Y: the panel's normal turned with it.
        let quarter = [0.0, std::f32::consts::FRAC_1_SQRT_2, 0.0, std::f32::consts::FRAC_1_SQRT_2];
        let turned = panel.carried(&held, hand_at, quarter);
        assert!(turned.normal[0].abs() > 0.99, "{:?}", turned.normal);
    }

    #[test]
    fn the_transport_strip_has_room_for_a_warning() {
        // The strip is a fixed 150 points. Both warnings at once, with the 2-point margin `run`
        // leaves above them, must not push the overlays off its bottom, even with a hand holding
        // something, which adds a line of its own. Laid out as `run` lays the strip out, without
        // the grab strip beside it, which takes width and not height.
        let status: Status = serde_json::from_str(
            r#"{"generation":1,"scenario":{"id":"a","title":"A"},"scenarios":[],
            "profile":"l1_standard","simSeconds":12.5,"speed":1,"paused":false,"muscles":true,
            "holding":["femur_r"],"grabStrength":1}"#,
        )
        .expect("parses");
        let silent = crate::follow::Liveness::Silent(4);
        let panel = Panel::new(Kind::Transport);
        let size = Kind::Transport.size();
        let mut used = 0.0;
        let input = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(size[0], size[1]),
            )),
            ..Default::default()
        };
        let _ = panel.ctx.run(input, |ctx| {
            egui::CentralPanel::default().frame(egui::Frame::none()).show(ctx, |ui| {
                let content = ui.vertical(|ui| {
                    ui.set_width(size[0] - GRAB_WIDTH - 20.0);
                    let mut editing = Editing {
                        current: None,
                        on_panel: false,
                        last_live_send: 0.0,
                        now: 0.0,
                    };
                    let mut commands = Vec::new();
                    let why = "invalid type: null, expected u64 at line 1 column 18";
                    ui.add_space(2.0);
                    warnings(ui, true, Some(&silent), Some(why), true);
                    // Silent, so the run's controls are greyed; the snap-turn box is not.
                    transport(ui, &status, false, &mut editing, &mut commands, &Headset::default(), &mut None);
                });
                used = content.response.rect.height();
            });
        });
        assert!(used <= size[1], "{used} points of content in a {} point strip", size[1]);
    }

    #[test]
    fn the_chosen_scenario_is_described_under_the_picker_when_the_publisher_says_what_it_is() {
        let status = crate::bridge::parse_status(include_str!("../fixtures/status.json")).expect("parses");
        assert_eq!(
            scenario_description(&status),
            Some("The rest pose dropped onto the ground with nothing holding it up.")
        );
        // An older publisher, or a scenario the list does not carry, says nothing rather than
        // showing another scenario's note.
        let mut older = status.clone();
        older.scenarios.iter_mut().for_each(|c| c.description.clear());
        assert_eq!(scenario_description(&older), None);
        let mut elsewhere = status;
        elsewhere.scenario.id = "not-listed".into();
        assert_eq!(scenario_description(&elsewhere), None);
    }

    #[test]
    fn commands_are_the_lines_the_publisher_reads() {
        assert_eq!(Command::Pause.to_json(), r#"{"kind":"pause"}"#);
        assert_eq!(
            set("scenario", "drop-supine").to_json(),
            r#"{"key":"scenario","kind":"set","value":"drop-supine"}"#
        );
        assert_eq!(
            set("overlay.tissue", false).to_json(),
            r#"{"key":"overlay.tissue","kind":"set","value":false}"#
        );
        assert_eq!(Command::Drive(3, 40.0).to_json(), r#"{"kind":"drive","group":3,"value":40}"#);
        assert_eq!(Command::Step(-1).to_json(), r#"{"kind":"step","frames":-1}"#);
        assert_eq!(
            Command::Brain { action: "handover", id: Some("stand-3".into()), value: None }.to_json(),
            r#"{"action":"handover","id":"stand-3","kind":"brain"}"#
        );
        assert_eq!(
            Command::Brain { action: "authority", id: None, value: Some(0.5) }.to_json(),
            r#"{"action":"authority","kind":"brain","value":0.5}"#
        );
    }

    #[test]
    fn a_ray_off_the_edge_projects_onto_the_face_held_to_its_edges() {
        // A panel a metre ahead, facing the origin, and rays from the origin to points in its
        // plane beyond each edge. Each lands on the face's edge it went past; the one past the
        // left edge stops at the strip's inner side, never on the strip.
        let size = Kind::Properties.size();
        let panel = Placement::facing(size, [0.0, 1.2, -1.0], [0.0, 1.2, 0.0]);
        let from = [0.0, 1.2, 0.0];
        let towards = |p: egui::Pos2| {
            let w = panel.to_world(p);
            [w[0] - from[0], w[1] - from[1], w[2] - from[2]]
        };
        let cases = [
            (egui::pos2(-200.0, 300.0), egui::pos2(GRAB_WIDTH, 300.0)),
            (egui::pos2(size[0] + 200.0, 300.0), egui::pos2(size[0], 300.0)),
            (egui::pos2(300.0, -150.0), egui::pos2(300.0, 0.0)),
            (egui::pos2(300.0, size[1] + 150.0), egui::pos2(300.0, size[1])),
            (egui::pos2(10.0, 300.0), egui::pos2(GRAB_WIDTH, 300.0)),
            (egui::pos2(250.0, 400.0), egui::pos2(250.0, 400.0)),
        ];
        for (aimed, lands) in cases {
            let at = panel.project(from, towards(aimed)).expect("the plane is ahead");
            assert!((at - lands).length() < 1e-2, "aimed at {aimed:?}, landed at {at:?}");
        }
        // Past the edge the ray misses the panel itself, which is why a press needs this.
        assert!(panel.hit(from, towards(egui::pos2(size[0] + 200.0, 300.0))).is_none());
        // A panel behind the ray has nowhere to project to.
        assert!(panel.project(from, [0.0, 0.0, 1.0]).is_none());
    }

    fn fixture() -> Status {
        crate::bridge::parse_status(include_str!("../fixtures/status.json")).expect("parses")
    }

    /// One headset frame of a panel, with the pointer where it is and the frame's commands.
    fn step(panel: &mut Panel, status: &Status, at: Option<egui::Pos2>, pressed: bool, scroll: f32) -> Frame {
        panel.run(Some(status), Pointer { at, pressed, scroll }, 1.0 / 90.0, "feeds", None, None, &Headset::default())
    }

    fn stature_sent(commands: &[Command]) -> Option<f64> {
        commands.iter().find_map(|c| match c {
            Command::Set(key, value) if key == "stature" => value.as_f64(),
            _ => None,
        })
    }

    #[test]
    fn a_drag_whose_ray_is_lost_still_sends_the_value_it_reached() {
        let status = fixture();
        let mut panel = Panel::new(Kind::Properties);
        // Where the stature slider is, found as a person would: by clicking down the Body
        // tab's slider column until a click sets stature.
        let column = 230.0;
        let row = (40..400)
            .step_by(3)
            .map(|y| egui::pos2(column, y as f32))
            .find(|at| {
                step(&mut panel, &status, Some(*at), false, 0.0);
                step(&mut panel, &status, Some(*at), true, 0.0);
                let clicked = step(&mut panel, &status, Some(*at), false, 0.0);
                stature_sent(&clicked.commands).is_some()
            })
            .expect("a stature slider on the Body tab")
            .y;

        let mut panel = Panel::new(Kind::Properties);
        let mut sent = Vec::new();
        step(&mut panel, &status, Some(egui::pos2(column, row)), false, 0.0);
        sent.extend(step(&mut panel, &status, Some(egui::pos2(column, row)), true, 0.0).commands);
        for x in [260.0, 300.0, 340.0] {
            sent.extend(step(&mut panel, &status, Some(egui::pos2(x, row)), true, 0.0).commands);
        }
        // Stature rebuilds the body, so nothing is sent while it is dragged.
        assert_eq!(stature_sent(&sent), None, "{sent:?}");
        // The ray is lost with the trigger still down: the panel is let go of there and then.
        let last = step(&mut panel, &status, None, false, 0.0);
        let value = stature_sent(&last.commands).expect("the drag's value is sent when the ray is lost");
        // Dragged right from the press, so taller than where the press put it, and nowhere
        // near the slider's minimum, which is where the release itself was put.
        let pressed = {
            let mut fresh = Panel::new(Kind::Properties);
            step(&mut fresh, &status, Some(egui::pos2(column, row)), false, 0.0);
            step(&mut fresh, &status, Some(egui::pos2(column, row)), true, 0.0);
            let up = step(&mut fresh, &status, Some(egui::pos2(column, row)), false, 0.0);
            stature_sent(&up.commands).expect("a click sends")
        };
        assert!(value > pressed + 0.05, "sent {value}, pressed at {pressed}");
        assert!(value < 2.05 + 1e-6);
    }

    /// Where the Body tab's stature slider is, found as a person would: by clicking down its
    /// slider column until a click sets stature. None when no click does.
    fn stature_row(status: &Status, column: f32) -> Option<f32> {
        let mut panel = Panel::new(Kind::Properties);
        (40..400).step_by(3).map(|y| y as f32).find(|&y| {
            let at = egui::pos2(column, y);
            step(&mut panel, status, Some(at), false, 0.0);
            step(&mut panel, status, Some(at), true, 0.0);
            let clicked = step(&mut panel, status, Some(at), false, 0.0);
            stature_sent(&clicked.commands).is_some()
        })
    }

    #[test]
    fn a_dragged_slider_moves_in_the_tables_steps_and_sends_what_the_desktop_would_hold() {
        let status = fixture();
        let range = status.controls["stature"];
        assert_eq!((range.min, range.max, range.step), (1.4, 2.05, 0.005), "the table's stature");
        let column = 230.0;
        let row = stature_row(&status, column).expect("a stature slider on the Body tab");
        // Dragged a little at a time, so most frames land between two notches, then let go on
        // the panel.
        let mut panel = Panel::new(Kind::Properties);
        step(&mut panel, &status, Some(egui::pos2(column, row)), false, 0.0);
        step(&mut panel, &status, Some(egui::pos2(column, row)), true, 0.0);
        let mut x = column;
        while x < 300.0 {
            x += 1.3;
            step(&mut panel, &status, Some(egui::pos2(x, row)), true, 0.0);
            // While it is held, the slider shows a notch of the table's, never a value between.
            let (_, held) = panel.editing.clone().expect("the stature slider is being dragged");
            let notches = (held as f64 - range.min) / range.step;
            assert!((notches - notches.round()).abs() < 1e-3, "held at {held}, {notches} notches");
        }
        let released = step(&mut panel, &status, Some(egui::pos2(x, row)), false, 0.0);
        let value = stature_sent(&released.commands).expect("a released drag sends");
        assert!((range.min..=range.max).contains(&value), "sent {value}");
        let notches = (value - range.min) / range.step;
        assert!((notches - notches.round()).abs() < 1e-9, "sent {value}, off a step of {}", range.step);
        // Written as the desktop writes it, not as an f32 widened: 1.735, not 1.7350000143.
        assert_eq!(value, (value * 1000.0).round() / 1000.0, "sent {value}");
        assert!(value > 1.5, "dragged right, and sent {value}");

        // A publisher that sends no range for stature does not honour it, and gets no slider.
        let mut without = fixture();
        without.controls.remove("stature");
        assert_eq!(stature_row(&without, column), None);
    }

    #[test]
    fn the_brain_buttons_are_the_desktops_flags_and_send_its_actions() {
        // The actions are the ones the desktop's `act` takes by name; a typo here is a button
        // that sends a line the desktop drops.
        let status = fixture();
        let [set_up, hand_over] = brain_buttons(&status.brain);
        let row = |r: &[BrainButton; 2]| r.iter().map(|b| (b.label, b.enabled, b.action)).collect::<Vec<_>>();
        assert_eq!(
            row(&set_up),
            [("Set up as trained", true, "setup"), ("Undo set-up", true, "undoSetup")]
        );
        assert_eq!(
            row(&hand_over),
            [("Hand over control", true, "handover"), ("Release", false, "release")]
        );
        // A desktop that says nothing of them offers neither.
        let mut before = status.brain.clone();
        before.can_set_up = false;
        before.can_undo_set_up = false;
        let [set_up, _] = brain_buttons(&before);
        assert!(set_up.iter().all(|b| !b.enabled));
    }

    /// Every brain action a click anywhere on the top of the Brain tab sends, found as a person
    /// would find the buttons: by pressing down the tab's column, right of the tab strip -- a press
    /// on the strip would change tabs -- and letting go where they pressed.
    fn brain_actions_clicked(status: &Status) -> Vec<&'static str> {
        let mut panel = Panel::new(Kind::Properties);
        panel.tab = Tab::Brain;
        let mut sent = Vec::new();
        for y in (60..520).step_by(6) {
            for x in (170..640).step_by(30) {
                let at = Some(egui::pos2(x as f32, y as f32));
                step(&mut panel, status, at, false, 0.0);
                step(&mut panel, status, at, true, 0.0);
                for command in step(&mut panel, status, at, false, 0.0).commands {
                    if let Command::Brain { action, .. } = command {
                        sent.push(action);
                    }
                }
            }
        }
        sent
    }

    /// The same, on any tab and down the whole height of its column, with the tab scrolled to the
    /// bottom first when `to_the_foot`. Each row is pressed on a panel of its own, because a press
    /// on one of the Muscles tab's folded sections opens it and would move every row below.
    fn actions_clicked_on(tab: Tab, status: &Status, to_the_foot: bool) -> Vec<&'static str> {
        let mut sent = Vec::new();
        for y in (60..740).step_by(6) {
            let mut panel = Panel::new(Kind::Properties);
            panel.tab = tab;
            // The second frame is laid out on the panel's own size; the first is egui's default.
            step(&mut panel, status, None, false, 0.0);
            if to_the_foot {
                for _ in 0..30 {
                    step(&mut panel, status, Some(egui::pos2(400.0, 400.0)), false, -1.0);
                }
            }
            for x in (170..640).step_by(30) {
                let at = Some(egui::pos2(x as f32, y as f32));
                step(&mut panel, status, at, false, 0.0);
                step(&mut panel, status, at, true, 0.0);
                for command in step(&mut panel, status, at, false, 0.0).commands {
                    if let Command::Brain { action, .. } = command {
                        sent.push(action);
                    }
                }
            }
        }
        sent
    }

    #[test]
    fn set_up_as_trained_and_its_undo_are_pressed_on_the_brain_tab_and_only_when_offered() {
        let status = fixture();
        let sent = brain_actions_clicked(&status);
        assert!(sent.contains(&"setup"), "{sent:?}");
        assert!(sent.contains(&"undoSetup"), "{sent:?}");
        // Offered neither, pressing where they are sends neither; the rest of the tab still works.
        let mut without = fixture();
        without.brain.can_set_up = false;
        without.brain.can_undo_set_up = false;
        let sent = brain_actions_clicked(&without);
        assert!(!sent.contains(&"setup") && !sent.contains(&"undoSetup"), "{sent:?}");
        assert!(sent.contains(&"handover"), "{sent:?}");
    }

    /// The tab a press at `y` down the tab column leaves chosen, starting from the Body tab.
    fn tab_pressed_at(status: &Status, y: f32) -> Tab {
        let mut panel = Panel::new(Kind::Properties);
        // Right of the grab strip, in the middle of the column's buttons.
        let at = Some(egui::pos2(GRAB_WIDTH + 50.0, y));
        step(&mut panel, status, at, false, 0.0);
        step(&mut panel, status, at, true, 0.0);
        step(&mut panel, status, at, false, 0.0);
        panel.tab
    }

    #[test]
    fn the_tabs_are_the_desktops_with_health_under_the_developer_divider() {
        // Pressed down the column one row at a time, as a person would find them: the tabs come
        // in the desktop's order, Training a tab of its own after Brain, and Health last, under
        // the divider. The divider itself is a heading, and a press on it chooses nothing.
        let status = fixture();
        let mut order: Vec<Tab> = Vec::new();
        let mut last_export = None;
        let mut first_health = None;
        for y in (0..780).step_by(3) {
            let tab = tab_pressed_at(&status, y as f32);
            if tab == Tab::Export {
                last_export = Some(y);
            }
            if tab == Tab::Health && first_health.is_none() {
                first_health = Some(y);
            }
            if tab != Tab::Body && !order.contains(&tab) {
                order.push(tab);
            }
        }
        let expected: Vec<Tab> = TABS.iter().chain(DEVELOPER_TABS.iter()).map(|(t, _)| *t).skip(1).collect();
        assert_eq!(order, expected);
        assert_eq!(
            expected,
            [Tab::World, Tab::Sim, Tab::Scene, Tab::Muscles, Tab::Brain, Tab::Training, Tab::Export, Tab::Health]
        );
        let (export, health) = (last_export.expect("an Export tab"), first_health.expect("a Health tab"));
        // Between the last row that is Export and the first that is Health there is the divider:
        // more than the few points between two neighbouring tabs.
        assert!(health - export > 20, "Export ends at {export}, Health starts at {health}");
        assert!((export + 3..health).step_by(3).all(|y| tab_pressed_at(&status, y as f32) == Tab::Body));
    }

    #[test]
    fn the_spine_is_on_the_muscles_tab_and_training_has_its_own() {
        // The cord's five gains moved from Brain to Muscles, as they did on the desktop, and the
        // training buttons to a Training tab: each sends from its new tab and from nowhere else.
        let status = fixture();
        let spine = ["reflexStretch", "reflexVelocity", "reflexSetPoint", "reflexInhibition", "reflexDelay"];
        let training = ["memory", "trainStop", "follow"];
        // The Spine is at the foot of the Muscles tab, which is longer than the panel.
        let on_muscles = actions_clicked_on(Tab::Muscles, &status, true);
        let on_brain = actions_clicked_on(Tab::Brain, &status, false);
        let on_training = actions_clicked_on(Tab::Training, &status, false);
        for action in spine {
            assert!(on_muscles.contains(&action), "{action} not on Muscles: {on_muscles:?}");
            assert!(!on_brain.contains(&action) && !on_training.contains(&action), "{action} left behind");
        }
        for action in training {
            assert!(on_training.contains(&action), "{action} not on Training: {on_training:?}");
            assert!(!on_brain.contains(&action) && !on_muscles.contains(&action), "{action} left behind");
        }
        // The Brain tab keeps the policy in the loop.
        assert!(on_brain.contains(&"handover") && on_brain.contains(&"authority"), "{on_brain:?}");
        // With muscles off the drive and readout go, and the cord stays: its gains are the next
        // run's, as the desktop's are.
        let mut off = fixture();
        off.muscles = false;
        let on_muscles_off = actions_clicked_on(Tab::Muscles, &off, false);
        assert!(on_muscles_off.contains(&"reflexStretch"), "{on_muscles_off:?}");
    }

    #[test]
    fn the_stick_scrolls_the_tab_the_ray_is_on() {
        // The Muscles tab, its Spine under the drive and the readout, is longer than the panel.
        // Pulled back, the stick brings its bottom up.
        let status = fixture();
        let mut panel = Panel::new(Kind::Properties);
        panel.tab = Tab::Muscles;
        let on_face = Some(egui::pos2(400.0, 400.0));
        step(&mut panel, &status, on_face, false, 0.0);
        let id = panel.scroll_id.expect("the properties panel scrolls");
        let offset = |panel: &Panel| {
            egui::scroll_area::State::load(&panel.ctx, id).map_or(0.0, |state| state.offset.y)
        };
        assert_eq!(offset(&panel), 0.0);
        for _ in 0..2 {
            step(&mut panel, &status, on_face, false, -1.0);
        }
        let scrolled = offset(&panel);
        assert!(scrolled > 0.0, "offset {scrolled}");
        // Pushed forward, back towards the top.
        for _ in 0..2 {
            step(&mut panel, &status, on_face, false, 1.0);
        }
        assert!(offset(&panel) < scrolled, "{} after {scrolled}", offset(&panel));
        // With no ray on the panel a stick is not the panel's, and nothing moves.
        let before = offset(&panel);
        step(&mut panel, &status, None, false, -1.0);
        step(&mut panel, &status, None, false, -1.0);
        assert_eq!(offset(&panel), before);
    }

    #[test]
    fn every_tab_is_laid_out_on_the_panel() {
        // Nothing drawn past the panel's right edge, the scroll bar included: past it there is
        // only the room, where no ray can reach it.
        let status = fixture();
        let size = Kind::Properties.size();
        for (tab, name) in TABS.into_iter().chain(DEVELOPER_TABS) {
            let mut panel = Panel::new(Kind::Properties);
            panel.tab = tab;
            // The second frame: egui lays the first out on a screen of its own default size.
            step(&mut panel, &status, None, false, 0.0);
            let frame = step(&mut panel, &status, None, false, 0.0);
            let widest = frame
                .meshes
                .iter()
                .flat_map(|mesh| mesh.vertices.iter())
                .map(|v| v.pos.x)
                .fold(0.0f32, f32::max);
            // egui's anti-aliasing feathers every edge it draws by under a point.
            assert!(widest <= size[0] + 1.0, "{name}: drawn out to {widest} of {}", size[0]);
        }
    }

    /// WCAG 2's relative luminance of an opaque colour.
    fn luminance(c: egui::Color32) -> f64 {
        let channel = |v: u8| {
            let v = v as f64 / 255.0;
            if v <= 0.03928 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * channel(c.r()) + 0.7152 * channel(c.g()) + 0.0722 * channel(c.b())
    }

    /// WCAG 2's contrast ratio between two opaque colours, 1 to 21.
    fn contrast(a: egui::Color32, b: egui::Color32) -> f64 {
        let (la, lb) = (luminance(a), luminance(b));
        (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
    }

    /// The premultiplied fill over whatever is behind the panel, as the blend draws it.
    fn over(fill: egui::Color32, behind: egui::Color32) -> egui::Color32 {
        let rest = 1.0 - fill.a() as f64 / 255.0;
        let mix = |f: u8, b: u8| (f as f64 + b as f64 * rest).round().min(255.0) as u8;
        egui::Color32::from_rgb(mix(fill.r(), behind.r()), mix(fill.g(), behind.g()), mix(fill.b(), behind.b()))
    }

    #[test]
    fn notes_are_readable_on_the_panel_and_still_quieter_than_labels() {
        // The panel lets a little of the room through, so the fill is checked over the darkest
        // and the brightest room there could be.
        for behind in [egui::Color32::BLACK, egui::Color32::WHITE] {
            let fill = over(PANEL_FILL, behind);
            let note = contrast(NOTE_TEXT, fill);
            let body = contrast(BODY_TEXT, fill);
            assert!(note >= 4.5, "a note is {note:.2}:1 over {fill:?}");
            assert!(body > note, "a label {body:.2}:1 and a note {note:.2}:1 over {fill:?}");
        }
        // And the labels are that colour: the panel sets it on its theme.
        let panel = Panel::new(Kind::Properties);
        assert_eq!(panel.ctx.style().visuals.widgets.noninteractive.fg_stroke.color, BODY_TEXT);
    }

    #[test]
    fn a_drive_slider_shows_the_excitation_it_asks_for() {
        assert_eq!(excitation_text(50.0), "25%");
        assert_eq!(excitation_text(5.0), "0.3%");
        assert_eq!(excitation_text(100.0), "100%");
        assert_eq!(excitation_text(0.0), "0%");
        assert_eq!(excitation_text(10.0), "1%");
        // What is typed is read as that excitation, back to the position that asks for it.
        assert_eq!(position_from_excitation_text("25%"), Some(50.0));
        assert_eq!(position_from_excitation_text(" 100 "), Some(100.0));
        assert_eq!(position_from_excitation_text("0"), Some(0.0));
        assert_eq!(position_from_excitation_text("lots"), None);
        assert_eq!(position_from_excitation_text("-4%"), None);
        // The drive itself is unchanged: still the position, which the publisher squares.
        assert_eq!(Command::Drive(0, 50.0).to_json(), r#"{"kind":"drive","group":0,"value":50}"#);
    }

    #[test]
    fn the_timeline_and_play_follow_the_studio_playhead() {
        // The studio scrubbed back to 1.5 s of a 2.75 s recording, playing it back.
        let studio = fixture();
        let view = transport_view(&studio);
        assert_eq!(view.value, 1.5);
        assert_eq!(view.end, 3.0, "the bar reaches the end of the recording, not the playhead");
        assert_eq!((view.play_label, view.play_sends), ("Pause", false));
        assert_eq!(view.label, "paused");
        // Paused on the live edge: Play plays, and the label says where it is.
        let mut at_the_edge = studio.clone();
        at_the_edge.playing = Some(false);
        at_the_edge.live = Some(true);
        let view = transport_view(&at_the_edge);
        assert_eq!((view.play_label, view.play_sends), ("Play", true));
        assert_eq!(view.label, "paused · live");
        // The headless publisher sends none of it: its run's own time is the playhead and the
        // end, and Play asks it to play.
        let headless: Status = serde_json::from_str(
            r#"{"generation":1,"scenario":{"id":"a","title":"A"},"scenarios":[],
            "profile":"l1_standard","simSeconds":12.5,"speed":1,"paused":false,"muscles":true,
            "holding":[],"grabStrength":1}"#,
        )
        .expect("parses");
        let view = transport_view(&headless);
        assert_eq!((view.value, view.end), (12.5, 13.0));
        assert_eq!((view.play_label, view.play_sends), ("Play", true));
        assert_eq!(view.label, "1.00x life");
    }

    #[test]
    fn play_sends_the_state_its_label_offers() {
        // Pressed while the studio says it is playing, the button asks it to stop, not to toggle.
        let status = fixture();
        let mut panel = Panel::new(Kind::Transport);
        let pause = (0..1000).step_by(4).find_map(|x| {
            (40..150).step_by(4).find_map(|y| {
                let at = Some(egui::pos2(x as f32, y as f32));
                step(&mut panel, &status, at, false, 0.0);
                step(&mut panel, &status, at, true, 0.0);
                let up = step(&mut panel, &status, at, false, 0.0);
                up.commands.into_iter().find(|c| matches!(c, Command::Set(key, _) if key == "play"))
            })
        });
        assert_eq!(pause, Some(set("play", false)));
    }

    #[test]
    fn the_transport_strip_fits_its_longest_labels() {
        // Pause rather than Play, the live mark, the longest mode, and a run twenty minutes long
        // with the speed to two places: the row still ends on the strip. The panel's own fill
        // reaches its right edge exactly, so anything past it is the row running off.
        let size = Kind::Transport.size();
        for (seconds, mode, paused) in [(1.5, "running", false), (1234.5, "following", false), (1234.5, "rest", true)] {
            let mut status = fixture();
            status.live = Some(true);
            status.playing = Some(true);
            status.recorded_seconds = Some(seconds);
            status.sim_seconds = seconds;
            status.speed = 0.98765;
            status.paused = paused;
            status.mode = mode.to_string();
            let mut panel = Panel::new(Kind::Transport);
            step(&mut panel, &status, None, false, 0.0);
            let frame = step(&mut panel, &status, None, false, 0.0);
            let widest = frame.meshes.iter().flat_map(|m| m.vertices.iter()).map(|v| v.pos.x).fold(0.0f32, f32::max);
            assert!(widest <= size[0] + 1.0, "{mode} at {seconds} s: drawn out to {widest} of {}", size[0]);
        }
    }

    /// The height the waiting view takes in the properties panel's column, with or without the
    /// guide, laid out at the column's width as `run` gives it. With the guide, the controllers
    /// under it are the simple profile's, whose note is the longest.
    fn waiting_height(guide: bool, status_error: Option<&str>) -> f32 {
        let headset = Headset {
            profiles: ["khr/simple_controller".into(), "khr/simple_controller".into()],
            snap_turn: false,
        };
        let panel = Panel::new(Kind::Properties);
        let size = Kind::Properties.size();
        let mut height = 0.0;
        for _ in 0..2 {
            let input = egui::RawInput {
                screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(size[0], size[1]))),
                ..Default::default()
            };
            let _ = panel.ctx.run(input, |ctx| {
                egui::CentralPanel::default().frame(egui::Frame::none()).show(ctx, |ui| {
                    // The grab strip, the tab column and the gap after it, as `run` lays them.
                    ui.set_width(size[0] - GRAB_WIDTH - 110.0 - 8.0);
                    let content = ui.vertical(|ui| {
                        waiting(
                            ui,
                            "pose /tmp/bs-humany-pose: waiting for the publisher",
                            status_error,
                            guide.then_some(&headset),
                        )
                    });
                    height = content.response.rect.height();
                });
            });
        }
        height
    }

    #[test]
    fn the_waiting_view_shows_the_controls_without_running_off_the_panel() {
        // The guide is there -- a row a control -- and, with an unreadable status said above it
        // as well, the whole view still fits the scrolled column without a scroll.
        let bare = waiting_height(false, None);
        let guided = waiting_height(true, None);
        assert!(guided - bare > CONTROLS.len() as f32 * 20.0, "{bare} without the guide, {guided} with");
        let worst = waiting_height(true, Some("invalid type: null, expected u64 at line 1 column 18"));
        let column = Kind::Properties.size()[1] - 60.0;
        assert!(worst <= column, "{worst} points of waiting view in a {column} point column");
    }

    /// Clicks down and across the transport strip until one reports a local action, as a person
    /// would look for the box: the frame that found it.
    fn find_snap_box(status: Option<&Status>, liveness: Option<&crate::follow::Liveness>, headset: &Headset) -> Option<Frame> {
        let mut panel = Panel::new(Kind::Transport);
        (40..1000).step_by(6).find_map(|x| {
            (0..150).step_by(6).find_map(|y| {
                let at = egui::pos2(x as f32, y as f32);
                let mut frame = |pressed| {
                    let pointer = Pointer { at: Some(at), pressed, scroll: 0.0 };
                    panel.run(status, pointer, 1.0 / 90.0, "feeds", liveness, None, headset)
                };
                frame(false);
                frame(true);
                let up = frame(false);
                up.local.is_some().then_some(up)
            })
        })
    }

    #[test]
    fn the_snap_turn_box_is_the_viewers_and_is_never_sent_to_the_publisher() {
        let status = fixture();
        let off = Headset::default();
        let pressed = find_snap_box(Some(&status), None, &off).expect("a snap-turn box on the strip");
        assert_eq!(pressed.local, Some(LocalAction::SnapTurn(true)));
        assert!(pressed.commands.is_empty(), "sent to the publisher: {:?}", pressed.commands);
        // Ticked, a press turns it off: the box shows what the viewer keeps.
        let on = Headset { snap_turn: true, ..Headset::default() };
        let pressed = find_snap_box(Some(&status), None, &on).expect("still there when ticked");
        assert_eq!(pressed.local, Some(LocalAction::SnapTurn(false)));
        // With no publisher at all, and with one gone silent, it is still there to press: it is
        // the headset's, and needs nobody to read it.
        assert!(find_snap_box(None, None, &off).is_some(), "no box while waiting for a publisher");
        let silent = crate::follow::Liveness::Silent(4);
        assert!(
            find_snap_box(Some(&status), Some(&silent), &off).is_some(),
            "the box greyed with the run's controls while the publisher is silent"
        );
    }

    #[test]
    fn the_controllers_in_hand_are_said_under_the_guide() {
        assert_eq!(
            controllers_text(&Headset::default()),
            "The runtime has not said yet which controllers are in hand."
        );
        let index = Headset {
            profiles: ["valve/index_controller".into(), "valve/index_controller".into()],
            snap_turn: false,
        };
        assert_eq!(controllers_text(&index), "Controllers: left valve/index_controller, right valve/index_controller.");
        // One hand empty, the other on the simple profile: both said, and why the stick is dead.
        let simple = Headset { profiles: [String::new(), "khr/simple_controller".into()], snap_turn: false };
        let text = controllers_text(&simple);
        assert!(text.starts_with("Controllers: left none, right khr/simple_controller."), "{text}");
        assert!(text.contains("no stick"), "{text}");
    }

    #[test]
    fn the_readme_table_is_the_guide() {
        // README's "Moving about" says it is this list; every row of it is a row of the table
        // there, the control and what it does, so the two cannot drift apart unnoticed.
        let readme = include_str!("../README.md");
        let rows: Vec<Vec<&str>> = readme
            .lines()
            .filter(|line| line.starts_with('|'))
            .map(|line| line.trim_matches('|').split('|').map(str::trim).collect())
            .collect();
        for (control, action) in CONTROLS {
            assert!(
                rows.iter().any(|row| row.len() == 2 && row[0] == *control && row[1] == *action),
                "README has no row `| {control} | {action} |`"
            );
        }
    }
}
