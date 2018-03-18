'use strict'
/*    Copyright 2016 Firewalla LLC 
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
var winston = require('winston');
const config = winston.config;

let path = require('path');

const moment = require('moment')

String.prototype.capitalizeFirstLetter = function () {
  return this.charAt(0).toUpperCase() + this.slice(1);
}

var devDebug = {
  'BroDetect': 'info',
  'HostManager': 'info',
  'VpnManager': 'info',
  'AlarmManager': 'info',
  'Discovery': 'info',
  'Device Manager': 'info',
  'DNSManager': 'info',
  'FlowManager': 'info',
  'intel': 'info',
  'MessageBus': 'info',
  'SysManager': 'info',
  'PolicyManager': 'info',
  'main': 'info',
  'FlowMonitor': 'info'
};

var productionDebug = {
  'BroDetect': 'error',
  'HostManager': 'error',
  'VpnManager': 'error',
  'AlarmManager': 'error',
  'Discovery': 'error',
  'Device Manager': 'error',
  'DNSManager': 'error',
  'FlowManager': 'error',
  'intel': 'error',
  'MessageBus': 'error',
  'SysManager': 'error',
  'PolicyManager': 'error',
  'main': 'error',
  'FlowMonitor': 'error'
};

var debugMapper = devDebug;
var production = false;
var debugMap = {};

if (process.env.FWPRODUCTION) {
  debugMapper = productionDebug;
  console.log("FWDEBUG SET TO PRODUCTION");
  production = true;
}

if (require('fs').existsSync("/tmp/FWPRODUCTION")) {
  debugMapper = productionDebug;
  console.log("FWDEBUG SET TO PRODUCTION");
  production = true;
}



function getFileTransport() {
  return new(winston.transports.File)({
    level: 'info',
    name: 'log-file',
    filename: process.title + ".log",
    json: false,
    dirname: "/home/pi/logs",
    maxsize: 1000000,
    maxFiles: 3,
    timestamp: function() {
      return moment().format('YYYY-MM-DD HH:mm:ss')
    },
    formatter: function(options) {
      // - Return string will be passed to logger.
      // - Optionally, use options.colorize(options.level, <string>) to
      //   colorize output based on the log level.
      return options.timestamp() + ' ' +
        options.level.toUpperCase() + ' ' +
        (options.message ? options.message : '') +
        (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '' );
    }
  })
}

function getConsoleTransport() {
  const loglevel = 'info'
  if (production)
    loglevel = 'error'

  return new(winston.transports.Console)({
    loglevel: loglevel,
    timestamp: function() {
      return moment().format('YYYY-MM-DD HH:mm:ss')
    },
    formatter: function(options) {
      // - Return string will be passed to logger.
      // - Optionally, use options.colorize(options.level, <string>) to
      //   colorize output based on the log level.
      return options.timestamp() + ' ' +
        config.colorize(options.level, options.level.toUpperCase()) + ' ' +
        (options.message ? options.message : '') +
        (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '' );
    }
  })
}

function getTestTransport() {
  return new(winston.transports.File) ({
    level: 'info',
    name: 'log-file-test',
    filename: "test.log",
    dirname: "/home/pi/.forever",
    maxsize: 100000,
    maxFiles: 1,
    json: false,
    timestamp: true,
    colorize: true
  });
}

let fileTransport = getFileTransport()

let consoleTransport = null
if( production == false ) {
  consoleTransport = getConsoleTransport()
} 

let testTransport = null
if (process.env.NODE_ENV === 'test') {
  testTransport = getTestTransport()
}

function setupLogger(transports) {  
  var logger = new (winston.Logger)({
    transports: transports
  });

  return logger

}

// pass in function arguments object and returns string with whitespaces
function argumentsToString(v) {
  // convert arguments object to real array
  var args = Array.prototype.slice.call(v);
  for (var k in args) {
    if (typeof args[k] === "object") {
      // args[k] = JSON.stringify(args[k]);
      args[k] = require('util').inspect(args[k], false, null, true);
    }
  }
  var str = args.join(" ");
  return str;
}

const logger = setupLogger([fileTransport, consoleTransport, testTransport].filter(x => x != null))
const loglevelInt = logger.levels[logger.level]

module.exports = function (component) {
  component = path.basename(component).split(".")[0].capitalizeFirstLetter();

  // wrapping the winston function to allow for multiple arguments
  var wrap = {};
  wrap.component = component
  wrap.info = function () {
    if (loglevelInt < logger.levels['info']) {
      return // do nothing
    }
    logger.log.apply(logger, ["info", component + ": " + argumentsToString(arguments)]);
  };

  wrap.error = function () {
    if (loglevelInt < logger.levels['error']) {
      return // do nothing
    }
    logger.log.apply(logger, ["error", component + ": " + argumentsToString(arguments)]);
  };

  wrap.warn = function () {
    if (loglevelInt < logger.levels['warn']) {
      return // do nothing
    }
    logger.log.apply(logger, ["warn", component + ": " + argumentsToString(arguments)]);
  };

  wrap.debug = function () {
    if (loglevelInt < logger.levels['debug']) {
      return // do nothing
    }
    logger.log.apply(logger, ["debug", component + ": " + argumentsToString(arguments)]);
  };
  return wrap;
};
