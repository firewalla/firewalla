const DEVICE_TYPES = require('./parser/const/device-type');
const DEVICE_TYPE_IDS = require('./parser/const/device-type-id');
const CLIENT_TYPES = require('./parser/const/client-type');

/**
 * get device type string
 * @param result
 * @returns {string|null}
 */
const getDeviceType = (result) => {
  return result.device && result.device.type ? result.device.type : null;
};

/**
 * get device type id for name
 * @param {string} name
 * @returns {number|null}
 */
const getDeviceTypeIdForName = (name) => {
  return name && DEVICE_TYPE_IDS[name] ? DEVICE_TYPE_IDS[name] : null;
};

/**
 * get device type id
 * @param result
 * @returns {number|null}
 */
const getDeviceTypeId = (result) => {
  return getDeviceTypeIdForName(getDeviceType(result))
};

/**
 * get client type string
 * @param result
 * @returns {string|null}
 */
const getClientType = (result) => {
  return result.client && result.client.type ? result.client.type : null;
};

/**
 * is device type table
 * @param result
 * @returns {boolean}
 */
const isTablet = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.TABLET;
};
/**
 * is device type phablet
 * @param result
 * @returns {boolean}
 */
const isPhablet = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.PHABLET;
};

/**
 * is feature phone (push-button telephones)
 * @param result
 * @returns {boolean}
 */
const isFeaturePhone = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.FEATURE_PHONE;
};
/**
 * is device type smartphone
 * @param result
 * @returns {boolean}
 */
const isSmartphone = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.SMARTPHONE;
};

/**
 * is device type car
 * @param result
 * @returns {boolean}
 */
const isCar = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.CAR_BROWSER;
};

/**
 * is device type mobile (feature phone, smartphone or phablet)
 * @param result
 * @returns {boolean}
 */
const isMobile = (result) => {
  return isSmartphone(result) || isFeaturePhone(result) || isPhablet(result);
};

/**
 * is device type desktop
 * @param result
 * @returns {boolean}
 */
const isDesktop = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.DESKTOP;
};

/**
 * is os android
 * @param result
 * @returns {boolean}
 */
const isAndroid = (result) => {
  return result.os && result.os.family === 'Android';
};

/**
 * is os ios
 * @param result
 * @returns {boolean}
 */
const isIOS = (result) => {
  return result.os && result.os.family === 'iOS';
};

/**
 * is device type tv
 * @param result
 * @returns {boolean}
 */
const isTv = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.TV;
};

/**
 * is device type console (xBox, PlayStation, Nintendo etc)
 * @param result
 * @returns {boolean}
 */
const isConsole = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.CONSOLE;
};

/**
 * is device type portable camera
 * @param result
 * @returns {boolean}
 */
const isCamera = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.CAMERA;
};

/**
 * is device type portable media player
 * @param result
 * @returns {boolean}
 */
const isPortableMediaPlayer = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.PORTABLE_MEDIA_PLAYER;
};

/**
 * is device type smart speaker (Alisa, Alexa, HomePod etc)
 * @param result
 * @returns {boolean}
 */
const isSmartSpeaker = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.SMART_SPEAKER;
};

/**
 * is device type peripheral (portable terminal, post terminal,
 * single board computers, portable projector)
 * @param result
 * @returns {boolean}
 */
const isPeripheral = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.PERIPHERAL;
};

/**
 * is device type smart display (LCD panel or interactive panel)
 * @param result
 * @returns {boolean}
 */
const isSmartDisplay = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.SMART_DISPLAY;
};

/**
 * is device type wearable (watches, headsets)
 * @param result
 * @returns {boolean}
 */
const isWearable = (result) => {
  return getDeviceType(result) === DEVICE_TYPES.WEARABLE;
};

/**
 * is client type browser
 * @param result
 * @returns {boolean}
 */
const isBrowser = (result) => {
  return getClientType(result) === CLIENT_TYPES.BROWSER;
};

/**
 * is client type app (any type of client other than browser)
 * @param result
 * @returns {boolean}
 */
const isApp = (result) => {
  return getClientType(result) !== null && !isBrowser(result);
};

/**
 * is client type app desktop
 * @param result
 * @returns {boolean}
 */
const isDesktopApp = (result) => {
  return isApp(result) && isDesktop(result);
};

/**
 * is client type app mobile
 * @param result
 * @returns {boolean}
 */
const isMobileApp = (result) => {
  return isApp(result) && (isMobile(result) || isTablet(result));
};


module.exports = {
  getDeviceType,
  getDeviceTypeId,
  getDeviceTypeIdForName,
  getClientType,
  isCamera,
  isCar,
  isConsole,
  isDesktop,
  isFeaturePhone,
  isMobile,
  isPeripheral,
  isPhablet,
  isPortableMediaPlayer,
  isSmartDisplay,
  isSmartSpeaker,
  isSmartphone,
  isTablet,
  isTv,
  isWearable,
  isAndroid,
  isBrowser,
  isApp,
  isDesktopApp,
  isMobileApp,
  isIOS,
};
