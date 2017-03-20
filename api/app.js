'use strict';



var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var argv = require('minimist')(process.argv.slice(2));
var swagger = require("swagger-node-express");
const passport = require('passport');
var Strategy = require('passport-http-bearer').Strategy;
var db = require('./db');

let firewalla = require('../net2/Firewalla.js');
let log = require('../net2/logger.js')(__filename, 'info')

passport.use(new Strategy(
  function(token, cb) {
    db.users.findByToken(token, function(err, user) {
      if (err) { return cb(err); }
      if (!user) { return cb(null, false); }
      return cb(null, user);
    });
  }));


var system = require('./routes/system');
var message = require('./routes/message');
var shadowsocks = require('./routes/shadowsocks');
var encipher = require('./routes/fastencipher2');
let dnsmasq = require('./routes/dnsmasq');

// periodically update cpu usage, so that latest info can be pulled at any time
let si = require('../extension/sysinfo/SysInfo.js');
si.startUpdating();

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

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

subpath_v1.use('/encipher', encipher);

if(!firewalla.isProduction()) {
  // apis for development purpose only, do NOT enable them in production
  subpath_v1.use('/sys', system);
  subpath_v1.use('/message', message);
  subpath_v1.use('/ss', shadowsocks);
  subpath_v1.use('/dns', dnsmasq);

  let subpath_docs = express();
  app.use("/docs", subpath_docs);
  subpath_docs.use("/", express.static('dist'));

  swagger.setAppHandler(subpath_docs);

  subpath_docs.get('/', function (req, res) {
    res.sendfile(__dirname + '/dist/index.html');
  });

  swagger.configureSwaggerPaths('', '/docs/api-docs', '');
  swagger.configure(applicationUrl, '1.0.0');

  swagger.setApiInfo({
    title: "Firewalla API",
    description: "API to do something, manage something...",
    termsOfServiceUrl: "",
    contact: "tt@firewalla.com",
    license: "",
    licenseUrl: ""
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
    log.error("Got error when handling request: %j", err);
    res.status(err.status || 500);
    res.render('error', {
      message: err.message,
      error: err
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  log.error("Got error when handling request: %j", err);
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: {}
  });
});


module.exports = app;





var domain = 'localhost';
if(argv.domain !== undefined)
    domain = argv.domain;
else
    log.info('No --domain=xxx specified, taking default hostname "localhost".');
var applicationUrl = 'http://' + domain;

