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

const RECOVER_INTERVAL = 60 * 1000;

// winston 2.x drops every line once _failures reaches maxRetries and never retries on its own
function recoverWhenFailed(transport) {
  setInterval(() => {
    if (transport._failures >= transport.maxRetries) {
      // reset and reopen rather than rebuild, so the rotation counter (_created) is kept;
      // once('flush') listeners of errored streams never fire, drop them so they don't pile up
      transport.removeAllListeners('flush');
      transport._failures = 0;
      transport._createStream();
    }
  }, RECOVER_INTERVAL).unref();
}

function createFileTransport({ name, filename, dirname, maxsize, maxFiles, level, withLevel }) {
  const transport = new (winston.transports.File)({
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
  // winston emits 'error' once its retries are spent, and an unheard 'error' kills the process;
  // fail open instead: the line is dropped and the recovery tick reopens the file
  transport.on('error', () => {});
  recoverWhenFailed(transport);
  return transport;
}

module.exports = {
  createFileTransport
};
