// Small platform shims for mainstream Android WebViews. Existing native methods win.
function installArrayMethod(name, value) {
  if (!Array.prototype[name]) Object.defineProperty(Array.prototype, name, {value, configurable:true, writable:true});
}
installArrayMethod('at', function(index) {
  const length = this.length >>> 0;
  let position = Math.trunc(Number(index) || 0);
  if (position < 0) position += length;
  return position >= 0 && position < length ? this[position] : undefined;
});
installArrayMethod('findLastIndex', function(predicate, thisArg) {
  if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
  for (let index = (this.length >>> 0) - 1; index >= 0; index--) {
    if (predicate.call(thisArg, this[index], index, this)) return index;
  }
  return -1;
});
installArrayMethod('findLast', function(predicate, thisArg) {
  if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
  for (let index = (this.length >>> 0) - 1; index >= 0; index--) {
    if (predicate.call(thisArg, this[index], index, this)) return this[index];
  }
  return undefined;
});
if (globalThis.crypto && !globalThis.crypto.randomUUID && globalThis.crypto.getRandomValues) {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable:true,
    value() {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    },
  });
}
