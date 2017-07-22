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
let express = require('express');
let router = express.Router();

let Encryption = require('../lib/Encryption'); // encryption middleware
let encryption = new Encryption();

let CloudWrapper = require('../lib/CloudWrapper');
let cloudWrapper = new CloudWrapper();

let f = require('../../net2/Firewalla.js');

let log = require('../../net2/logger.js')(__filename, "info");

let sc = require('../lib/SystemCheck.js');

let zlib = require('zlib');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

function _debugInfo(req, res, next) {
  if(req.body.message &&
    req.body.message.obj &&
    req.body.message.obj.data &&
    req.body.message.obj.data.item === "ping") {
    log.debug("Got a ping"); // ping is too frequent, reduce amount of log
  } else {
    log.info("================= request from ", req.connection.remoteAddress, " =================");
    log.info(JSON.stringify(req.body, null, '\t'));
    log.info("================= request body end =================");
  }
  next();
}

function compressPayloadIfRequired(req, res, next) {
  let compressed = req.body.compressed;

  if(compressed) { // compress payload to reduce traffic
    log.debug("encipher uncompressed message size: ", res.body.length, {});
    let input = new Buffer(res.body, 'utf8');
    zlib.deflate(input, (err, output) => {
      if(err) {
        res.status(500).json({ error: err });
        return;
      }

      res.body = JSON.stringify({payload: output.toString('base64')});
      log.debug("compressed message size: ", res.body.length, {});
      next();
    });
  } else {
    next();
  }
}

/* IMPORTANT 
 * -- NO AUTHENTICATION IS NEEDED FOR URL /message 
 * -- message is encrypted already 
 */
router.post('/message/:gid',
    sc.isInitialized,
    encryption.decrypt,
    _debugInfo,
    
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
  
    compressPayloadIfRequired,
    encryption.encrypt
);

module.exports = router;
