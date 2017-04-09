'use strict';

var fs = require('fs');

let firewalla = require('../../net2/Firewalla.js');
var fHome = firewalla.getFirewallaHome();

let tokenFile = fHome + '/api/db/token.json';
let tokens = loadTokens(tokenFile);

function loadTokens(tokenFile) {
  if(fs.existsSync(tokenFile)) {
    try {
      return JSON.parse(fs.readFileSync(tokenFile));
    } catch(error) {
      return [];
    }
  } else {
    // token file not found
    return [];
  }
}
exports.findByToken = function(token, cb) {
  process.nextTick(function() {
    for (var i = 0, len = tokens.length; i < len; i++) {
      var t = tokens[i];
      if (t === token) {
        return cb(null, t);
      }
    }
    return cb(null, null);
  });
}
