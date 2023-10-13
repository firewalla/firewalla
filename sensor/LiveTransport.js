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

class LiveTransport {
  constructor(options) {
    this.socket = options.socket;
    this.alias = options.alias;
    this.message = options.message;
    this.mspId = options.mspId;
    this.gid = options.gid;
    this.replyid = options.replyid;
    this.guardianAlias = options.guardianAlias;
    this.delay = options.streaming.delay || 2; // 2 seconds
    this.expire = options.streaming.expire || 1 * 60; // 1 mins
  }

  isLivetimeValid() {
    return this.livetimeExpireDate && new Date() / 1000 < this.livetimeExpireDate;
  }

  setLivetimeExpirationDate() {
    const now = Date.now() / 1000;
    log.debug(`Extend live time for ${this.expire} seconds`);
    this.livetimeExpireDate = Math.floor(now) + this.expire; // extend expire date
  }

  resetLivetimeExpirationDate() {
    this.livetimeExpireDate = 0;
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
          try {
            const response = await controller.msgHandlerAsync(gid, message, 'web');
            message.message.suppressLog = true; // only log info one time then suppress
            response.item = this.alias;
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
              log.debug("response sent to back web cloud via live transport, req id:", this.replyid, this.guardianAlias);
            } catch (err) {
              log.error('Socket IO connection error', err);
            }
            await delay(this.delay * 1000);
          } catch (err) {
            log.error("Got error when handling request, err:", err);
            await delay(this.delay * 1000);
            break;
          }
        }
        this.livetimeRunning = false;
      }
    } catch (err) {
      log.error("Got error on live time message, err:", err);
    }
  }
}

module.exports = LiveTransport;