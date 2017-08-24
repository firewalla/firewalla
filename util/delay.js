'use strict';

let Promise = require('bluebird');

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

exports.delay = delay;
