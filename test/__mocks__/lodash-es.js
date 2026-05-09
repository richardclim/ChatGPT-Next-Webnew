const lodash = {
  debounce: (fn) => {
    fn.cancel = () => {};
    fn.flush = () => {};
    return fn;
  },
  mapKeys: (obj, fn) => {
    const result = {};
    Object.keys(obj).forEach((key) => {
      result[fn(obj[key], key)] = obj[key];
    });
    return result;
  },
  mapValues: (obj, fn) => {
    const result = {};
    Object.keys(obj).forEach((key) => {
      result[key] = fn(obj[key], key);
    });
    return result;
  },
  isArray: Array.isArray,
  isObject: (val) => val != null && typeof val === 'object' && !Array.isArray(val),
};

module.exports = lodash;
// Handle named imports if any
Object.assign(module.exports, lodash);
