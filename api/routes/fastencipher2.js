/*    Copyright 2016-2020 Firewalla Inc.
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
const express = require('express');
const router = express.Router();

const Encryption = require('../lib/Encryption'); // encryption middleware
const encryption = new Encryption();

const CloudWrapper = require('../lib/CloudWrapper');
const cloudWrapper = new CloudWrapper();

const log = require('../../net2/logger.js')(__filename, "info");

const sc = require('../lib/SystemCheck.js');

/* IMPORTANT
 * -- NO AUTHENTICATION IS NEEDED FOR URL /message
 * -- message is encrypted already
 */
router.post('/message/:gid',
    sc.isInitialized,
    encryption.decrypt,
    sc.debugInfo,

    (req, res, next) => {
      const gid = req.params.gid;

      (async() =>{
        const time = process.hrtime();
        const controller = await cloudWrapper.getNetBotController(gid);
        const response = await controller.msgHandlerAsync(gid, req.body);
        log.info('API Cost Time:', `${process.hrtime(time)[1]/1e6} ms`);
        res.body = JSON.stringify(response);
        next();
      })()
        .catch((err) => {
          // netbot controller is not ready yet, waiting for init complete
          log.error("Got error when handling api call from app", err, err.stack);
          res.status(503);
          res.json({error: 'Initializing Firewalla Device, please try later'});
        });
    },

    sc.compressPayloadIfRequired,
    encryption.encrypt
);

log.info("==============================")
log.info("FireAPI started successfully")
log.info("==============================")

module.exports = {
  router:router,
  cloudWrapper:cloudWrapper
};
