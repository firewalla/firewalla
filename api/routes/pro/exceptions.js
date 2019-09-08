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

const endpoint = '/' + require("path").basename(__filename, '.js');

module.exports = function(router, netbotHandler) {
    router.get(endpoint, (req, res) => {
      netbotHandler(req._gid, 'get', 
      {
        item: 'exceptions'
      }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });

    router.post(endpoint, (req, res) => {
      netbotHandler(req._gid, 'cmd', 
      {
        item: 'exception:create',
        value: req.body
      }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });

    router.put(endpoint + '/:eid', (req, res) => {
      let id = {eid: req.params.eid}
      netbotHandler(req._gid, 'cmd', 
      {
        item: 'exception:update',
        value: {...req.body, ...id}
      }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });

    router.delete(endpoint + '/:eid', (req, res) => {
      netbotHandler(req._gid, 'cmd', 
      {
        item: 'exception:delete',
        value: {exceptionID: req.params.eid}
      }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });
}
