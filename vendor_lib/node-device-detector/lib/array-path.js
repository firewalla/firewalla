
class ArrayPath
{
  /**
   * get key int or str
   * @param key
   * @returns {number|*}
   */
  static getKey(key) {
    let intKey = parseInt(key);
    if (intKey.toString() === key) {
      return intKey;
    }
    return key;
  }

  /**
   * get value to object by path
   * @param obj
   * @param path
   * @param defaultValue
   * @returns {*}
   */
  static get(obj, path, defaultValue) {
    if (typeof path === 'number') {
      path = [path];
    }
    if (!path || path.length === 0) {
      return obj;
    }
    if (obj == null) {
      return defaultValue;
    }
    if (typeof path === 'string') {
      return ArrayPath.get(obj, path.split('.'), defaultValue);
    }
    let currentPath = ArrayPath.getKey(path[0]);
    let nextObj = obj[currentPath];
    if (nextObj === void 0) {
      return defaultValue;
    }
    if (path.length === 1) {
      return nextObj;
    }
    return ArrayPath.get(obj[currentPath], path.slice(1), defaultValue);
  }

  /**
   * set value to object by path
   * @param obj
   * @param path
   * @param value
   * @param doNotReplace
   * @returns {*}
   */
  static set(obj, path, value, doNotReplace) {
    if (typeof path === 'number') {
      path = [path];
    }
    if (!path || path.length === 0) {
      return obj;
    }
    if (typeof path === 'string') {
      return ArrayPath.set(
          obj,
          path.split('.').map(ArrayPath.getKey),
          value,
          doNotReplace
      );
    }
    let currentPath = path[0];
    let currentValue = obj[currentPath] !== void 0 ? obj[currentPath] : void 0;
    if (path.length === 1) {
      if (currentValue === void 0 || !doNotReplace) {
        obj[currentPath] = value;
      }
      return currentValue;
    }
    if (currentValue === void 0) {
      if (typeof path[1] === 'number') {
        obj[currentPath] = [];
      } else {
        obj[currentPath] = {};
      }
    }
    return ArrayPath.set(obj[currentPath], path.slice(1), value, doNotReplace);
  }
}

module.exports = ArrayPath;