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

const loggerManager = require('./LoggerManager.js');
const {argumentsToString} = require('../util/util.js');
const path = require('path');
const fs = require('fs');

const moment = require('moment')

String.prototype.capitalizeFirstLetter = function () {
  return this.charAt(0).toUpperCase() + this.slice(1);
}

var production = false;

if (process.env.FWPRODUCTION) {
  console.log("LOGGER SET TO PRODUCTION");
  production = true;
}

if (fs.existsSync("/tmp/FWPRODUCTION")) {
  console.log("LOGGER SET TO PRODUCTION");
  production = true;
}

var globalLogLevel = 'info';

if (process.env.FWDEBUG) {
  globalLogLevel = process.env.FWDEBUG;
  console.log("LOGGER SET TO", globalLogLevel);
} else if (fs.existsSync("/home/pi/.firewalla/config/FWDEBUG")) {
  globalLogLevel = fs.readFileSync("/home/pi/.firewalla/config/FWDEBUG", "utf8").trim();
  console.log("LOGGER SET TO", globalLogLevel);
}
else if (production) {
  globalLogLevel = 'warn';
}

function getFileTransport() {
  let loglevel = 'debug';
  // if (production) {
  //   loglevel = 'warn';
  // }

  return new(winston.transports.File)({
    level: loglevel,
    name: 'log-file',
    filename: process.title + ".log",
    json: false,
    dirname: `${process.env.HOME}/logs`,
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
  let loglevel = 'debug';
  // if (production) {
  //   loglevel = 'warn';
  // }

  return new(winston.transports.Console)({
    level: loglevel,
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
    level: 'debug',
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

const logger = setupLogger([fileTransport, consoleTransport, testTransport].filter(x => x != null))
const loglevelInt = logger.levels[logger.level]

module.exports = function (component) {
  component = path.basename(component).split(".")[0].capitalizeFirstLetter();

  // wrapping the winston function to allow for multiple arguments
  var wrap = {};
  wrap.component = component;
  wrap.effectiveLogLevel = null;

  let getLogLevel = function() {
    if(wrap.effectiveLogLevel) {
      return wrap.effectiveLogLevel;
    } else {
      return globalLogLevel;
    }
  }

  wrap.info = function () {
    if (logger.levels[getLogLevel()] < logger.levels['info']) {
      return // do nothing
    }
    logger.log.apply(logger, ["info", component + ": " + argumentsToString(arguments)]);
  };

  wrap.forceInfo = function() {
    logger.log.apply(logger, ["info", component + ": " + argumentsToString(arguments)]);
  }

  wrap.error = function () {
    if (logger.levels[getLogLevel()] < logger.levels['error']) {
      return // do nothing
    }
    logger.log.apply(logger, ["error", component + ": " + argumentsToString(arguments)]);
  };

  wrap.warn = function () {
    if (logger.levels[getLogLevel()] < logger.levels['warn']) {
      return // do nothing
    }
    logger.log.apply(logger, ["warn", component + ": " + argumentsToString(arguments)]);
  };

  wrap.verbose = function () {
    if (logger.levels[getLogLevel()] < logger.levels['verbose']) {
      return // do nothing
    }
    logger.log.apply(logger, ["verbose", component + ": " + argumentsToString(arguments)]);
  };

  wrap.debug = function () {
    if (logger.levels[getLogLevel()] < logger.levels['debug']) {
      return // do nothing
    }
    logger.log.apply(logger, ["debug", component + ": " + argumentsToString(arguments)]);
  };

  wrap.silly = function () {
    if (logger.levels[getLogLevel()] < logger.levels['silly']) {
      return // do nothing
    }
    logger.log.apply(logger, ["silly", component + ": " + argumentsToString(arguments)]);
  };

  wrap.setGlobalLogLevel = (level) => {
    if(logger && logger.transports && logger.transports.console) {
      logger.transports.console.level = level;
    }

    if(logger && logger.transports && logger.transports['log-file']) {
      logger.transports['log-file'].level = level;
    }

    globalLogLevel = level;
  };

  loggerManager.registerLogger(component, wrap);

  return wrap;
};
