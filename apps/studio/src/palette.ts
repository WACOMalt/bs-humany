/**
 * The overlay colours the studio draws the same thing in wherever it draws it.
 *
 * A muscle is tinted from slack to taut in three places -- the path polylines and swept bellies
 * of a run of our own, and the tubes of a body followed over the bridge -- and the connective
 * tissue is drawn twice, for our own run and for a followed one. Each used to carry its own copy
 * of the numbers, so a colour changed in one would quietly stop matching the other, and the whole
 * point of drawing a followed body the way we draw our own is that the two look the same. So the
 * numbers live here once, as plain hex, and each drawer makes its own three.js colour of them.
 */

/**
 * A relaxed muscle and a fully loaded one.
 *
 * Pale blue reads as slack against bone without competing with it, and is kept light enough to
 * stay visible on a dark ground -- a muscle making no force is still a muscle, and one that
 * vanished when it relaxed would make the slack units impossible to inspect, which is exactly
 * what needs inspecting. The red is the same signal red the contact overlay uses, so a hot muscle
 * and a hard contact look like the same kind of event.
 */
export const MUSCLE_SLACK = 0xa8c8e8;
export const MUSCLE_TAUT = 0xff3b30;

/** Intervertebral discs and costovertebral beads: a pale teal that is neither bone nor muscle. */
export const DISC_COLOUR = 0x9fe3d8;

/** The bars of cartilage drawn for every weld between two segments. */
export const BAR_COLOUR = 0xf7c59f;

/** The thread between the two joints a coupling ties together. */
export const COUPLING_COLOUR = 0xb8a1ff;
