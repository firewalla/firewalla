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

let path = require('path');

const moment = require('moment')

String.prototype.capitalizeFirstLetter = function() {
    return this.charAt(0).toUpperCase() + this.slice(1);
}

var devDebug = {
   'BroDetect': 'info',
   'HostManager': 'info',
   'VpnManager': 'info',
   'AlarmManager': 'info',
   'Discovery': 'info',
   'Device Manager':'info',
   'DNSManager':'info',
   'FlowManager':'info',
   'intel':'info',
   'MessageBus':'info',
   'SysManager':'info',
   'PolicyManager':'info',
   'main':'info',
   'FlowMonitor':'info'
};
  
var productionDebug = {
   'BroDetect': 'error',
   'HostManager': 'error',
   'VpnManager': 'error',
   'AlarmManager': 'error',
   'Discovery': 'error',
   'Device Manager':'error',
   'DNSManager':'error',
   'FlowManager':'error',
   'intel':'error',
   'MessageBus':'error',
   'SysManager':'error',
   'PolicyManager':'error',
   'main':'error',
   'FlowMonitor':'error'
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

let fileTransport = null
let consoleTransport = null
let testTransport = null

function getFileTransport() {
  if(!fileTransport) {
    
    fileTransport = new (winston.transports.File)({
      level: 'info',
      name:'log-file',
      filename: process.title+".log",
      json: false,
      dirname: "/home/pi/logs",
      maxsize: 1000000,
      maxFiles: 3
    })
  }

  return fileTransport
}

function getConsoleTransport() {
  if(!consoleTransport) {
    const loglevel = 'info'
    if(production) 
      loglevel = 'error'
           
    consoleTransport = new(winston.transports.Console)({})
  }

  return consoleTransport
}

function getTestTransport() {
  if(!testTransport) {
    testTransport = new (winston.transports.File)
    ({level:'info',
      name:'log-file-test',
      filename: "test.log",
      dirname: "/home/pi/.forever",
      maxsize: 100000,
      maxFiles: 1,
      json: false,
      timestamp:true,
      colorize: true
    });
  }

  return testTransport
}

module.exports = function (component, loglevel, filename) {
  component = path.basename(component).split(".")[0].capitalizeFirstLetter();
  
  if(!loglevel) {
    loglevel = "info"; // default level info
  }

  if (debugMap[component]!=null) {
    return debugMap[component];
  }

    let _loglevel = debugMapper[component];
    
    if (_loglevel==null) {
        _loglevel = loglevel;
    }
    let consoleLogLevel = _loglevel;
    let fileLogLevel = _loglevel;
   
    if (production){
       consoleLogLevel = 'error';
    }
  
    let transports = [getFileTransport()];
 
    if (production == false && process.env.NODE_ENV !== 'test') {
        transports.push(getConsoleTransport());
    }
    
    if(process.env.NODE_ENV === 'test') {      
      transports.push(getTestTransport());
    }
  
	const { createLogger, format} = require('winston');
	const { combine, timestamp, label, printf } = format;

    const myFormat = printf(info => {
      return `${info.level.toUpperCase()} ${moment().format('YYYY-MM-DD hh:mm:ss')} ${info.label}: ${info.message}`;
    });

    let logger = createLogger({
      format: combine(
        label({label: component}),
        myFormat
      ),
      transports: transports,    
    })

    if (production == false && logger.transports.console) {
        logger.transports.console.level = _loglevel;
    }

    if (production == true) {
      for (key in winston.loggers.loggers) {
        winston.loggers.loggers[key].remove(winston.transports.Console);
      }
    }

    debugMap[component]=logger;
    return logger;
};
