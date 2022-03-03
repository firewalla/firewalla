/*    Copyright 2020-2022 Firewalla Inc.
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
var express = require('express');
var router = express.Router();

var CloudWrapper = require('../lib/CloudWrapper');
var cloudWrapper = new CloudWrapper();

let log = require('../../net2/logger.js')(__filename, "info");

let sc = require('../lib/SystemCheck.js');

router.post('/message/:gid',

  sc.debugInfo,

  (req, res, next) => {

    const localIPs = ["127.0.0.1", "::ffff:127.0.0.1"];

    if(!localIPs.includes(req.connection.remoteAddress)) { // this api can only be used for local access
      res.status(404).send("");
      return;
    }

    let gid = req.params.gid;

    (async() =>{
      let controller = await cloudWrapper.getNetBotController(gid)
      let response = await controller.msgHandlerAsync(gid, req.body)
      res.body = JSON.stringify(response);
      next();
    })()
      .catch((err) => {
        // netbot controller is not ready yet, waiting for init complete
        log.error(err);
        res.status(503);
        res.json({error: 'Initializing Firewalla Device, please try later'});
      });
  },

  sc.compressPayloadIfRequired,

  (req, res, next) => {
    res.type('json');
    res.send(res.body);
  }
);

module.exports = router;
