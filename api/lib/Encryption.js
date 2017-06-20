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

var CloudWrapper = require('../lib/CloudWrapper');
var cloudWrapper = new CloudWrapper();

var instance = null;
var log = null;

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("../../net2/logger.js")("encryption", loglevel);
            instance = this;
        }
        return instance;
    }

    decrypt(req, res, next) {
      var gid = req.params.gid;
      if(gid == null) {
        res.status(400);
        res.json({"error" : "Invalid group id"});
        return;
      }

      let controller = cloudWrapper.getNetBotController(gid);
      if(!controller) {
        // netbot controller is not ready yet, waiting for init complete
        res.status(503);
        res.json({error: 'Initializing Firewalla Device, please try later'});
        return;
      }
      
      var message = req.body.message;
      
      if(message == null) {
        res.status(400);
        res.json({"error" : "Invalid request"});
        return;
      }      

      cloudWrapper.getCloud().receiveMessage(gid, message, (err, decryptedMessage) => {
        if(err) {
            res.json({"error" : err});
            return;
        } else {
          decryptedMessage.mtype = decryptedMessage.message.mtype;
          req.body = decryptedMessage;
          next();
        }
      });
    }

    encrypt(req, res, next) {
      var gid = req.params.gid;
      if(gid == null) {
        res.json({"error" : "Invalid group id"});
        return;
      }

      var body = res.body;

      if(body == null) {
        res.json({"error" : "Response error"});
        return;
      }

      cloudWrapper.getCloud().encryptMessage(gid, body, (err, encryptedResponse) => {
          if(err) {
              res.json({error: err});
              return;
          } else {
              res.json({ message : encryptedResponse });
          }
      });
    }
}
