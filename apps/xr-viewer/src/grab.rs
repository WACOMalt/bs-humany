//! Grabbing bones with the squeeze: what a hand holds, the point of bone surface a squeeze takes
//! hold of, and letting go of everything at once.
//!
//! The frame loop turns a squeeze into a grab intent written to the grab channel back to the
//! simulation: taking hold at the nearest surface in reach, carrying the grabbed point with the
//! hand, and an open hand when the squeeze stops. Every way out of drawing lets go first, so the
//! simulation never reads a squeeze that has stopped.

/// What a hand is holding: which pose bone, where in the simulation's frame it took hold, and
/// how the grabbed point sat relative to the hand in the room at that moment.
pub(crate) struct Hold {
    pub(crate) pose_bone: usize,
    pub(crate) point: [f32; 3],
    /// Grabbed point minus hand position, in the stage, at the grab.
    pub(crate) offset: [f32; 3],
    /// The hand's orientation in the stage, at the grab.
    pub(crate) hand_q: [f32; 4],
}

/// Both hands open, on both sides of the channel: an inactive intent written to each slot, so
/// the simulation lets go, and nothing held here, so a squeeze after drawing resumes is a new grab
/// rather than the carrying on of an old one. No channel yet -- no publisher followed -- is only
/// the second. Said on the console when a bone was in fact let go, with why.
pub(crate) fn let_go_of_everything(
    grabs: Option<&mut crate::bridge::GrabIntentWriter>,
    holding: &mut [Option<Hold>; crate::bridge::HANDS],
    why: &str,
) {
    if holding.iter().any(Option::is_some) {
        println!("hands: let go, {why}");
    }
    if let Some(grabs) = grabs {
        for hand in 0..crate::bridge::HANDS {
            grabs.publish(hand, &crate::bridge::GrabIntent::default());
        }
    }
    *holding = [None, None];
}

/// The nearest point on a bone's surface to a hand in the room, with the bone, if any is within
/// reach.
///
/// Bones are first sieved by their posed extent -- centroid carried by the current matrix, half
/// the bounding diagonal at the body's scale, a controller's width of margin -- and only the
/// survivors have their vertices carried into the room and measured, which is a few thousand
/// points at most. Bones with no pose cannot be grabbed, since there is nothing behind them to
/// pull. The nearest vertex stands in for the nearest surface point: the meshes are dense enough
/// that the difference is under a millimetre.
pub(crate) fn nearest_surface(
    pack: &crate::pack::Pack,
    matrices: &[[f32; 16]],
    pose_index: &[Option<usize>],
    dataset_scale: f32,
    hand: [f32; 3],
) -> Option<(usize, usize, [f32; 3])> {
    const REACH: f32 = 0.05;
    let mut best: Option<(f32, usize, usize, [f32; 3])> = None;
    for (i, packed) in pack.manifest.bones.iter().enumerate() {
        let Some(pose_bone) = pose_index.get(i).copied().flatten() else { continue };
        let m = &matrices[i];
        let c = packed.centroid.map(|v| v as f32);
        let centre = [
            m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12],
            m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13],
            m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14],
        ];
        let extent = (0..3)
            .map(|a| (packed.max[a] - packed.min[a]) as f32)
            .fold(0.0f32, |acc, e| acc + e * e)
            .sqrt();
        let radius = extent / 2.0 * dataset_scale;
        let distance = (0..3)
            .map(|a| hand[a] - centre[a])
            .fold(0.0f32, |acc, d| acc + d * d)
            .sqrt();
        if distance - radius > REACH {
            continue;
        }
        // Inside the sieve: measure the surface itself.
        for vertex in pack.bones[i].vertices.chunks_exact(6) {
            let p = [
                m[0] * vertex[0] + m[4] * vertex[1] + m[8] * vertex[2] + m[12],
                m[1] * vertex[0] + m[5] * vertex[1] + m[9] * vertex[2] + m[13],
                m[2] * vertex[0] + m[6] * vertex[1] + m[10] * vertex[2] + m[14],
            ];
            let d = ((hand[0] - p[0]).powi(2) + (hand[1] - p[1]).powi(2) + (hand[2] - p[2]).powi(2)).sqrt();
            if d <= REACH && best.map(|(o, _, _, _)| d < o).unwrap_or(true) {
                best = Some((d, i, pose_bone, p));
            }
        }
    }
    best.map(|(_, i, j, p)| (i, j, p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letting_go_of_everything_opens_both_slots_and_both_hands() {
        // Both hands holding, as the viewer is when it stops drawing mid-grab: afterwards both
        // slots say open, the count has moved on so a reader sees it was said, and nothing is
        // held here to carry on from.
        let path = std::env::temp_dir().join(format!("bs-humany-let-go-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut grabs =
            crate::bridge::GrabIntentWriter::create(&path).expect("the channel is created");
        let squeeze = crate::bridge::GrabIntent {
            active: true,
            bone: 3,
            point: [0.1, 1.0, 0.2],
            target: [0.1, 1.1, 0.2],
            strength: 1.0,
            rotation: [0.0, 0.0, 0.0, 1.0],
        };
        grabs.publish(0, &squeeze);
        grabs.publish(1, &squeeze);
        let hold = || Hold {
            pose_bone: 3,
            point: [0.1, 1.0, 0.2],
            offset: [0.0; 3],
            hand_q: [0.0, 0.0, 0.0, 1.0],
        };
        let mut holding = [Some(hold()), Some(hold())];

        let_go_of_everything(Some(&mut grabs), &mut holding, "the test is over");
        let bytes = std::fs::read(&path).expect("readable");
        let _ = std::fs::remove_file(&path);
        let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let u64_at = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        assert!(holding.iter().all(Option::is_none));
        assert_eq!(u64_at(16), 4, "two squeezes and two open hands written");
        for base in [64, 128] {
            assert_eq!(u64_at(base), 4, "slot at {base} complete, written twice");
            assert_eq!(u32_at(base + 8), 0, "slot at {base} open");
        }

        // With no publisher followed there is no channel, and the hands still let go here.
        let mut holding = [Some(hold()), None];
        let_go_of_everything(None, &mut holding, "no channel");
        assert!(holding.iter().all(Option::is_none));
    }
}
