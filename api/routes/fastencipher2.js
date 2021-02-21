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
const delay = require('../../util/util.js').delay;
const log = require('../../net2/logger.js')(__filename, "info");

const sc = require('../lib/SystemCheck.js');

/* IMPORTANT
 * -- NO AUTHENTICATION IS NEEDED FOR URL /message
 * -- message is encrypted already
 */

const msgHandler = (req, res, next) => {
  const gid = req.params.gid;
  log.info('jack test req.body in msgHandler', req.body);
  const streaming = (req.body.message && req.body.message.obj && req.body.message.obj.streaming) || false;
  res.socket.on('close', () => {
    log.info("connection is closed:", req.headers['x-forwarded-for'] || req.connection.remoteAddress);
    res.is_closed = true;
  });
  (async () => {
    if (streaming) {
      res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
      });
      res.flushHeaders();
      while (streaming && !res.is_closed) {
        try {
          const controller = await cloudWrapper.getNetBotController(gid);
          const response = await controller.msgHandlerAsync(gid, req.body);
          res.body = JSON.stringify(response);
          next();
          await delay(200); // self protection
        } catch (err) {
          log.error("Got error when handling request, err:", err);
          res.write('id:-1\nevent:message\ndata:\n\n'); // client listen for "end of event stream" and close sse
          res.end();
          break;
        }
      }
    } else {
      const time = process.hrtime();
      const controller = await cloudWrapper.getNetBotController(gid);
      const response = await controller.msgHandlerAsync(gid, req.body);
      log.info('API Cost Time:', `${process.hrtime(time)[1] / 1e6} ms`);
      res.body = JSON.stringify(response);
      next();
    }
  })()
    .catch((err) => {
      // netbot controller is not ready yet, waiting for init complete
      log.error("Got error when handling api call from app", err, err.stack);
      res.status(503);
      res.json({ error: 'Initializing Firewalla Device, please try later' });
    });
}
const handlers = [sc.isInitialized, encryption.decrypt, sc.debugInfo,
  msgHandler, sc.compressPayloadIfRequired];

const convertMessageToBody = function (req, res, next) {
  try {
    let encryptedMessage = req.query.message;
    log.info('jack test encryptedMessage', encryptedMessage);
    encryptedMessage = encryptedMessage.replace(/\s/g, '+');
    log.info('jack test encryptedMessage', encryptedMessage);
    req.body = JSON.parse(encryptedMessage);
    log.info('jack test req.body', req.body);
    next();
  } catch (e) {
    log.error('parse encryptedMessage in path error', e);
    res.status(400);
    res.json({ "error": "Invalid mesasge" });
    return;
  }
}

router.post('/message/:gid', handlers, encryption.encrypt);
router.get('/message/:gid', convertMessageToBody, handlers, (req, res, next) => {
  encryption.encrypt(req, res, next, true);
});

log.info("==============================")
log.info("FireAPI started successfully")
log.info("==============================")

module.exports = {
  router: router,
  cloudWrapper: cloudWrapper
};
