'use strict'
/*    Copyright 2016 Rottiesoft LLC 
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
   'FlowMonitory':'info'
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
   'FlowMonitory':'error'
};
  

var debugMapper = devDebug;
if (process.env.FWPRODUCTION) {
    debugMapper = productionDebug; 
    console.log("FWDEBUG SET TO PRODUCTION");
}

module.exports = function (component, loglevel) {
    let _loglevel = debugMapper[component];
    if (_loglevel==null) {
        _loglevel = loglevel;
    }
    var logger = new(winston.Logger)({
        transports: [
            new(winston.transports.Console)({
                level: _loglevel,
                'timestamp': true
            }),
            /*
            new (winston.transports.File)({level:fileloglevel,
                                       name:'log-file',
                                       filename: 'net.log',
                                       dirname: ".",
                                       maxsize: 1000,
                                       maxFiles: 10,
                                       timestamp:true })
*/
        ]
    });

    logger.transports.console.level = _loglevel;
    return logger;
};
