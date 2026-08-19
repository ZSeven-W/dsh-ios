/**
 * Geometry of the App Switcher gesture on a PHYSICAL device.
 *
 * WebDriverAgent has no switcher endpoint, but a real phone honours the
 * gesture the simulator swallows: a `dragfromtoforduration` from the home
 * indicator to mid-screen with a long duration dwells at the end point, which
 * is exactly the "swipe up and hold" the system recognizer looks for. The
 * SIMULATOR side lives in device-actions.ts — it needs Simulator.app's own
 * menu item, for reasons documented there.
 *
 * @module @zseven-w/dsh-ios/app-switcher
 */

/**
 * Where the swipe starts and ends, as a fraction of screen height: from just
 * above the bottom edge to mid-screen. Ending near the middle (rather than a
 * short flick) is what separates "app switcher" from "go home".
 */
export const APP_SWITCHER_FROM_Y = 0.995
export const APP_SWITCHER_TO_Y = 0.5

/**
 * Gesture duration in SECONDS. WDA holds the touch at the end point for the
 * remainder of the duration, so a long drag IS the dwell the switcher needs;
 * ~1.2 s is comfortably past the recognizer's threshold.
 */
export const APP_SWITCHER_DRAG_DURATION_S = 1.2
