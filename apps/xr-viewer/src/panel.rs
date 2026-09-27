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
//! Each has a **grab strip** down its left edge. A hand whose ray meets the strip and pulls the
//! trigger takes the panel with it until the trigger is let go; the panel then stays where it was
//! put. A controller's aim ray is otherwise the pointer and its trigger the click. The panels'
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

    /// Where a ray meets the panel, if it does and the panel is in front of the ray: the grab
    /// strip or the face, and the point in points.
    pub fn hit(&self, from: [f32; 3], direction: [f32; 3]) -> Option<Hit> {
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
        let x = dot(at, self.right) / POINT_METRES;
        let y = dot(at, self.down) / POINT_METRES;
        if x < 0.0 || y < 0.0 || x > self.size[0] || y > self.size[1] {
            return None;
        }
        Some(if x < GRAB_WIDTH {
            Hit::Grab(egui::pos2(x, y))
        } else {
            Hit::Face(egui::pos2(x, y))
        })
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

/// One frame of a panel: its meshes to draw, its texture changes to apply first, and what the
/// person pressed.
pub struct Frame {
    pub meshes: Vec<(egui::TextureId, Vec<egui::epaint::Vertex>, Vec<u32>)>,
    pub textures: egui::TexturesDelta,
    pub commands: Vec<Command>,
}

/// What the pointer is doing this frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pointer {
    pub at: Option<egui::Pos2>,
    pub pressed: bool,
}

/// The properties panel's tabs, the desktop's in the desktop's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    let mut value = match &editing.current {
        Some((k, v)) if k == key => *v,
        _ => from_status,
    };
    let response = ui.add(
        egui::Slider::new(&mut value, range)
            .text(label)
            .fixed_decimals(decimals),
    );
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
    if response.drag_stopped() || response.clicked() {
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
        }
    }

    /// Lay the panel out for this frame and say what to draw and what was asked.
    pub fn run(&mut self, status: Option<&Status>, pointer: Pointer, feeds: &str) -> Frame {
        let size = self.kind.size();
        let mut events = Vec::new();
        match pointer.at {
            Some(at) => {
                events.push(egui::Event::PointerMoved(at));
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
                                    ui.set_width(size[0] - GRAB_WIDTH - 118.0);
                                    ui.add_space(14.0);
                                    egui::ScrollArea::vertical()
                                        .max_height(size[1] - 60.0)
                                        .show(ui, |ui| match status {
                                            Some(s) => properties(ui, tab, s, &mut editing, &mut commands, feeds),
                                            None => waiting(ui, feeds),
                                        });
                                    ui.with_layout(egui::Layout::bottom_up(egui::Align::LEFT), |ui| {
                                        note(ui, feeds);
                                    });
                                });
                            }
                            Kind::Transport => {
                                ui.add_space(10.0);
                                ui.vertical(|ui| {
                                    ui.set_width(size[0] - GRAB_WIDTH - 20.0);
                                    ui.add_space(12.0);
                                    match status {
                                        Some(s) => transport(ui, s, &mut editing, &mut commands),
                                        None => waiting(ui, feeds),
                                    }
                                });
                            }
                        }
                    });
                });
        });
        self.tab = tab;
        self.editing = editing.current;
        self.last_live_send = editing.last_live_send;

        let meshes = self
            .ctx
            .tessellate(output.shapes, output.pixels_per_point)
            .into_iter()
            .filter_map(|primitive| match primitive.primitive {
                egui::epaint::Primitive::Mesh(mesh) => {
                    Some((mesh.texture_id, mesh.vertices, mesh.indices))
                }
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

fn waiting(ui: &mut egui::Ui, feeds: &str) {
    ui.label("Waiting for the publisher: start a run in the studio, or run `pnpm publish:pose`.");
    note(ui, feeds);
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
    if let Some(v) = slider(ui, editing, "dropHeight", "drop height m", st.drop_height as f32, 0.0..=1.5, 2, false) {
        commands.push(set("dropHeight", v as f64));
    }
    note(ui, "For a free drop only; a scenario places the body itself.");
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
    for p in &s.scenario_parameters {
        let decimals = if p.step >= 1.0 { 0 } else if p.step >= 0.1 { 1 } else { 2 };
        let label = if p.unit.is_empty() { p.title.clone() } else { format!("{} {}", p.title, p.unit) };
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
        let Some(Hit::Face(centre)) = panel.hit([0.0, 0.5, 0.0], [0.0, 0.0, -1.0]) else {
            panic!("misses the face");
        };
        assert!((centre.x - size[0] / 2.0).abs() < 1e-3 && (centre.y - size[1] / 2.0).abs() < 1e-3);
        let corner = panel.to_world(egui::pos2(0.0, 0.0));
        let Some(Hit::Grab(back)) = panel.hit([0.0, 0.5, 0.0], [corner[0], corner[1] - 0.5, corner[2]]) else {
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
}
