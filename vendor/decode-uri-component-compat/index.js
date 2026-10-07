'use strict';
const decode = require('./upstream.cjs');

// Preserve query-string 7's decoder contract, including fragments and repeated decoding.
module.exports = function decodeUriComponentCompat(input) {
  return decode(typeof input === 'string' ? input.replace(/\+/g, ' ') : input);
};
