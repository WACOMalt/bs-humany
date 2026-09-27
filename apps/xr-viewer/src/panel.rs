//! The panels: the studio's controls, in the room.
//!
//! The studio's UI is a web page in a WebKit view, and there is no way to get that onto a Vulkan
//! image at headset rate. So the controls are drawn again here with egui -- immediate mode, one
//! function a frame, no state to keep in step -- and stood up in the room as quads. There are two,
//! as the desktop has two regions that are not the viewport:
//!
//! - the **properties panel**, its tabs down its left edge as the desktop's are: Body, World, Sim,
//!   Scene, Muscles, Brain, Export, Health, with the same controls sending the same keys;
//! - the **transport panel**, one horizontal strip: the run's Start, Pause and Reset, the mode,
//!   the playhead and its frame buttons, the grid, and the overlay toggles.
//!
//! Each has a **grab strip** down its left edge. A hand whose ray is on the strip when it pulls
//! the trigger takes the panel with it until the trigger is let go; the panel then stays where it
//! was put. A controller's aim ray is otherwise the pointer and its trigger the click, and a press
//! keeps the panel it began on, at the ray's point held to the face, until it is let go. A hand
//! aimed at a face scrolls it with its thumbstick. The panels'
//! geometry is here, the Vulkan that draws them is in `render.rs`, and what the buttons do goes
//! back to the publisher as commands through `bridge::CommandWriter`.
//!
//! Everything in points inside egui, at one millimetre a point in the room, so a 620-point panel
//! is 62 centimetres wide: text the size it would be on a poster at arm's length, which is what
//! a headset's resolution wants.

use crate::bridge::Status;

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
    pub fn to_world(&self, p: egui::Pos2) -> [f32; 3] {
        let s = POINT_METRES;
        [
            self.origin[0] + self.right[0] * p.x * s + self.down[0] * p.y * s,
            self.origin[1] + self.right[1] * p.x * s + self.down[1] * p.y * s,
            self.origin[2] + self.right[2] * p.x * s + self.down[2] * p.y * s,
        ]
    }

    /// The panel as a hand holds it: its frame expressed in the hand's, so the hand can carry it.
    pub fn held_by(&self, hand_at: [f32; 3], hand_q: [f32; 4]) -> Held {
        let inverse = crate::render::quaternion_conjugate(hand_q);
        let origin = crate::render::rotate(
            [
                self.origin[0] - hand_at[0],
                self.origin[1] - hand_at[1],
                self.origin[2] - hand_at[2],
            ],
            inverse,
        );
        Held {
            origin,
            right: crate::render::rotate(self.right, inverse),
            down: crate::render::rotate(self.down, inverse),
            normal: crate::render::rotate(self.normal, inverse),
        }
    }

    /// Where the panel is now, carried by a hand that is here.
    pub fn carried(&self, held: &Held, hand_at: [f32; 3], hand_q: [f32; 4]) -> Self {
        let origin = crate::render::rotate(held.origin, hand_q);
        Self {
            origin: [origin[0] + hand_at[0], origin[1] + hand_at[1], origin[2] + hand_at[2]],
            right: crate::render::rotate(held.right, hand_q),
            down: crate::render::rotate(held.down, hand_q),
            normal: crate::render::rotate(held.normal, hand_q),
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
    /// The brain: select, handover, release, authority, trainStart, trainStop, follow.
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
/// height in a second, quick enough to cross the Brain tab and slow enough to stop on a row.
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
    Export,
    Health,
}

const TABS: [(Tab, &str); 8] = [
    (Tab::Body, "Body"),
    (Tab::World, "World"),
    (Tab::Sim, "Sim"),
    (Tab::Scene, "Scene"),
    (Tab::Muscles, "Muscles"),
    (Tab::Brain, "Brain"),
    (Tab::Export, "Export"),
    (Tab::Health, "Health"),
];

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
#[allow(clippy::too_many_arguments)]
fn slider(
    ui: &mut egui::Ui,
    editing: &mut Editing,
    key: &str,
    label: &str,
    from_status: f32,
    range: std::ops::RangeInclusive<f32>,
    decimals: usize,
    live: bool,
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
            let response = ui.add(egui::Slider::new(&mut value, range).fixed_decimals(decimals));
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

fn note(ui: &mut egui::Ui, text: &str) {
    ui.label(egui::RichText::new(text).weak());
}

impl Panel {
    pub fn new(kind: Kind) -> Self {
        let ctx = egui::Context::default();
        ctx.set_pixels_per_point(2.0);
        ctx.set_visuals(egui::Visuals::dark());
        // A click, to egui, is a press that moves under six points before release. Six points
        // here is six millimetres, and a hand pulling a trigger moves more than that -- so nearly
        // every press was a drag and buttons hardly ever fired. Four centimetres of travel and
        // three seconds still make a click; a slider drags regardless.
        ctx.options_mut(|options| {
            options.input_options.max_click_dist = 40.0;
            options.input_options.max_click_duration = 3.0;
        });
        ctx.style_mut(|style| {
            for (_, font) in style.text_styles.iter_mut() {
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
    pub fn run(
        &mut self,
        status: Option<&Status>,
        pointer: Pointer,
        dt: f32,
        feeds: &str,
        liveness: Option<&crate::xr::Liveness>,
        status_error: Option<&str>,
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
        let live = !matches!(liveness, Some(crate::xr::Liveness::Silent(_)));
        let output = self.ctx.run(input, |ctx| {
            egui::CentralPanel::default()
                .frame(
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgba_premultiplied(18, 20, 24, 235))
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
                                    // Brain tab scrolled to its training buttons does not open
                                    // the Body tab half-way down.
                                    let scrolled = egui::ScrollArea::vertical()
                                        .id_salt(tab)
                                        .max_height(size[1] - 60.0 - warned)
                                        .show(ui, |ui| match status {
                                            Some(s) => {
                                                ui.add_enabled_ui(live, |ui| {
                                                    properties(ui, tab, s, &mut editing, &mut commands, feeds)
                                                });
                                            }
                                            None => waiting(ui, feeds, status_error),
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
                                        Some(s) => {
                                            ui.add_enabled_ui(live, |ui| {
                                                transport(ui, s, &mut editing, &mut commands)
                                            });
                                        }
                                        None => waiting(ui, feeds, status_error),
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

/// The tabs, down the left as the desktop's are.
fn tab_column(ui: &mut egui::Ui, tab: &mut Tab, height: f32) {
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
                    if ui
                        .add_sized([96.0, 40.0], egui::SelectableLabel::new(*tab == t, name))
                        .clicked()
                    {
                        *tab = t;
                    }
                }
            });
        });
}

fn waiting(ui: &mut egui::Ui, feeds: &str, status_error: Option<&str>) {
    ui.label("Waiting for the publisher: start a run in the studio, or run `pnpm publish:pose`.");
    if let Some(why) = status_error {
        unreadable(ui, why);
    }
    note(ui, feeds);
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
    liveness: Option<&crate::xr::Liveness>,
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
) {
    match tab {
        Tab::Body => body_tab(ui, s, editing, commands),
        Tab::World => world_tab(ui, s, editing, commands),
        Tab::Sim => sim_tab(ui, s, editing, commands),
        Tab::Scene => scene_tab(ui, s, editing, commands),
        Tab::Muscles => muscles_tab(ui, s, editing, commands),
        Tab::Brain => brain_tab(ui, s, editing, commands),
        Tab::Export => export_tab(ui),
        Tab::Health => health_tab(ui, s, feeds),
    }
}

// --- The transport -----------------------------------------------------------------------------

fn transport(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    ui.horizontal(|ui| {
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
        ui.label(format!(
            "{:.2} s, {}",
            s.sim_seconds,
            if s.paused { "paused".to_string() } else { format!("{:.2}x life", s.speed) }
        ));
        ui.add_space(10.0);
        if ui.button("Play").clicked() {
            commands.push(set("play", true));
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
        // The range grows in whole seconds, so the handle never sits on an end that moves under it.
        let end = (s.sim_seconds as f32).ceil().max(1.0);
        ui.style_mut().spacing.slider_width = 260.0;
        if let Some(seconds) =
            slider(ui, editing, "timeline", "s", s.sim_seconds as f32, 0.0..=end, 2, true)
        {
            commands.push(Command::Scrub(seconds as f64));
        }
    });
    ui.horizontal_wrapped(|ui| {
        let on = |name: &str| s.overlays.get(name).copied().unwrap_or(true);
        for (name, label) in [
            ("grid", "Grid"),
            ("muscles", "Muscle paths"),
            ("muscleVolumes", "Muscle volumes"),
            ("tissue", "Connective tissue"),
        ] {
            if let Some(v) = checkbox(ui, on(name), label) {
                commands.push(set(&format!("overlay.{name}"), v));
            }
        }
        ui.separator();
        note(ui, "desktop viewport:");
        let off = |name: &str| s.overlays.get(name).copied().unwrap_or(false);
        for (name, label) in [
            ("proxies", "Proxies"),
            ("axes", "Axes"),
            ("com", "Centres of mass"),
            ("contacts", "Contacts"),
        ] {
            if let Some(v) = checkbox(ui, off(name), label) {
                commands.push(set(&format!("overlay.{name}"), v));
            }
        }
    });
    if !s.holding.is_empty() {
        note(ui, &format!("Holding {}", s.holding.join(" and ")));
    }
}

// --- The properties tabs ------------------------------------------------------------------------

fn body_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    let st = &s.settings;
    heading(ui, "Who");
    let rows: [(&str, &str, f32, std::ops::RangeInclusive<f32>, usize); 4] = [
        ("sex", "skeletal proportions, 0 F .. 1 M", st.sex as f32, 0.0..=1.0, 2),
        ("stature", "stature m", st.stature as f32, 1.4..=2.05, 3),
        ("mass", "body mass kg", st.mass as f32, 35.0..=150.0, 1),
        ("percentile", "ANSUR II percentile", st.percentile as f32, 0.01..=0.99, 2),
    ];
    for (key, label, value, range, decimals) in rows {
        if let Some(v) = slider(ui, editing, key, label, value, range, decimals, false) {
            commands.push(set(key, v as f64));
        }
    }
    note(ui, "The percentile sets stature and mass together from the distribution.");
    heading(ui, "Proportions");
    let rows: [(&str, &str, f32, std::ops::RangeInclusive<f32>, usize); 3] = [
        ("crural", "crural index, shank / thigh", st.crural as f32, 0.85..=1.15, 3),
        ("brachial", "brachial index, forearm / upper arm", st.brachial as f32, 0.68..=0.9, 3),
        ("legLength", "relative leg length", st.leg_length as f32, 0.9..=1.1, 3),
    ];
    for (key, label, value, range, decimals) in rows {
        if let Some(v) = slider(ui, editing, key, label, value, range, decimals, false) {
            commands.push(set(key, v as f64));
        }
    }
    note(ui, "Each change rebuilds the body.");
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
        if let Some(v) = slider(ui, editing, "dropHeight", "drop height m", height as f32, 0.0..=1.5, 2, false) {
            commands.push(set("dropHeight", v as f64));
        }
        note(ui, "For a free drop only; a scenario places the body itself.");
    } else {
        note(ui, "The scenario places the body; its own parameters are under Scene.");
    }
    heading(ui, "The hand");
    if let Some(v) = slider(ui, editing, "grabStrength", "grab strength", s.grab_strength as f32, 0.1..=5.0, 1, true) {
        commands.push(set("grabStrength", v as f64));
    }
    note(ui, "Squeeze a controller on a bone to pull the body about. At 1x a hold carries a good fraction of the body's weight.");
}

fn sim_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    let st = &s.settings;
    heading(ui, "Time");
    if let Some(v) = slider(ui, editing, "stepsPerSecond", "simulation steps / s", st.steps_per_second as f32, 60.0..=2000.0, 0, false) {
        commands.push(set("stepsPerSecond", ((v / 20.0).round() * 20.0) as f64));
    }
    if let Some(v) = slider(ui, editing, "fps", "output frames / s", st.fps as f32, 1.0..=240.0, 0, false) {
        commands.push(set("fps", v.round() as f64));
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
        ui.label("Cost / tick");
        ui.label(format!("{:.3} ms", d.cost_ms));
        ui.end_row();
    });
    let _ = editing;
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
        let decimals = if p.step >= 1.0 { 0 } else if p.step >= 0.1 { 1 } else { 2 };
        // Trimmed, because the studio's units are readout suffixes with their own leading space
        // (` m`), and a label that adds one of its own showed two.
        let unit = p.unit.trim();
        let label = if unit.is_empty() { p.title.clone() } else { format!("{} {unit}", p.title) };
        let key = format!("scenario.{}", p.id);
        if let Some(v) = slider(ui, editing, &key, &label, p.value as f32, (p.min as f32)..=(p.max as f32), decimals, false) {
            let step = p.step.max(1e-9);
            commands.push(set(&key, ((v as f64) / step).round() * step));
        }
    }
    if let Some(v) = checkbox(ui, s.settings.muscles, "Muscles") {
        commands.push(set("muscles", v));
    }
    note(ui, "A scenario that needs muscles turns them on itself. Muscles start with the next run.");
    heading(ui, "Body");
    ui.horizontal_wrapped(|ui| {
        for profile in &s.profiles {
            let current = *profile == s.profile;
            if ui.selectable_label(current, profile).clicked() && !current {
                commands.push(set("profile", profile.clone()));
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

fn muscles_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    if !s.muscles {
        ui.label("Muscles are off for this run. Turn them on under Scene.");
        return;
    }
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
                if let Some(v) = slider(ui, editing, &key, &group.title, group.level as f32, 0.0..=100.0, 0, true) {
                    commands.push(Command::Drive(i, v));
                }
            }
        });
    }
    note(ui, "Each slider drives its muscles on both sides at once, and is squared.");
    heading(ui, "Readout");
    egui::Grid::new("muscle-readout").num_columns(2).show(ui, |ui| {
        for (key, label) in [
            ("flexion", "Elbow, flex / ext"),
            ("extension", "Knee, flex / ext"),
            ("loaded", "Loaded"),
            ("wrapping", "Wrapping"),
            ("strained", "Out of range"),
        ] {
            ui.label(label);
            ui.label(s.muscle_readout.get(key).cloned().unwrap_or_else(|| "—".to_string()));
            ui.end_row();
        }
    });
}

fn brain_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    let b = &s.brain;
    heading(ui, "Policy in the loop");
    // The desktop's own note, said here as it says it there. This used to be a note of the
    // headset's own sending everyone to a terminal whenever no dashboard was running, which had
    // stopped being true: the desktop lists what it trained and shipped without one.
    if !b.policy_note.is_empty() {
        note(ui, &b.policy_note);
    }
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
    if let Some(v) = slider(ui, editing, "brain.authority", "authority", b.authority as f32, 0.0..=1.0, 2, false) {
        commands.push(Command::Brain { action: "authority", id: None, value: Some(((v as f64) * 20.0).round() / 20.0) });
    }
    note(ui, "The most one output may add to or take from a group's excitation.");
    // Every button on this tab is enabled exactly when the desktop's is, from the flags it sends:
    // the rules live in one place on the desktop, and a copy of them kept here drifted from it.
    ui.horizontal(|ui| {
        if ui.add_enabled(b.can_hand_over, egui::Button::new("Hand over control")).clicked() {
            commands.push(Command::Brain { action: "handover", id: None, value: None });
        }
        if ui.add_enabled(b.can_release, egui::Button::new("Release")).clicked() {
            commands.push(Command::Brain { action: "release", id: None, value: None });
        }
    });
    if !b.fit.is_empty() {
        note(ui, &b.fit);
    }
    heading(ui, "Activity");
    note(ui, if b.active { "The policy is in the loop; its activity bitmap is on the desktop." } else { "No policy in the loop." });

    // The cord, under whatever the brain is doing. The same five gains the desktop offers, with
    // the same keys, because a person in the headset is setting the same body up.
    heading(ui, "Spine");
    note(ui, "The reflexes: a muscle pulled past its set point excites itself and inhibits its opposite. Needs no training, and it is most of what holds a body up. Stretch and Damping at zero is a body with no reflexes at all.");
    let r = &b.reflex;
    if let Some(v) = slider(ui, editing, "spine.stretch", "stretch", r.stretch as f32, 0.0..=8.0, 2, false) {
        commands.push(Command::Brain { action: "reflexStretch", id: None, value: Some(v as f64) });
    }
    if let Some(v) = slider(ui, editing, "spine.velocity", "damping", r.velocity as f32, 0.0..=2.0, 2, false) {
        commands.push(Command::Brain { action: "reflexVelocity", id: None, value: Some(v as f64) });
    }
    if let Some(v) = slider(ui, editing, "spine.setPoint", "set point", r.set_point as f32, -0.2..=0.2, 2, false) {
        commands.push(Command::Brain { action: "reflexSetPoint", id: None, value: Some(v as f64) });
    }
    if let Some(v) = slider(ui, editing, "spine.inhibition", "reciprocal", r.inhibition as f32, 0.0..=1.0, 2, false) {
        commands.push(Command::Brain { action: "reflexInhibition", id: None, value: Some(v as f64) });
    }
    if let Some(v) = slider(ui, editing, "spine.delay", "conduction s", r.delay_seconds as f32, 0.0..=0.12, 3, false) {
        commands.push(Command::Brain { action: "reflexDelay", id: None, value: Some(v as f64) });
    }
    // What depends on the cord's setting and on what has been measured of it comes from the
    // desktop, which is the one place it is kept. The measured table that used to be copied here
    // went stale with every change to the cord; it lives in docs/validation/reflex-gains.md.
    note(ui, "Stretch is a strain: 0.1 is a fibre a tenth longer than optimal.");
    if !b.spine_note.is_empty() {
        note(ui, &b.spine_note);
    }

    heading(ui, "Training");
    note(ui, "Generations, population, episode seconds and workers are as set on the desktop.");
    if let Some(v) = slider(ui, editing, "train.memory", "memory", b.memory as f32, 0.0..=32.0, 0, false) {
        commands.push(Command::Brain { action: "memory", id: None, value: Some((v as f64 / 4.0).round() * 4.0) });
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

fn health_tab(ui: &mut egui::Ui, s: &Status, feeds: &str) {
    heading(ui, "Compile report");
    note(ui, "The compile report, the inertia audit and the joint sweep are on the desktop's Health tab.");
    heading(ui, "This run");
    ui.label(format!(
        "{} on {}, {} steps / s, {} fps out",
        if s.muscles { "muscles" } else { "bones only" },
        s.profile,
        s.settings.steps_per_second,
        s.settings.fps
    ));
    let d = &s.diagnostics;
    ui.label(format!(
        "kinetic {:.1} J, potential {:.1} J, drift {:.1} mm, {} contacts, {:.3} ms a tick",
        d.kinetic, d.potential, d.drift_mm, d.contacts as i64, d.cost_ms
    ));
    heading(ui, "The bridge");
    ui.label(feeds);
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
        let silent = crate::xr::Liveness::Silent(4);
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
                    ui.add_enabled_ui(false, |ui| transport(ui, &status, &mut editing, &mut commands));
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
        panel.run(Some(status), Pointer { at, pressed, scroll }, 1.0 / 90.0, "feeds", None, None)
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

    #[test]
    fn the_stick_scrolls_the_tab_the_ray_is_on() {
        // The Brain tab is longer than the panel. Pulled back, the stick brings its bottom up.
        let status = fixture();
        let mut panel = Panel::new(Kind::Properties);
        panel.tab = Tab::Brain;
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
        for (tab, name) in TABS {
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
}
