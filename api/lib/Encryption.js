/*    Copyright 2016-2021 Firewalla Inc.
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

const CloudWrapper = require('../lib/CloudWrapper');
const cloudWrapper = new CloudWrapper();

let instance = null;
const log = require("../../net2/logger.js")(__filename);

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  decrypt(req, res, next) {
    let gid = req.params.gid;
    let message = req.body.message;
    let rkeyts = req.body.rkeyts;

    if(gid == null) {
      res.status(400);
      res.json({"error" : "Invalid group id"});
      return;
    }

    if(message == null) {
      res.status(400);
      res.json({"error" : "Invalid request"});
      return;
    }

    if(rkeyts) {
      const localRkeyts = cloudWrapper.getCloud().getRKeyTimestamp(gid);
      if(rkeyts !== localRkeyts) {
        log.error(`Unmatched rekey timestamp, likely the key is already rotated, app ts: ${new Date(rkeyts)}, box ts: ${new Date(localRkeyts)}`);
        res.status(412).json({status: "expired"});
        return;
      }
    }

    cloudWrapper.getCloud().receiveMessage(gid, message, (err, decryptedMessage) => {
      if(err) {
        res.status(400).json({"error" : err});
        return;
      } else {
        decryptedMessage.mtype = decryptedMessage.message.mtype;
        req.body = decryptedMessage;
        next();
      }
    });
  }

  encrypt(req, res, next, streaming = false) {
    let gid = req.params.gid;
    if(gid == null) {
      res.json({"error" : "Invalid group id"});
      return;
    }

    let body = res.body;

    if(body == null) {
      res.json({"error" : "Response error"});
      return;
    }

    // log.info('Response Data:', JSON.parse(body));
    const time = process.hrtime();
    cloudWrapper.getCloud().encryptMessage(gid, body, (err, encryptedResponse) => {
      log.debug('EncryptMessage Cost Time:', `${process.hrtime(time)[1]/1e6} ms`);

      if(err) {
        res.json({error: err});
        return;
      } else {
        if(streaming){
          res.body = encryptedResponse;
          next();
        }else{
          res.json({ message : encryptedResponse });
        }
      }
    });
  }
}
