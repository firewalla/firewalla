/*    Copyright 2016-2025 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * This app will provide API for external calls
 */
'use strict';

const express = require('express');
const path = require('path');
const logger = require('morgan');
const bodyParser = require('body-parser');

const log = require('../net2/logger.js')(__filename, 'info')

const encipher = require('./routes/fastencipher2').router;

const fs = require('fs');
const url = require('url');
const Firewalla = require('../net2/Firewalla.js');

/** Decode one URL path segment (+ as space). Invalid encoding or traversal token -> null */
function decodeTimeLimitsPathSegment(segment) {
  try {
    const s = decodeURIComponent(segment.replace(/\+/g, ' '));
    if (s === '..' || s.includes('\0') || s.includes('/') || s.includes('\\')) return null;
    return s;
  } catch (e) {
    return null;
  }
}

/**
 * Relative file path under time_limits from the request (handles %20, %40, Unicode, etc.).
 * Prefer originalUrl pathname so percent-encoding is applied per segment.
 */
function timeLimitsRelativePath(req) {
  const pathname = (url.parse(req.originalUrl || '', false, true).pathname || req.path || '')
    .replace(/^\/+/, '/');
  if (!pathname.toLowerCase().startsWith('/time_limits')) {
    return { err: 404 };
  }
  let suffix = pathname.replace(/^\/time_limits\/?/i, '');
  const trailingSlash = suffix.endsWith('/') && suffix.length > 0;
  suffix = suffix.replace(/\/+$/, '');
  if (!suffix) {
    return { rel: 'index.html' };
  }
  const segments = suffix.split('/').filter(Boolean).map(decodeTimeLimitsPathSegment);
  if (segments.some(s => s == null)) {
    return { err: 403 };
  }
  let rel = path.join(...segments);
  if (trailingSlash) {
    rel = path.join(rel, 'index.html');
  }
  return { rel };
}

// periodically update cpu usage, so that latest info can be pulled at any time
let si = require('../extension/sysinfo/SysInfo.js');
si.startUpdating();

var app = express();

app.set('title', 'FireAPI')

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.engine('mustache', require('mustache-express')());
app.set('view engine', 'mustache');
app.set('query parser', 'simple');

app.use(logger('combined'));
app.use(bodyParser.json({limit: '5mb'}));

const handleTimeLimits = (req, res) => {
  const timeLimitPath = path.join(__dirname, 'public', 'time_limits');
  const hotPatchDir = path.join(Firewalla.getHiddenFolder(), 'run', 'assets', 'views', 'time_limits');

  const parsed = timeLimitsRelativePath(req);
  if (parsed.err) {
    res.status(parsed.err).send('');
    return;
  }
  const rel = parsed.rel;
  const resolved = path.resolve(timeLimitPath, rel);
  if (path.relative(timeLimitPath, resolved).startsWith('..')) {
    res.status(403).send('');
    return;
  }

  const hotResolved = path.resolve(hotPatchDir, rel);
  const hotBase = path.resolve(hotPatchDir);
  if (!path.relative(hotBase, hotResolved).startsWith('..') &&
      fs.existsSync(hotResolved) && fs.statSync(hotResolved).isFile()) {
    res.sendFile(hotResolved);
    return;
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    res.sendFile(resolved);
    return;
  }
  res.status(404).send('');
}
app.get('/time_limits', handleTimeLimits);
app.get('/time_limits/*', handleTimeLimits);

app.use(express.static(path.join(__dirname, 'public')));
app.use("/ss", require('./routes/ss.js'));
// const cors = require('cors');

// app.use(cors({
//   origin: '*'
// }));



var subpath_v1 = express();
app.use("/v1", subpath_v1);
subpath_v1.use(bodyParser.json({limit: '5mb'}));

subpath_v1.use('/encipher', encipher);
subpath_v1.use('/encipher_raw', require('./routes/raw_encipher.js'));
subpath_v1.use('/time_limits', require('./routes/time_limits.js'));




const AccessRequestManager = require('../alarm/AccessRequestManager.js');
AccessRequestManager.scheduleExpireCronJob();

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'network', 'firewalla-icon.png'), (err) => {
    if (err) res.status(204).end();
  });
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  // var err = new Error('Not Found');
  // err.status = 404;
  // next(err);
  log.error('Not Found', req.url)
  res.status(400).send('');
  next();
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    log.error("Got error when handling request: " + err, err.stack);
    res.status(err.status || 500);
    res.json({
      message: err.message,
      error: err
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  log.error("Got error when handling request: " + err, err.stack);
  res.status(err.status || 500);
  res.json({
    message: err.message,
    error: {}
  });
});


module.exports = app;





// var domain = 'localhost';
// if(argv.domain !== undefined)
//     domain = argv.domain;
// else
//     log.info('No --domain=xxx specified, taking default hostname "localhost".');
// var applicationUrl = 'http://' + domain;

