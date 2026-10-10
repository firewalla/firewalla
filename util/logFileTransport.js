/*    Copyright 2026 Firewalla Inc.
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

'use strict'

const winston = require('winston');
const moment = require('moment');

function createFileTransport({ name, filename, dirname, maxsize, maxFiles, level, withLevel }) {
  return new (winston.transports.File)({
    level,
    name,
    filename,
    json: false,
    dirname,
    maxsize,
    maxFiles,
    timestamp: function () {
      return moment().format('YYYY-MM-DD HH:mm:ss')
    },
    formatter: function (options) {
      return options.timestamp() + ' ' +
        (withLevel ? options.level.toUpperCase() + ' ' : '') +
        (options.message ? options.message : '') +
        (options.meta && Object.keys(options.meta).length ? '\n\t' + JSON.stringify(options.meta) : '');
    }
  })
}

module.exports = {
  createFileTransport
};
