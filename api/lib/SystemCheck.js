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

const bone = require("../../lib/Bone.js");

const CloudWrapper = require('../lib/CloudWrapper');
const cloudWrapper = new CloudWrapper();

const log = require("../../net2/logger.js")(__filename, 'info');

const sysManager = require('../../net2/SysManager.js');

const zlib = require('zlib');

function isInitialized(req, res, next) {
  if (bone.cloudready()==true &&
      // this is to ensure sysManager is already initliazed when called in API code
      sysManager.isConfigInitialized() &&
      req.params.gid) {

    let gid = req.params.gid;
    if (cloudWrapper.isGroupLoaded(gid)) {
      next();
      return;
    }
  }

  res.status(503);
  res.json({error: 'GID not exists, device may still in init phase, please try later!'});
}

function debugInfo(req, res, next) {
  if(req.body.message &&
    req.body.message.obj &&
    req.body.message.obj.data &&
    req.body.message.obj.data.item === "ping") {
    log.debug("Got a ping"); // ping is too frequent, reduce amount of log
  } else {
    log.debug("================= request from ", req.connection.remoteAddress, " =================");
    log.debug(JSON.stringify(req.body, null, '\t'));
    log.debug("================= request body end =================");
  }
  next();
}

function compressPayloadIfRequired(req, res, next) {
  let compressed = req.body.compressed || req.query.compressed;

  if(compressed) { // compress payload to reduce traffic
    log.debug("encipher uncompressed message size: ", res.body.length);
    const before = res.body.length;
    let input = Buffer.from(res.body, 'utf8');
    zlib.deflate(input, (err, output) => {
      if(err) {
        res.status(500).json({ error: err });
        return;
      }

      res.body = JSON.stringify({
        compressed: 1,
        payload: output.toString('base64')
      });
      const after = res.body.length;
      if(before !== 0) {
        const ratio = ((before - after) / before * 100).toFixed(1);
        log.debug(`Compression is enabled, size is reduced by ${ratio}%`);
      }
      log.debug("compressed message size: ", res.body.length);
      next();
    });
  } else {
    next();
  }
}

module.exports = {
  isInitialized: isInitialized,
  debugInfo: debugInfo,
  compressPayloadIfRequired: compressPayloadIfRequired
}
