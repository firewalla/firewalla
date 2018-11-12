/*
 * This app will provide API for local calls, to apify all internal services
 */
'use strict';

var express = require('express');
var path = require('path');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var argv = require('minimist')(process.argv.slice(2));
var swagger = require("swagger-node-express");
const passport = require('passport');
//var Strategy = require('passport-http-bearer').Strategy;
//var db = require('./db');

let firewalla = require('../net2/Firewalla.js');
let log = require('../net2/logger.js')(__filename, 'info')

var system = require('./routes/system');
var message = require('./routes/message');
var shadowsocks = require('./routes/shadowsocks');
let dnsmasq = require('./routes/dnsmasq');
let alarm = require('./routes/alarm');
let flow = require('./routes/flow');
let host = require('./routes/host');
let mode = require('./routes/mode');
let test = require('./routes/test');
let policy = require('./routes/policy');

// periodically update cpu usage, so that latest info can be pulled at any time
let si = require('../extension/sysinfo/SysInfo.js');
si.startUpdating();

var app = express();

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

var subpath_v1 = express();
app.use("/v1", subpath_v1);
subpath_v1.use(passport.initialize());
subpath_v1.use(passport.session());
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
  enableSubPath('scisurf');
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
    log.error("[Developerment] Got error when handling request:", err, err.stack, {});
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
  log.error("Got error when handling request: ", err, err.stack, {});
  res.status(err.status || 500);
  res.json({
    message: err.message,
    error: {}
  });
});


module.exports = app;
