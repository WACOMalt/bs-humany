//! Moving about: the sticks walk, turn and lift the viewer through the world, smoothly or, for
//! turning, in snap steps; a stick pressed in recentres; and a stick whose hand's ray is on a
//! panel scrolls the panel instead.
//!
//! The stage does not move -- it is the room, where the runtime puts the head and the hands -- so
//! moving the viewer is moving the world under it the other way. `Viewpoint` is that: where the
//! stage origin sits in the world and how far the world is turned, and the conversions the frame
//! loop draws, aims and grabs through, so that the three never disagree about where the world is.

use crate::panel::Placement;

// How fast the sticks move the viewer at full deflection, and how far a stick must be pushed
// before it moves anything.
pub(crate) const WALK_SPEED: f32 = 2.0; // m/s at full deflection
pub(crate) const TURN_SPEED: f32 = 1.6; // radians a second at full deflection, a little over a right angle
pub(crate) const LIFT_SPEED: f32 = 1.2; // m/s at full deflection
pub(crate) const DEAD_ZONE: f32 = 0.15;

/// Where the viewer stands in the world and how far they have turned: the stage does not move,
/// so walking, turning and rising are all the world moving underneath it. `offset` is where the
/// stage origin sits in the world; `yaw` is how far the world is turned about the viewer, growing
/// as the viewer turns to their right.
#[derive(Clone, Copy, Default)]
pub(crate) struct Viewpoint {
    pub(crate) offset: [f32; 3],
    pub(crate) yaw: f32,
}

impl Viewpoint {
    /// The turn the world is drawn through.
    fn spin(&self) -> [f32; 4] {
        [0.0, (self.yaw * 0.5).sin(), 0.0, (self.yaw * 0.5).cos()]
    }

    /// A point of the world, where the stage has it.
    pub(crate) fn to_stage(self, p: [f32; 3]) -> [f32; 3] {
        crate::math::rotate(
            [p[0] - self.offset[0], p[1] - self.offset[1], p[2] - self.offset[2]],
            self.spin(),
        )
    }

    /// A point of the stage -- a hand, a mark -- where the world has it.
    pub(crate) fn to_world(self, p: [f32; 3]) -> [f32; 3] {
        let turned = self.to_world_direction(p);
        [turned[0] + self.offset[0], turned[1] + self.offset[1], turned[2] + self.offset[2]]
    }

    /// A direction of the stage in the world: the turn without the walk.
    pub(crate) fn to_world_direction(self, v: [f32; 3]) -> [f32; 3] {
        crate::math::rotate(v, crate::math::quaternion_conjugate(self.spin()))
    }

    /// A rotation of the stage -- a hand's -- in the world.
    pub(crate) fn to_world_rotation(self, q: [f32; 4]) -> [f32; 4] {
        crate::math::quaternion_multiply(crate::math::quaternion_conjugate(self.spin()), q)
    }

    /// The matrix everything of the world is drawn through.
    pub(crate) fn shift(&self) -> [f32; 16] {
        crate::math::multiply(
            &crate::math::pose_matrix([0.0, 0.0, 0.0], self.spin()),
            &crate::math::translation_matrix([-self.offset[0], -self.offset[1], -self.offset[2]]),
        )
    }

    /// Turn by `by` radians about where the head is, so the world under the head stays under it
    /// and the viewer turns on the spot. `head` is in the stage.
    pub(crate) fn turn(&mut self, by: f32, head: [f32; 3]) {
        let was = self.to_world(head);
        self.yaw += by;
        let now = self.to_world(head);
        for axis in 0..3 {
            self.offset[axis] += was[axis] - now[axis];
        }
    }
}

/// Where the panels start, for a viewer standing at `head` and looking along `forward`, both in
/// the world: the properties panel ahead and to the right of the body, a little below eye height,
/// and the transport strip under it, both turned to face where the viewer stands. Only the head's
/// place on the floor and the way it faces flat to the floor count; the panels' heights are the
/// room's, not the head's.
///
/// At startup the viewer is taken to be at the stage's middle looking down -Z, which is where
/// SteamVR and Monado put somebody who has set their room up; a recentre puts the panels back
/// the same way round wherever the viewer is standing and looking then.
pub(crate) fn home_placements(head: [f32; 3], forward: [f32; 3]) -> [Placement; 2] {
    use crate::panel::Kind;
    let length = (forward[0] * forward[0] + forward[2] * forward[2]).sqrt();
    // Looking straight up or down there is no way the head faces: the room's own -Z stands in.
    let ahead = if length < 1e-6 { [0.0, 0.0, -1.0] } else { [forward[0] / length, 0.0, forward[2] / length] };
    let right = [-ahead[2], 0.0, ahead[0]];
    // A point given for a viewer at the origin facing -Z -- x to their right, z behind them --
    // carried to this one.
    let about = |p: [f32; 3]| {
        [
            head[0] + right[0] * p[0] - ahead[0] * p[2],
            p[1],
            head[2] + right[2] * p[0] - ahead[2] * p[2],
        ]
    };
    [
        Placement::facing(Kind::Properties.size(), about([0.95, 1.3, -1.0]), about([0.0, 1.3, 0.0])),
        Placement::facing(Kind::Transport.size(), about([0.55, 0.76, -1.05]), about([0.0, 0.76, 0.0])),
    ]
}

/// Put the viewer back where they started and the panels back in front of them, from wherever
/// the sticks and a carried panel have taken them: the stick pressed in.
///
/// The viewpoint goes back to where it began, so the body and the scenery are where they were
/// when the viewer started, in front of the stage. The panels come back to their places for
/// wherever the viewer stands in the room now, turned to where they are looking, since they are
/// what somebody who has got lost needs in front of them first. A panel being carried is let go:
/// the hand carrying it was moving it through a world that has just moved under it.
pub(crate) fn recentre(
    view_point: &mut Viewpoint,
    placements: &mut [Placement; 2],
    carrying: &mut [Option<(usize, crate::panel::Held)>; crate::bridge::HANDS],
    head: [f32; 3],
    head_q: [f32; 4],
) {
    *view_point = Viewpoint::default();
    // With the viewpoint at its start the world and the stage are one, so the head's pose in the
    // stage is its pose in the world.
    *placements = home_placements(head, crate::math::rotate([0.0, 0.0, -1.0], head_q));
    *carrying = [None, None];
}

/// How far one step of snap turn turns: a twelfth of a circle. Thirty degrees is the step most
/// headset software offers first, big enough that a few presses turn somebody round and small
/// enough that they keep their bearings across one.
const SNAP_STEP: f32 = std::f32::consts::PI / 6.0;
/// A stick pushed this far over turns one step...
const SNAP_PUSH: f32 = 0.7;
/// ...and must come back inside this before it can turn another. The gap between the two is what
/// keeps a stick held near the threshold from turning again on every tremor.
const SNAP_REARM: f32 = 0.3;

/// One frame of snap turn: how far to turn, given the stick's sideways deflection and whether a
/// turn is armed, which this keeps. A step to the right is positive, as a smooth turn to the
/// right is.
pub(crate) fn snap_turn(x: f32, armed: &mut bool) -> f32 {
    if *armed && x.abs() > SNAP_PUSH {
        *armed = false;
        SNAP_STEP * x.signum()
    } else {
        if x.abs() < SNAP_REARM {
            *armed = true;
        }
        0.0
    }
}

/// One axis of a stick past its dead zone, rescaled so that it starts from nothing.
pub(crate) fn past_dead_zone(v: f32, dead: f32) -> f32 {
    if v.abs() <= dead {
        0.0
    } else {
        v.signum() * (v.abs() - dead) / (1.0 - dead)
    }
}

/// A stick, and whether its hand's ray is on a panel's face: what is left of it to move the
/// viewer, and how far it scrolls. On a panel the stick is the panel's alone, both axes, so a
/// push to scroll that wanders sideways does not turn the room; its forward part, past the dead
/// zone, is the scroll.
pub(crate) fn stick_on_panel(stick: [f32; 2], on_panel: bool, dead: f32) -> ([f32; 2], f32) {
    if on_panel {
        ([0.0, 0.0], past_dead_zone(stick[1], dead))
    } else {
        (stick, 0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::panel::Kind;

    fn close(a: [f32; 3], b: [f32; 3]) -> bool {
        (0..3).all(|i| (a[i] - b[i]).abs() < 1e-4)
    }

    #[test]
    fn a_turn_to_the_right_swings_the_world_to_the_left() {
        // A quarter turn to the right, standing at the stage's middle: what was straight ahead
        // is now off to the left, which is what a viewer who turned right would see.
        let mut v = Viewpoint::default();
        v.turn(std::f32::consts::FRAC_PI_2, [0.0, 1.6, 0.0]);
        let ahead = v.to_stage([0.0, 0.0, -2.0]);
        assert!(close(ahead, [-2.0, 0.0, 0.0]), "{ahead:?}");
    }

    #[test]
    fn a_turn_is_about_the_head_and_not_the_middle_of_the_stage() {
        // The head is a metre off the stage's middle; the world under it stays under it.
        let head = [1.0, 1.6, 0.0];
        let mut v = Viewpoint { offset: [3.0, 0.0, -2.0], yaw: 0.4 };
        let under = v.to_world(head);
        v.turn(0.9, head);
        assert!(close(v.to_world(head), under), "{:?}", v.to_world(head));
    }

    #[test]
    fn the_stage_and_the_world_are_each_other_undone() {
        let v = Viewpoint { offset: [1.5, 0.25, -3.0], yaw: -1.1 };
        let p = [0.3, 1.2, -0.8];
        assert!(close(v.to_world(v.to_stage(p)), p));
        assert!(close(v.to_stage(v.to_world(p)), p));
    }

    #[test]
    fn what_is_drawn_is_what_the_stage_says() {
        // The shift matrix and `to_stage` are the same transform; the draw and the grab must not
        // disagree about where the world is.
        let v = Viewpoint { offset: [-0.7, 1.0, 2.5], yaw: 0.8 };
        let p = [2.0, 0.5, -1.25];
        let m = v.shift();
        let drawn = [
            m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ];
        assert!(close(drawn, v.to_stage(p)), "{drawn:?} vs {:?}", v.to_stage(p));
    }

    #[test]
    fn rising_lifts_the_viewer_rather_than_the_world() {
        // The stick pushed forward raises the offset, and the world is then drawn lower down.
        let v = Viewpoint { offset: [0.0, 1.5, 0.0], yaw: 0.0 };
        assert!(close(v.to_stage([0.0, 0.0, 0.0]), [0.0, -1.5, 0.0]));
    }

    #[test]
    fn a_stick_starts_from_nothing_once_it_is_past_its_dead_zone() {
        assert_eq!(past_dead_zone(0.1, 0.15), 0.0);
        assert_eq!(past_dead_zone(-0.15, 0.15), 0.0);
        assert!((past_dead_zone(0.15 + 1e-6, 0.15)).abs() < 1e-5);
        assert!((past_dead_zone(1.0, 0.15) - 1.0).abs() < 1e-6);
        assert!((past_dead_zone(-1.0, 0.15) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn snap_turn_steps_once_a_push_and_rearms_only_back_near_the_middle() {
        // Pushed right and held: one step, not one a frame. Back to 0.2, under the re-arm, and
        // over again: a second. Two thirty-degree turns in all.
        let mut armed = true;
        let turns: Vec<f32> = [0.0, 0.8, 0.8, 0.2, 0.8].iter().map(|&x| snap_turn(x, &mut armed)).collect();
        assert_eq!(turns, [0.0, SNAP_STEP, 0.0, 0.0, SNAP_STEP]);
        assert!((SNAP_STEP - 30f32.to_radians()).abs() < 1e-6);
        // Let back only to 0.5, between the two thresholds, it does not re-arm; and left is the
        // other way.
        let mut armed = true;
        let turns: Vec<f32> = [-0.9, -0.5, -0.9, 0.0, -0.9].iter().map(|&x| snap_turn(x, &mut armed)).collect();
        assert_eq!(turns, [-SNAP_STEP, 0.0, 0.0, 0.0, -SNAP_STEP]);
    }

    #[test]
    fn a_stick_aimed_at_a_panel_scrolls_it_and_moves_nobody() {
        // Off a panel the stick is the viewer's, whole, and scrolls nothing.
        assert_eq!(stick_on_panel([0.4, -0.9], false, 0.15), ([0.4, -0.9], 0.0));
        // On one, it is the panel's: both axes out of the walk, the turn and the lift, and its
        // forward part past the dead zone is the scroll, forward positive.
        let (moving, scroll) = stick_on_panel([0.4, 1.0], true, 0.15);
        assert_eq!(moving, [0.0, 0.0]);
        assert!((scroll - 1.0).abs() < 1e-6);
        assert_eq!(stick_on_panel([0.9, 0.1], true, 0.15), ([0.0, 0.0], 0.0));
    }

    fn same_placement(a: &Placement, b: &Placement) -> bool {
        close(a.origin, b.origin) && close(a.right, b.right) && close(a.down, b.down) && close(a.normal, b.normal)
    }

    #[test]
    fn a_recentre_puts_the_viewer_back_and_the_panels_in_front() {
        let start = home_placements([0.0, 0.0, 0.0], [0.0, 0.0, -1.0]);
        // The panels start where they always have.
        let properties = Placement::facing(Kind::Properties.size(), [0.95, 1.3, -1.0], [0.0, 1.3, 0.0]);
        let transport = Placement::facing(Kind::Transport.size(), [0.55, 0.76, -1.05], [0.0, 0.76, 0.0]);
        assert!(same_placement(&start[0], &properties) && same_placement(&start[1], &transport));

        // Turned, walked, risen, and a panel carried off and being carried still.
        let mut view_point = Viewpoint::default();
        view_point.turn(1.3, [0.2, 1.6, 0.1]);
        view_point.offset[0] += 4.0;
        view_point.offset[1] += 0.8;
        let mut placements = start;
        let held = placements[1].held_by([0.3, 1.0, -0.4], [0.0, 0.0, 0.0, 1.0]);
        placements[1] = placements[1].carried(&held, [2.0, 1.4, 3.0], [0.0, 0.0, 0.0, 1.0]);
        let mut carrying = [None, Some((1, held))];

        // Recentred standing at the stage's middle, looking down -Z: all as it began.
        recentre(&mut view_point, &mut placements, &mut carrying, [0.0, 1.6, 0.0], [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(view_point.offset, [0.0; 3]);
        assert_eq!(view_point.yaw, 0.0);
        assert!(same_placement(&placements[0], &start[0]) && same_placement(&placements[1], &start[1]));
        assert!(carrying.iter().all(Option::is_none), "a carried panel is let go");

        // Recentred a metre to the side and looking to the right: the panels come to where the
        // viewer is, the same way round -- ahead of them and to their right, facing them.
        let quarter_right = [0.0, -std::f32::consts::FRAC_1_SQRT_2, 0.0, std::f32::consts::FRAC_1_SQRT_2];
        let head = [1.0, 1.7, 0.0];
        recentre(&mut view_point, &mut placements, &mut carrying, head, quarter_right);
        let ahead = crate::math::rotate([0.0, 0.0, -1.0], quarter_right);
        assert!(close(ahead, [1.0, 0.0, 0.0]), "looking along {ahead:?}");
        let centre = placements[0].centre();
        let from_head = [centre[0] - head[0], centre[2] - head[2]];
        // A metre ahead (+X now) and 0.95 to the right (+Z now), at the height it always was.
        assert!((from_head[0] - 1.0).abs() < 1e-4 && (from_head[1] - 0.95).abs() < 1e-4, "{from_head:?}");
        assert!((centre[1] - 1.3).abs() < 1e-4);
        // Facing the viewer: its normal points back towards where they stand.
        let normal = placements[0].normal;
        let back = [head[0] - centre[0], head[2] - centre[2]];
        assert!(normal[0] * back[0] + normal[2] * back[1] > 0.0, "{normal:?} faces away");
    }
}
