import { DetectResult } from '.';

/**
 * get device type string
 * @param result
 * @returns {string|null}
 */
export function getDeviceType(result: DetectResult): string | null;
/**
 * get device type id
 * @param result
 * @returns {number|null}
 */
export function getDeviceTypeId(result: DetectResult): number | null;
/**
 * get device type id for name
 * @param {string} name
 * @returns {number|null}
 */
export function getDeviceTypeIdForName(name: string): number | null;
/**
 * get client type string
 * @param result
 * @returns {string|null}
 */
export function getClientType(result: DetectResult): string | null;
/**
 * is device type portable camera
 * @param result
 * @returns {boolean}
 */
export function isCamera(result: DetectResult): boolean;
/**
 * is device type car
 * @param result
 * @returns {boolean}
 */
export function isCar(result: DetectResult): boolean;
/**
 * is device type console (xBox, PlayStation, Nintendo etc)
 * @param result
 * @returns {boolean}
 */
export function isConsole(result: DetectResult): boolean;
/**
 * is device type desktop
 * @param result
 * @returns {boolean}
 */
export function isDesktop(result: DetectResult): boolean;
/**
 * is feature phone (push-button telephones)
 * @param result
 * @returns {boolean}
 */
export function isFeaturePhone(result: DetectResult): boolean;
/**
 * is device type mobile (feature phone, smartphone or phablet)
 * @param result
 * @returns {boolean}
 */
export function isMobile(result: DetectResult): boolean;
/**
 * is device type peripheral (portable terminal, portable projector)
 * @param result
 * @returns {boolean}
 */
export function isPeripheral(result: DetectResult): boolean;
/**
 * is device type phablet
 * @param result
 * @returns {boolean}
 */
export function isPhablet(result: DetectResult): boolean;
/**
 * is device type portable media player
 * @param result
 * @returns {boolean}
 */
export function isPortableMediaPlayer(result: DetectResult): boolean;
/**
 * is device type smart display (LCD panel or interactive panel)
 * @param result
 * @returns {boolean}
 */
export function isSmartDisplay(result: DetectResult): boolean;
/**
 * is device type smart speaker (Alisa, Alexa, HomePod etc)
 * @param result
 * @returns {boolean}
 */
export function isSmartSpeaker(result: DetectResult): boolean;
/**
 * is device type smartphone
 * @param result
 * @returns {boolean}
 */
export function isSmartphone(result: DetectResult): boolean;
/**
 * is device type table
 * @param result
 * @returns {boolean}
 */
export function isTablet(result: DetectResult): boolean;
/**
 * is device type tv
 * @param result
 * @returns {boolean}
 */
export function isTv(result: DetectResult): boolean;
/**
 * is device type wearable (watches, headsets)
 * @param result
 * @returns {boolean}
 */
export function isWearable(result: DetectResult): boolean;
/**
 * is os android
 * @param result
 * @returns {boolean}
 */
export function isAndroid(result: DetectResult): boolean;
/**
 * is client type browser
 * @param result
 * @returns {boolean}
 */
export function isBrowser(result: DetectResult): boolean;
/**
 * is client type app (any type of client other than browser)
 * @param result
 * @returns {boolean}
 */
export function isApp(result: DetectResult): boolean;
/**
 * is client type app desktop
 * @param result
 * @returns {boolean}
 */
export function isDesktopApp(result: DetectResult): boolean;
/**
 * is client type app mobile
 * @param result
 * @returns {boolean}
 */
export function isMobileApp(result: DetectResult): boolean;
/**
 * is os ios
 * @param result
 * @returns {boolean}
 */
export function isIOS(result: DetectResult): boolean;
