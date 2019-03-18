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

'use strict'

let express = require('express');
let router = express.Router();
let bodyParser = require('body-parser')

let HostTool = require('../../net2/HostTool.js')
let hostTool = new HostTool();

router.post('/:mac',
  (req, res, next) => {
    let mac = req.params.mac;
    let action = req.query.action;
    let name = req.query.name;

    hostTool.macExists(mac)
      .then((result) => {
        if(!result) {
          res.status(404).send("");
          return;
        }

        switch(action) {
          case "update_bname":
            hostTool.updateBackupName(mac, name)
              .then(() => {
                res.status(200).json({status: "success"})
                return;
              }).catch((err) => {
                res.status(500).json({error: err});
            })
            break;
          default:
            break;
        }
      })
});


module.exports = router;
