'use strict'

/*    Copyright 2020 Firewalla Inc.
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
const moment = require('moment');
const winston = require('winston');
const { argumentsToString } = require('./util.js');

function getFileTransport() {
  return new (winston.transports.File)({
    name: 'log-file',
    filename: "Accounting.log",
    json: false,
    dirname: "/home/pi/logs",
    maxsize: 10000000,
    maxFiles: 3,
    timestamp: function () {
      return moment().format('YYYY-MM-DD HH:mm:ss')
    },
    formatter: function (options) {
      // - Return string will be passed to logger.
      // - Optionally, use options.colorize(options.level, <string>) to
      //   colorize output based on the log level.
      return options.timestamp() + ' ' +
        (options.message ? options.message : '') +
        (options.meta && Object.keys(options.meta).length ? '\n\t' + JSON.stringify(options.meta) : '');
    }
  })
}
const logger = new (winston.Logger)({
  transports: [getFileTransport()]
});
module.exports = function () {
  logger.log.apply(logger, ["info", argumentsToString(arguments)]);
};
