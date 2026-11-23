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

'use strict';

const util = require('util');
const rp = util.promisify(require('request'));

// 504 on a timeout, 503 on any other transport error
function gatewayErrorCode(err) {
  if (err.message === 'ESOCKETTIMEDOUT' || err.message === 'ETIMEDOUT')
    return 504;
  return 503;
}

// a REST call to a local daemon (fwapc, dap, vulcan); never rejects, returns {code, body, msg}
async function call(baseUrl, method, path, body, { timeout, errorCode }) {
  const options = {
    method: method,
    headers: {
      "Accept": "application/json"
    },
    timeout: timeout,
    url: baseUrl + path,
    json: true
  };

  if (body) {
    options.body = body;
  }
  try {
    const resp = await rp(options);
    const r = { code: resp.statusCode, body: resp.body };
    if (resp.statusCode === 500) {
      r.msg = resp.body;
    }
    return r;
  } catch (e) {
    return { code: errorCode(e), msg: e.message };
  }
}

module.exports = {
  call,
  gatewayErrorCode
};
