'use strict';

let tm = require('./TokenManager').getInstance();

module.exports = function(req, res, next) {
  let gid = tm.validateToken(req.headers['authorization'])
  if (req.headers && gid) {
    req._gid = gid;
    next();
  } else {
    let err = new Error('Unauthorized');
    err.status = 401;
    next(err);
  }
};
