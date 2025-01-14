/*    Copyright 2018-2022 Firewalla Inc.
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
 * This app will provide API for local calls, to apify all internal services
 */
'use strict';

const express = require('express');
const path = require('path');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const argv = require('minimist')(process.argv.slice(2));
const swagger = require("swagger-node-express");

const firewalla = require('../net2/Firewalla.js');
const log = require('../net2/logger.js')(__filename, 'info')

const message = require('./routes/message');
const shadowsocks = require('./routes/shadowsocks');
const dnsmasq = require('./routes/dnsmasq');
const alarm = require('./routes/alarm');
const flow = require('./routes/flow');
const host = require('./routes/host');
const mode = require('./routes/mode');
const test = require('./routes/test');

// periodically update cpu usage, so that latest info can be pulled at any time
const si = require('../extension/sysinfo/SysInfo.js');
si.startUpdating();

const app = express();

app.set('title', 'FireAPI Local')

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
app.use('/dashboard', require('./routes/dashboard.js'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(function (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

var subpath_v1 = express();
app.use("/v1", subpath_v1);
subpath_v1.use(bodyParser.json());
subpath_v1.use(bodyParser.urlencoded({ extended: false }));

function enableSubPath(path, lib) {
  lib = lib || path;
  let r = require(`./routes/${lib}.js`);
  subpath_v1.use("/" + path, r);
}

// encipher api is enabled even for production enviornment
enableSubPath('encipher');

if(!firewalla.isProductionOrBeta()) {
  // apis for development purpose only, do NOT enable them in production
  subpath_v1.use('/message', message);
  subpath_v1.use('/ss', shadowsocks);
  subpath_v1.use('/dns', dnsmasq);
  subpath_v1.use('/alarm', alarm);
  subpath_v1.use('/flow', flow);
  subpath_v1.use('/host', host);
  subpath_v1.use('/mode', mode);
  subpath_v1.use('/test', test);

  enableSubPath('policy');
  enableSubPath('exception');
  enableSubPath('system');
  enableSubPath('mac');
  enableSubPath('intel');
  enableSubPath('sensor');
  enableSubPath('proapi');

  let subpath_docs = express();
  subpath_v1.use("/docs", subpath_docs);
  subpath_docs.use("/", express.static('dist'));

  swagger.setAppHandler(subpath_docs);

  subpath_docs.get('/', function (req, res) {
    res.sendfile(__dirname + '/dist/index.html');
  });

  let domain = require('ip').address;
  if(argv.domain !== undefined)
    domain = argv.domain;

  if(firewalla.isDocker()) {
    domain = "127.0.0.1"
  }


  let applicationUrl = 'http://' + domain + "/v1";
  swagger.configureSwaggerPaths('', '/docs/', '');
  swagger.configure(applicationUrl, '1.0.0');

  swagger.setApiInfo({
    title: "Firewalla API",
    description: "API to do something, manage something...",
    termsOfServiceUrl: "",
    contact: "tt@firewalla.com",
    license: "",
    licenseUrl: "",
  });


}

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    log.error("[Development] Got error when handling request:", err);
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
