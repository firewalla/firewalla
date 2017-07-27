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
'use strict';
var express = require('express');
var router = express.Router();
const passport = require('passport')

var Encryption = require('../lib/Encryption'); // encryption middleware
var encryption = new Encryption();

var CloudWrapper = require('../lib/CloudWrapper');
var cloudWrapper = new CloudWrapper();

let f = require('../../net2/Firewalla.js');

let log = require('../../net2/logger.js')(__filename, "info");

let sc = require('../lib/SystemCheck.js');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

router.post('/message/:gid',

  sc.debugInfo,

  (req, res, next) => {

    let gid = req.params.gid;

    async(() => {
      let controller = await(cloudWrapper.getNetBotController(gid));
      let response = await(controller.msgHandlerAsync(gid, req.body));
      res.body = JSON.stringify(response);
      next();
    })()
      .catch((err) => {
        // netbot controller is not ready yet, waiting for init complete
        res.status(503);
        res.json({error: 'Initializing Firewalla Device, please try later'});
      });
  },

  sc.compressPayloadIfRequired,

  (req, res, next) => {
    res.send();
  }
);

module.exports = router;
