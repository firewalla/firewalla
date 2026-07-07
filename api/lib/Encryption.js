/*    Copyright 2016-2022 Firewalla Inc.
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

const _ = require('lodash')
const crypto = require('crypto')

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

    // The IV (if any) is embedded in the message envelope ({ iv, message }).
    // A request that carries an iv signals a client that understands the scheme,
    // so the reply mirrors it with a fresh iv. Absent => legacy zero IV.
    try {
      const env = cloudWrapper.getCloud()._parseEnvelope(message);
      req.reqUsedIV = !!(env && env.iv != null);
    } catch (e) {
      req.reqUsedIV = false;
    }

    if(rkeyts) {
      const localRkeyts = cloudWrapper.getCloud().getRKeyTimestamp(gid);
      if(rkeyts !== localRkeyts) {
        log.error(`Unmatched rekey timestamp, likely the key is already rotated, app ts: ${new Date(rkeyts)}, box ts: ${new Date(localRkeyts)}`);
        res.status(412).json({status: "expired"});
        return;
      }
    }

    cloudWrapper.getCloud().decryptRequest(gid, message).then((decryptedMessage) => {
      decryptedMessage.mtype = decryptedMessage.message.mtype;
      req.body = decryptedMessage;
      req.id = _.get(decryptedMessage, [ 'message', 'obj', 'id' ], undefined)
      log.debug(req.id, 'Message decrypted')
      next();
    }).catch((err) => {
      if(err && err.message === "decrypt_error") {
        res.status(412).json({"error" : err});
      } else {
        res.status(400).json({"error" : err});
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

    // Only use a random IV in the reply when the client negotiated one on the
    // request (req.reqUsedIV) and this is not a streaming response. Streaming
    // stays on the legacy zero IV for now (its SSE frame carries no IV field).
    const useIV = req.reqUsedIV && !streaming;
    const ivBuf = useIV ? crypto.randomBytes(16) : null;

    // log.info('Response Data:', JSON.parse(body));
    const time = process.hrtime();
    cloudWrapper.getCloud().encryptResponse(gid, body, ivBuf).then((encryptedResponse) => {
      log.debug(`${req.id} Encrypt Cost Time: ${process.hrtime(time)[1]/1e6} ms`);

      if(streaming){
        res.body = encryptedResponse;
        next();
      } else {
        // encryptedResponse is the { iv, message } envelope when useIV, else
        // legacy bare base64; the iv travels inside message, not a top-level field.
        res.json({ message: encryptedResponse });
      }
    }).catch((err) => {
      res.json({error: err});
    });
  }
}
