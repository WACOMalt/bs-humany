//! The panel: the studio's controls, in the room.
//!
//! The studio's UI is a web page in a WebKit view, and there is no way to get that onto a Vulkan
//! image at headset rate. So the controls that matter from inside a headset are drawn again here
//! with egui -- immediate mode, one function a frame, no state to keep in step -- and stood up in
//! the room as a quad a metre or so to the side of the body. A controller's aim ray is the pointer
//! and its trigger the click; the panel's own geometry is here, the Vulkan that draws it is in
//! `render.rs`, and what the buttons do goes back to the publisher as commands through
//! `bridge::CommandWriter`.
//!
//! Everything in points inside egui, at one millimetre a point in the room, so a 520-point panel
//! is 52 centimetres wide: text the size it would be on a poster at arm's length, which is what
//! a headset's resolution wants.

use crate::bridge::Status;

/// Metres a point.
pub const POINT_METRES: f32 = 0.001;
/// The panel's size, in points.
pub const SIZE: [f32; 2] = [560.0, 700.0];

/// Where the panel stands: an origin at its top-left corner and the directions its points run,
/// all in the stage.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub origin: [f32; 3],
    pub right: [f32; 3],
    pub down: [f32; 3],
    pub normal: [f32; 3],
}

impl Placement {
    /// A panel centred at `centre`, upright, turned to face `toward` (usually where the viewer
    /// stands, the stage origin).
    pub fn facing(centre: [f32; 3], toward: [f32; 3]) -> Self {
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
        let half = [SIZE[0] * POINT_METRES / 2.0, SIZE[1] * POINT_METRES / 2.0];
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

    /// Where a ray meets the panel, in points, if it does and the panel is in front of the ray.
    pub fn hit(&self, from: [f32; 3], direction: [f32; 3]) -> Option<egui::Pos2> {
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
        if x < 0.0 || y < 0.0 || x > SIZE[0] || y > SIZE[1] {
            return None;
        }
        Some(egui::pos2(x, y))
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
    /// A setting by name; the publisher decides whether it rebuilds.
    Set(&'static str, serde_json::Value),
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
            Command::Set(key, value) => format!(r#"{{"kind":"set","key":"{key}","value":{value}}}"#),
        }
    }
}

/// One frame of the panel: its meshes to draw, its texture changes to apply first, and what the
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tab {
    Run,
    Scenario,
    Body,
    Muscles,
    Rates,
}

pub struct Panel {
    ctx: egui::Context,
    started: std::time::Instant,
    was_pressed: bool,
    was_on: bool,
    tab: Tab,
    /// The slider being dragged, and its value, which is the panel's until it is let go and the
    /// publisher confirms it. Every other slider shows what the publisher last said.
    editing: Option<(&'static str, f32)>,
}

impl Default for Panel {
    fn default() -> Self {
        Self::new()
    }
}

/// A slider whose value comes from the status except while it is being dragged; `Some` on the
/// frame it should be sent.
fn slider(
    ui: &mut egui::Ui,
    editing: &mut Option<(&'static str, f32)>,
    key: &'static str,
    label: &str,
    from_status: f32,
    range: std::ops::RangeInclusive<f32>,
    decimals: usize,
) -> Option<f32> {
    let mut value = match editing {
        Some((k, v)) if *k == key => *v,
        _ => from_status,
    };
    let response = ui.add(
        egui::Slider::new(&mut value, range)
            .text(label)
            .fixed_decimals(decimals),
    );
    if response.changed() {
        *editing = Some((key, value));
    }
    let done = response.drag_stopped() || (response.changed() && !response.dragged());
    if done {
        *editing = None;
        return Some(value);
    }
    None
}

impl Panel {
    pub fn new() -> Self {
        let ctx = egui::Context::default();
        ctx.set_pixels_per_point(2.0);
        ctx.set_visuals(egui::Visuals::dark());
        ctx.style_mut(|style| {
            for (_, font) in style.text_styles.iter_mut() {
                font.size *= 1.3;
            }
            style.spacing.button_padding = egui::vec2(12.0, 8.0);
            style.spacing.item_spacing = egui::vec2(10.0, 9.0);
            style.spacing.slider_width = 260.0;
            style.spacing.interact_size.y = 28.0;
        });
        Self {
            ctx,
            started: std::time::Instant::now(),
            was_pressed: false,
            was_on: false,
            tab: Tab::Run,
            editing: None,
        }
    }

    /// Lay the panel out for this frame and say what to draw and what was asked.
    pub fn run(&mut self, status: Option<&Status>, pointer: Pointer, feeds: &str) -> Frame {
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
                egui::vec2(SIZE[0], SIZE[1]),
            )),
            time: Some(self.started.elapsed().as_secs_f64()),
            predicted_dt: 1.0 / 144.0,
            events,
            focused: true,
            ..Default::default()
        };

        let mut commands = Vec::new();
        let mut tab = self.tab;
        let mut editing = self.editing;
        let output = self.ctx.run(input, |ctx| {
            egui::CentralPanel::default()
                .frame(
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgba_premultiplied(18, 20, 24, 235))
                        .inner_margin(egui::Margin::same(18.0)),
                )
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.heading("bs-humany");
                        ui.add_space(12.0);
                        for (t, name) in [
                            (Tab::Run, "Run"),
                            (Tab::Scenario, "Scenario"),
                            (Tab::Body, "Body"),
                            (Tab::Muscles, "Muscles"),
                            (Tab::Rates, "Rates"),
                        ] {
                            if ui.selectable_label(tab == t, name).clicked() {
                                tab = t;
                            }
                        }
                    });
                    ui.separator();
                    let Some(s) = status else {
                        ui.label("Waiting for the publisher: run `pnpm publish:pose`.");
                        ui.label(feeds);
                        return;
                    };
                    match tab {
                        Tab::Run => run_tab(ui, s, &mut editing, &mut commands),
                        Tab::Scenario => scenario_tab(ui, s, &mut editing, &mut commands),
                        Tab::Body => body_tab(ui, s, &mut editing, &mut commands),
                        Tab::Muscles => muscles_tab(ui, s, &mut editing, &mut commands),
                        Tab::Rates => rates_tab(ui, s, &mut editing, &mut commands),
                    }
                    ui.with_layout(egui::Layout::bottom_up(egui::Align::LEFT), |ui| {
                        ui.label(egui::RichText::new(feeds).weak());
                    });
                });
        });
        self.tab = tab;
        self.editing = editing;

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

type Editing = Option<(&'static str, f32)>;

fn run_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    ui.label(egui::RichText::new(&s.scenario.title).strong());
    let speed = if s.paused {
        "paused".to_string()
    } else {
        format!("{:.2}x life", s.speed)
    };
    ui.label(format!(
        "sim {:.2} s, {speed}, {} on {}",
        s.sim_seconds,
        if s.muscles { "muscles" } else { "bones only" },
        s.profile
    ));
    ui.label(if s.holding.is_empty() {
        "Squeeze a controller on a bone to grab it.".to_string()
    } else {
        format!("Holding {}", s.holding.join(" and "))
    });
    ui.horizontal(|ui| {
        if s.paused {
            if ui.button("Resume").clicked() {
                commands.push(Command::Resume);
            }
        } else if ui.button("Pause").clicked() {
            commands.push(Command::Pause);
        }
        if ui.button("Reset").clicked() {
            commands.push(Command::Reset);
        }
        if ui.button("< Frame").clicked() {
            commands.push(Command::Step(-1));
        }
        if ui.button("Frame >").clicked() {
            commands.push(Command::Step(1));
        }
    });
    ui.add_space(4.0);
    let end = (s.sim_seconds as f32).max(0.01);
    if let Some(seconds) = slider(ui, editing, "timeline", "s", s.sim_seconds as f32, 0.0..=end, 2) {
        commands.push(Command::Scrub(seconds as f64));
    }
    ui.add_space(6.0);
    let d = &s.diagnostics;
    ui.label(egui::RichText::new("Diagnostics").strong());
    ui.label(format!(
        "kinetic {:.1} J, potential {:.1} J, drift {:.1} mm",
        d.kinetic, d.potential, d.drift_mm
    ));
    ui.label(format!(
        "limits {}, contacts {}, step {:.3} ms",
        if d.violations > 0.0 {
            format!("{} past a stop", d.violations as i64)
        } else {
            format!("{}% of range", (d.limits_worst * 100.0).round() as i64)
        },
        d.contacts as i64,
        d.cost_ms
    ));
}

fn scenario_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    ui.label(egui::RichText::new("Scenario").strong());
    ui.horizontal_wrapped(|ui| {
        for candidate in &s.scenarios {
            let current = candidate.id == s.scenario.id;
            if ui.selectable_label(current, &candidate.title).clicked() && !current {
                commands.push(Command::Set("scenario", candidate.id.clone().into()));
            }
        }
    });
    ui.add_space(6.0);
    ui.label(egui::RichText::new("Profile").strong());
    ui.horizontal_wrapped(|ui| {
        for profile in &s.profiles {
            let current = *profile == s.profile;
            if ui.selectable_label(current, profile).clicked() && !current {
                commands.push(Command::Set("profile", profile.clone().into()));
            }
        }
    });
    ui.add_space(6.0);
    let st = &s.settings;
    ui.horizontal_wrapped(|ui| {
        let mut muscles = st.muscles;
        if ui.checkbox(&mut muscles, "Muscles").changed() {
            commands.push(Command::Set("muscles", muscles.into()));
        }
        let mut passive = st.passive;
        if ui.checkbox(&mut passive, "Passive joints").changed() {
            commands.push(Command::Set("passive", passive.into()));
        }
        let mut redistribute = st.redistribute;
        if ui.checkbox(&mut redistribute, "Redistribute").changed() {
            commands.push(Command::Set("redistribute", redistribute.into()));
        }
        let mut gravity = st.gravity;
        if ui.checkbox(&mut gravity, "Gravity").changed() {
            commands.push(Command::Set("gravity", gravity.into()));
        }
        let mut floor = st.floor;
        if ui.checkbox(&mut floor, "Floor").changed() {
            commands.push(Command::Set("floor", floor.into()));
        }
    });
    if let Some(v) = slider(ui, editing, "dropHeight", "drop height m", st.drop_height as f32, 0.0..=1.5, 2) {
        commands.push(Command::Set("dropHeight", (v as f64).into()));
    }
    ui.label(egui::RichText::new("Rebuilds the body; the bridges reopen.").weak());
}

fn body_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    let st = &s.settings;
    ui.label(egui::RichText::new("Morphology").strong());
    let rows: [(&'static str, &str, f32, std::ops::RangeInclusive<f32>, usize); 6] = [
        ("sex", "sex 0 F .. 1 M", st.sex as f32, 0.0..=1.0, 2),
        ("stature", "stature m", st.stature as f32, 1.4..=2.05, 3),
        ("mass", "mass kg", st.mass as f32, 35.0..=150.0, 1),
        ("crural", "crural index", st.crural as f32, 0.85..=1.15, 3),
        ("brachial", "brachial index", st.brachial as f32, 0.68..=0.9, 3),
        ("legLength", "relative leg length", st.leg_length as f32, 0.9..=1.1, 3),
    ];
    for (key, label, value, range, decimals) in rows {
        if let Some(v) = slider(ui, editing, key, label, value, range, decimals) {
            commands.push(Command::Set(key, (v as f64).into()));
        }
    }
    ui.label(egui::RichText::new("Each change rebuilds the body.").weak());
}

fn muscles_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    if !s.muscles {
        ui.label("Muscles are off for this run. Turn them on under Scenario.");
        return;
    }
    ui.label(egui::RichText::new("Drive, per group").strong());
    // Each group's slider keeps its own key, so dragging one never moves another.
    const KEYS: [&str; 24] = [
        "drive0", "drive1", "drive2", "drive3", "drive4", "drive5", "drive6", "drive7", "drive8",
        "drive9", "drive10", "drive11", "drive12", "drive13", "drive14", "drive15", "drive16",
        "drive17", "drive18", "drive19", "drive20", "drive21", "drive22", "drive23",
    ];
    for (i, group) in s.drive_groups.iter().enumerate().take(KEYS.len()) {
        if let Some(v) = slider(ui, editing, KEYS[i], &group.title, group.level as f32, 0.0..=100.0, 0) {
            commands.push(Command::Drive(i, v));
        }
    }
}

fn rates_tab(ui: &mut egui::Ui, s: &Status, editing: &mut Editing, commands: &mut Vec<Command>) {
    let st = &s.settings;
    if let Some(v) = slider(ui, editing, "fps", "output frames / s", st.fps as f32, 1.0..=240.0, 0) {
        commands.push(Command::Set("fps", (v.round() as f64).into()));
    }
    if let Some(v) = slider(ui, editing, "stepsPerSecond", "simulation steps / s", st.steps_per_second as f32, 60.0..=2000.0, 0) {
        commands.push(Command::Set("stepsPerSecond", (((v / 20.0).round() * 20.0) as f64).into()));
    }
    ui.label(egui::RichText::new("Both rebuild the run.").weak());
    ui.add_space(6.0);
    if let Some(v) = slider(ui, editing, "grabStrength", "grab strength", s.grab_strength as f32, 0.2..=5.0, 2) {
        commands.push(Command::Set("grabStrength", (v as f64).into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ray_from_the_viewer_lands_where_it_points() {
        // A panel centred half a metre up and a metre ahead, facing the origin. A ray from the
        // origin straight at its centre hits the middle point; one at its top-left corner hits
        // (0, 0); one pointing away misses.
        let panel = Placement::facing([0.0, 0.5, -1.0], [0.0, 0.5, 0.0]);
        let centre = panel.hit([0.0, 0.5, 0.0], [0.0, 0.0, -1.0]).expect("hits");
        assert!((centre.x - SIZE[0] / 2.0).abs() < 1e-3 && (centre.y - SIZE[1] / 2.0).abs() < 1e-3);
        let corner = panel.to_world(egui::pos2(0.0, 0.0));
        let back = panel.hit([0.0, 0.5, 0.0], [corner[0], corner[1] - 0.5, corner[2]]).expect("hits");
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
    fn commands_are_the_lines_the_publisher_reads() {
        assert_eq!(Command::Pause.to_json(), r#"{"kind":"pause"}"#);
        assert_eq!(
            Command::Set("scenario", "drop-supine".into()).to_json(),
            r#"{"kind":"set","key":"scenario","value":"drop-supine"}"#
        );
        assert_eq!(
            Command::Set("grabStrength", 2.5.into()).to_json(),
            r#"{"kind":"set","key":"grabStrength","value":2.5}"#
        );
        assert_eq!(Command::Drive(3, 40.0).to_json(), r#"{"kind":"drive","group":3,"value":40}"#);
        assert_eq!(Command::Step(-1).to_json(), r#"{"kind":"step","frames":-1}"#);
    }
}
