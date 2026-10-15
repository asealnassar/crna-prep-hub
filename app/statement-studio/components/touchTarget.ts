/**
 * The minimum size of anything a finger has to hit.
 *
 * ---------------------------------------------------------------------------
 * 44 CSS PIXELS, APPLIED WHERE TOUCHING HAPPENS
 * ---------------------------------------------------------------------------
 * The editor's controls were sized for a cursor: the Bold button was 32 x 32,
 * the Draft/Complete toggle about 26 high, the font select smaller still. On a
 * phone those are targets you aim at and miss, and missing Bold means a stray
 * tap into the document.
 *
 * `min-h-11` IS 44px in this Tailwind scale (11 x 0.25rem). It is a MINIMUM,
 * so a control that is already taller keeps its own height, and the existing
 * padding keeps centring the label inside the larger box.
 *
 * RELEASED AT `sm:`, which is 640px and up: a pointer does not need 44px, and
 * forcing it there would leave a toolbar of oversized squares on the desktop
 * layout the owner designed. Below that width every one of these is a touch
 * target, whatever the device claims to be.
 *
 * ONE CONSTANT, NOT A CONVENTION. A rule written out at a dozen call sites is
 * a rule that will be two rules by the next change, and the test for this
 * asserts the constant is the thing being used.
 */
export const TOUCH_TARGET = 'min-h-11 sm:min-h-0'

/** The same floor, for a control that is square because it holds an icon. */
export const TOUCH_TARGET_SQUARE = 'min-h-11 min-w-11 sm:min-h-0 sm:min-w-0'
