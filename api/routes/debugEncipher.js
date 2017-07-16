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

let zlib = require('zlib');

router.post('/message/cleartext/:gid',
  function(req, res, next) {
    log.info("A new request");
    log.info("================= request body =================");
    log.info(JSON.stringify(req.body, null, '\t'));
    log.info("================= request body end =================");

    let gid = req.params.gid;
    let compressed = req.query.compressed;
    let controller = cloudWrapper.getNetBotController(gid);

    if(!controller) {
      res.status(404).send('');
      return;
    }
    var alreadySent = false;

    controller.msgHandler(gid, req.body, (err, response) => {
      if(alreadySent) {
        return;
      }

      alreadySent = true;

      if(err) {
        res.json({ error: err });
        return;
      } else {
        let json = JSON.stringify(response);
        log.info("Got response, length: ", json.length);

        if(compressed) { // compress payload to reduce traffic
          let input = new Buffer(json, 'utf8');
          zlib.deflate(input, (err, output) => {
            if(err) {
              res.status(500).json({ error: err });
              return;
            }

            res.status(200).json({
              payload: output.toString('base64')
            });
          });
        } else {
          res.json(response);
        }
      }
    });
  }
);

module.exports = router;
