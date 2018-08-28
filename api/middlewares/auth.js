'use strict';

let tm = require('./TokenManager').getInstance();

module.exports = function(req, res, next) {
  if (req.headers && tm.validateToken(req.headers['authorization'])) {
    next();
  } else {
    let err = new Error('Unauthorized');
    err.status = 401;
    next(err);
  }
};
