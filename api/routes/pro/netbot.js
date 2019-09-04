/*    Copyright 2018-2019 Firewalla INC
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

let log = require('../../../net2/logger')(__filename);

const endpoint = '/' + require("path").basename(__filename, '.js');

module.exports = function(router, netbotHandler) {
    router.post(endpoint, (req, res) => {
      log.info('Handling msg to', req._gid, 'with body:', req.body)
      netbotHandler(req._gid, req.body.mtype, req.body.data).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });
}
