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
pub const SIZE: [f32; 2] = [520.0, 460.0];

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
    Scenario(String),
    Strength(f32),
}

impl Command {
    /// The line the publisher reads.
    pub fn to_json(&self) -> String {
        match self {
            Command::Pause => r#"{"kind":"pause"}"#.to_string(),
            Command::Resume => r#"{"kind":"resume"}"#.to_string(),
            Command::Reset => r#"{"kind":"reset"}"#.to_string(),
            Command::Scenario(id) => format!(r#"{{"kind":"scenario","id":{}}}"#, json_string(id)),
            Command::Strength(v) => format!(r#"{{"kind":"strength","value":{v}}}"#),
        }
    }
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
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

pub struct Panel {
    ctx: egui::Context,
    started: std::time::Instant,
    was_pressed: bool,
    was_on: bool,
    /// The slider's value, which is the panel's until the publisher confirms it.
    strength: f32,
    strength_from_status: bool,
}

impl Default for Panel {
    fn default() -> Self {
        Self::new()
    }
}

impl Panel {
    pub fn new() -> Self {
        let ctx = egui::Context::default();
        ctx.set_pixels_per_point(2.0);
        ctx.set_visuals(egui::Visuals::dark());
        ctx.style_mut(|style| {
            for (_, font) in style.text_styles.iter_mut() {
                font.size *= 1.35;
            }
            style.spacing.button_padding = egui::vec2(12.0, 8.0);
            style.spacing.item_spacing = egui::vec2(10.0, 10.0);
            style.spacing.slider_width = 300.0;
        });
        Self {
            ctx,
            started: std::time::Instant::now(),
            was_pressed: false,
            was_on: false,
            strength: 1.0,
            strength_from_status: false,
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

        if let Some(s) = status {
            if !self.strength_from_status {
                self.strength = s.grab_strength as f32;
                self.strength_from_status = true;
            }
        }

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
        let mut strength = self.strength;
        let output = self.ctx.run(input, |ctx| {
            egui::CentralPanel::default()
                .frame(
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgba_premultiplied(18, 20, 24, 235))
                        .inner_margin(egui::Margin::same(18.0)),
                )
                .show(ctx, |ui| {
                    ui.heading("bs-humany");
                    match status {
                        None => {
                            ui.label("Waiting for the publisher: run `pnpm publish:pose`.");
                            ui.label(feeds);
                        }
                        Some(s) => {
                            ui.label(egui::RichText::new(&s.scenario.title).strong());
                            let speed = if s.paused {
                                "paused".to_string()
                            } else {
                                format!("{:.2}x life", s.speed)
                            };
                            ui.label(format!(
                                "sim {:.1} s, {speed}, {} on {}",
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
                            });
                            ui.add_space(4.0);
                            ui.label("Grab strength");
                            let slider = ui.add(
                                egui::Slider::new(&mut strength, 0.2..=5.0)
                                    .logarithmic(true)
                                    .fixed_decimals(2),
                            );
                            if slider.drag_stopped() || slider.lost_focus() {
                                commands.push(Command::Strength(strength));
                            }
                            ui.add_space(4.0);
                            ui.label("Scenario");
                            ui.horizontal_wrapped(|ui| {
                                for candidate in &s.scenarios {
                                    let current = candidate.id == s.scenario.id;
                                    if ui.selectable_label(current, &candidate.title).clicked()
                                        && !current
                                    {
                                        commands.push(Command::Scenario(candidate.id.clone()));
                                    }
                                }
                            });
                            ui.add_space(4.0);
                            ui.label(egui::RichText::new(feeds).weak());
                        }
                    }
                });
        });
        self.strength = strength;

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
            Command::Scenario("drop-supine".into()).to_json(),
            r#"{"kind":"scenario","id":"drop-supine"}"#
        );
        assert_eq!(Command::Strength(2.5).to_json(), r#"{"kind":"strength","value":2.5}"#);
    }
}
