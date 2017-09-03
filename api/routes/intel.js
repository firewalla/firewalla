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

let log = require('../../net2/logger.js')(__filename);

let express = require('express');
let router = express.Router();
let bodyParser = require('body-parser')

let Promise = require('bluebird');

let async = require('asyncawait/async');
let await = require('asyncawait/await');



router.get('/:ip',
  (req, res, next) => {
    let ip = req.params.ip
    let force = req.query.force

    let options = {skipUpdate: true};

    if (force) {
      options = {
        forceUpdate: true
      };
    }

    let DestIPFoundHook = require('../../hook/DestIPFoundHook');
    let destIPFoundHook = new DestIPFoundHook();

    destIPFoundHook.processIP(ip, options) // do not store result in redis
      .then((json) => {
        res.json(json);
      }).catch((err) => {
        res.status(500).json({
          error: err
        });
      });
  });

module.exports = router;
