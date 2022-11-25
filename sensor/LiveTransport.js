/*    Copyright 2022 Firewalla INC
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

const log = require('../net2/logger.js')(__filename)


const Promise = require('bluebird')
const delay = require('../util/util.js').delay;

const CloudWrapper = require('../api/lib/CloudWrapper.js');
const cw = new CloudWrapper();
const encryptMessageAsync = Promise.promisify(cw.getCloud().encryptMessage).bind(cw.getCloud());

const zlib = require('zlib');
const deflateAsync = Promise.promisify(zlib.deflate);

let instance = null;

class LiveTransport {
  constructor(options) {
    if (instance === null) {
      instance = this;
      this.fastModeDelay = options.fastModeDelay || 2; // 2 seconds
      this.slowModeDelay = options.slowModeDelay || 60; // 60 seconds
      this.fastModeExpire = options.fastModeExpire || 5 * 60; // 5 mins
      this.slowModeExpire = options.slowModeExpire || 0; // default disabled
      this.socket = options.socket;
      this.item = options.item;
      this.message = options.message;
      this.mspId = options.mspId;
      this.gid = options.gid;
      this.replyid = options.replyid;
    }
    return instance;
  }

  isLivetimeValid() {
    return this.livetimeExpireDate && new Date() / 1000 < this.livetimeExpireDate;
  }

  setLivetimeExpirationDate() {
    const now = Date.now() / 1000;
    const extendTime = this.fastModeExpire + this.slowModeExpire;
    this.livetimeExpireDate = Math.floor(now) + extendTime; // extend expire date
    this.livetimeRecordDate = now;
  }

  resetRealtimeExpirationDate() {
    this.realtimeExpireDate = 0;
  }

  getDelay() {
    const now = Date.now() / 1000;
    // if still under fast mode time range, send message back every 2 second
    // otherwise 1 min
    const delay = now - this.livetimeRecordDate < this.fastModeExpire ? this.fastModeDelay : this.slowModeDelay;
    return delay * 1000 || 1000; // default 2 second for self protection
  }

  async onLiveTimeMessage() {
    try {
      this.setLivetimeExpirationDate();
      if (this.livetimeRunning) {
        return;
      }
      const gid = this.gid;
      const message = this.message;
      const controller = await cw.getNetBotController(gid);
      const mspId = this.mspId;
      const replyid = this.replyid;
      this.livetimeRunning = true;
      if (controller && this.socket) {
        while (this.isLivetimeValid()) {
          const delayTime = this.getDelay();
          try {
            const response = await controller.msgHandlerAsync(gid, message, 'web');
            response.item = this.item;
            const input = Buffer.from(JSON.stringify(response), 'utf8');
            const output = await deflateAsync(input);
            const compressedResponse = JSON.stringify({
              compressed: 1,
              compressMode: 1,
              data: output.toString('base64')
            });
            const encryptedResponse = await encryptMessageAsync(gid, compressedResponse);
            try {
              if (this.socket) {
                this.socket.emit("send_from_box", {
                  message: encryptedResponse,
                  gid: gid,
                  mspId: mspId,
                  replyid: replyid
                });
              }
              log.info("response sent to back web cloud via live transport, req id:", message ? message.message.obj.id : "decryption error", this.name);
            } catch (err) {
              log.error('Socket IO connection error', err);
            }
            await delay(delayTime);
          } catch (err) {
            log.error("Got error when handling request, err:", err);
            await delay(delayTime);
            break;
          }
        }
        this.livetimeRunning = false;
      }
    } catch (e) {
      log.error("Got error on live time message, err:", err);
    }
  }
}

module.exports = LiveTransport;