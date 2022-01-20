/*    Copyright 2018-2020 Firewalla Inc.
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
 * This app will provide API for lan calls, to apify all internal services
 */
'use strict';

const f = require('../net2/Firewalla.js');
const express = require('express');
const path = require('path');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const fs = require('fs');

let log = require('../net2/logger.js')(__filename, 'info')

// periodically update cpu usage, so that latest info can be pulled at any time
let si = require('../extension/sysinfo/SysInfo.js');
si.startUpdating();

let app = express();

app.set('title', 'FireAPI Pro')

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.engine('mustache', require('mustache-express')());
app.set('view engine', 'mustache');
app.set('json spaces', 2);

// uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

let subpath_v1 = express();
app.use('/v1', subpath_v1);
subpath_v1.use(bodyParser.json());
subpath_v1.use(bodyParser.urlencoded({ extended: false }));
subpath_v1.use(require('./middlewares/auth'));

const router = express.Router();
router.use(bodyParser.json());
const cloudWrapper = require('./routes/fastencipher2').cloudWrapper

async function netbotHandler(gid, mtype, data) {
  try {
    const controller = await cloudWrapper.getNetBotController(gid);
    const msg = {
      mtype: 'msg',
      message: {
        obj: {
          mtype: mtype,
          data: data,
          type: 'jsonmsg'
        },
        type: 'jsondata'
      }
    }
    const result = await controller.msgHandlerAsync(gid, msg);
    return result
  } catch(err) {
    log.error('Error processing request', err)
    return err
  }
}

fs.readdirSync(f.getFirewallaHome() + '/api/routes/pro').forEach(file => {
  if (file.endsWith('.js')) {
    require('./routes/pro/' + file)(router, netbotHandler);
  }
})
subpath_v1.use(router);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  let err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    log.error("[Developerment] Got error when handling request:", err, err.stack);
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
  log.error("Got error when handling request: ", err, err.stack);
  res.status(err.status || 500);
  res.json({
    message: err.message,
    error: {}
  });
});


module.exports = app;
