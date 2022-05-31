/*    Copyright 2019-2022 Firewalla Inc.
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

const Sensor = require('./Sensor.js').Sensor

const fc = require('../net2/config.js')

const Promise = require('bluebird')
const extensionManager = require('./ExtensionManager.js')

const configServerKey = "ext.guardian.socketio.server";
const configRegionKey = "ext.guardian.socketio.region";
const configBizModeKey = "ext.guardian.business";
const configAdminStatusKey = "ext.guardian.socketio.adminStatus";

const rclient = require('../util/redis_manager.js').getRedisClient();
const license = require('../util/license.js')
const delay = require('../util/util.js').delay;
const io = require('socket.io-client');

const EncipherTool = require('../net2/EncipherTool.js');
const et = new EncipherTool();

const CloudWrapper = require('../api/lib/CloudWrapper.js');
const cw = new CloudWrapper();
const receicveMessageAsync = Promise.promisify(cw.getCloud().receiveMessage).bind(cw.getCloud());
const encryptMessageAsync = Promise.promisify(cw.getCloud().encryptMessage).bind(cw.getCloud());

const zlib = require('zlib');
const deflateAsync = Promise.promisify(zlib.deflate);
const rp = require('request-promise');
class GuardianSensor extends Sensor {
  constructor() {
    super();
    this.realtimeExpireDate = 0;
    this.realtimeRunning = 0;
  }

  async apiRun() {
    extensionManager.onGet("guardianSocketioServer", (msg) => {
      return this.getServer();
    });

    extensionManager.onSet("guardianSocketioServer", async (msg, data) => {
      if (await this.locked(data.id, data.force)) {
        throw new Error("Box had been locked");
      }
      return this.setServer(data.server, data.region);
    });

    extensionManager.onGet("guardian.business", async (msg) => {
      return this.getBusiness();
    });

    extensionManager.onSet("guardian.business", async (msg, data) => {
      if (await this.locked(data.id, data.force)) {
        throw new Error("Box had been locked");
      }
      await rclient.setAsync(configBizModeKey, JSON.stringify(data));
    });

    extensionManager.onGet("guardianSocketioRegion", (msg) => {
      return this.getRegion();
    });

    extensionManager.onCmd("startGuardianSocketioServer", (msg, data) => {
      return this.start();
    });

    extensionManager.onCmd("stopGuardianSocketioServer", (msg, data) => {
      return this.stop();
    });

    extensionManager.onCmd("resetGuardian", (msg, data) => {
      return this.reset();
    });

    extensionManager.onCmd("setAndStartGuardianService", async (msg, data) => {
      if (await this.locked(data.id, data.force)) {
        throw new Error("Box had been locked");
      }
      const socketioServer = data.server;
      if (!socketioServer) {
        throw new Error("invalid guardian relay server");
      }
      const forceRestart = !this.socket || (await this.getRegion() != data.region) || (await this.getServer() != socketioServer)
      await this.setServer(socketioServer, data.region);

      forceRestart && await this.start();
    });

    const adminStatusOn = await this.isAdminStatusOn();
    if (adminStatusOn) {
      await this.start();
    }
    await this.handlLegacy();
  }
  async handlLegacy() {
    try {
      // box might be removed from msp but it was offline before
      // remove legacy settings to avoid the box been locked forever
      const region = await this.getRegion();
      const server = await this.getServer();
      const business = await this.getBusiness();
      if (business && business.jwtToken && server) {
        const licenseJSON = license.getLicense();
        const licenseString = licenseJSON && licenseJSON.DATA && licenseJSON.DATA.UUID;
        const uri = region ? `${server}/${region}/v1/binding/checkLicense/${licenseString}` : `${server}/v1/binding/checkLicense/${licenseString}`
        const options = {
          method: 'GET',
          family: 4,
          uri: uri,
          headers: {
            Authorization: `Bearer ${business.jwtToken}`,
            ContentType: 'application/json'
          },
          json: true
        }
        const result = await rp(options)
        log.debug("checkLicense result", result)
        if (!result || result.id != business.id) {
          await this.reset();
        }
      }
    } catch (e) {
      log.warn("Check license from msp error", e && e.message);
    }
  }

  async setServer(server, region) {
    if (server) {
      if (region) {
        await rclient.setAsync(configRegionKey, region);
      } else {
        await rclient.unlinkAsync(configRegionKey);
      }
      return rclient.setAsync(configServerKey, server);
    } else {
      throw new Error("invalid server");
    }
  }

  async locked(id, force) {
    if (force) return false;
    const business = await this.getBusiness(); // if the box belong to MSP, deny from logging to other web container or my.firewalla.com
    if (business && business.type == 'msp' && business.id != id) {
      return true;
    }
    return false;
  }

  async getBusiness() {
    const data = await rclient.getAsync(configBizModeKey);
    if (!data) {
      return null;
    }
    try {
      return JSON.parse(data);
    } catch (err) {
      log.error(`Failed to parse data, err: ${err}`);
      return null;
    }
  }

  async getMspId() {
    const business = await this.getBusiness();
    const mspId = business ? business.id : "";
    return mspId;
  }

  async getServer() {
    const value = await rclient.getAsync(configServerKey);
    return value || "";
  }

  async getRegion() {
    return rclient.getAsync(configRegionKey);
  }

  async isAdminStatusOn() {
    const status = await rclient.getAsync(configAdminStatusKey);
    return status === '1';
  }

  async adminStatusOn() {
    return rclient.setAsync(configAdminStatusKey, '1');
  }

  async adminStatusOff() {
    return rclient.setAsync(configAdminStatusKey, '0');
  }

  async start() {
    const server = await this.getServer();
    if (!server) {
      throw new Error("socketio server not set");
    }

    await this._stop();

    await this.adminStatusOn();

    const gid = await et.getGID();
    const eid = await et.getEID();
    const mspId = await this.getMspId();

    const region = await this.getRegion();
    const socketPath = region ? `/${region}/socket.io` : '/socket.io'
    this.socket = io(server, {
      path: socketPath,
      transports: ['websocket']
    });
    if (!this.socket) {
      throw new Error("failed to init socket io");
    }

    this.socket.on('connect', () => {
      log.forceInfo(`Socket IO connection to ${server}, ${region} is connected.`);
      this.socket.emit("box_registration", {
        gid: gid,
        eid: eid,
        mspId: mspId
      });
    });

    this.socket.on('disconnect', (reason) => {
      log.forceInfo(`Socket IO connection to ${server}, ${region} is disconnected. reason:`, reason);
    });

    const key = `send_to_box_${gid}`;
    this.socket.on(key, (message) => {
      if (message.gid === gid) {
        this.onMessage(gid, message).catch((err) => {
          log.error(`Failed to process message from group ${gid}`, err);
        });
      }
    })

    const liveKey = `realtime_send_to_box_${gid}`;
    this.socket.on(liveKey, (message) => {
      if (message.gid === gid) {
        switch (message.action) {
          case "keepalive":
            this.setRealtimeExpirationDate();
            break;
          case "close":
            this.resetRealtimeExpirationDate();
            break;
          default:
            this.setRealtimeExpirationDate();
            this.onRealTimeMessage(gid, message).catch((err) => {
              log.error(`Failed to process message from group ${gid}`, err);
            });
        }
      }
    })
  }

  _stop() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  async stop() {
    await this.adminStatusOff();
    this._stop();
  }

  async reset() {
    log.info("Reset guardian settings");
    await rclient.unlinkAsync(configServerKey);
    await rclient.unlinkAsync(configRegionKey);
    await rclient.unlinkAsync(configBizModeKey);
    await rclient.unlinkAsync(configAdminStatusKey);
    this._stop();

    // no need to wait on this so that app/web can get the api response before key becomes invalid
    this.enable_key_rotation();
  }

  async enable_key_rotation() {
    await delay(5 * 1000);
    const gid = await et.getGID();
    await fc.enableDynamicFeature("rekey");
    await cw.getCloud().reKeyForAll(gid);
  }

  isRealtimeValid() {
    return this.realtimeExpireDate && new Date() / 1000 < this.realtimeExpireDate;
  }

  setRealtimeExpirationDate() {
    this.realtimeExpireDate = Math.floor(new Date() / 1000) + 300; // extend for 5 mins
  }

  resetRealtimeExpirationDate() {
    this.realtimeExpireDate = 0;
  }

  async onRealTimeMessage(gid, message) {
    if (this.realtimeRunning) {
      return;
    }

    const controller = await cw.getNetBotController(gid);
    const mspId = await this.getMspId();
    this.realtimeRunning = true;

    if (controller && this.socket) {
      const encryptedMessage = message.message;

      const rkeyts = message.rkeyts;

      if (rkeyts) {
        const localRkeyts = cw.getCloud().getRKeyTimestamp(gid);
        if (rkeyts !== localRkeyts) {
          log.error(`Unmatched rekey timestamp, likely the key is already rotated, app ts: ${new Date(rkeyts)}, box ts: ${new Date(localRkeyts)}`);
          return; // direct return without doing anything
        }
      }

      const decryptedMessage = await receicveMessageAsync(gid, encryptedMessage);
      decryptedMessage.mtype = decryptedMessage.message.mtype;
      decryptedMessage.obj.data.value.streaming = { id: decryptedMessage.message.obj.id };
      decryptedMessage.message.suppressLog = true; // reduce sse message

      while (this.isRealtimeValid()) {
        try {
          const response = await controller.msgHandlerAsync(gid, decryptedMessage, 'web');

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
              this.socket.emit("realtime_send_from_box", {
                message: encryptedResponse,
                gid: gid,
                mspId: mspId
              });
            }
            log.info("response sent back to web cloud via realtime, req id:", decryptedMessage.message.obj.id);
          } catch (err) {
            log.error('Socket IO connection error', err);
          }

          await delay(500); // self protection
        } catch (err) {
          log.error("Got error when handling request, err:", err);
          await delay(500); // self protection
          break;
        }
      }
      this.realtimeRunning = false;
    }
  }

  async onMessage(gid, message) {
    const controller = await cw.getNetBotController(gid);
    const mspId = await this.getMspId();
    if (controller && this.socket) {
      const encryptedMessage = message.message;
      let response, decryptedMessage;
      try {
        decryptedMessage = await receicveMessageAsync(gid, encryptedMessage);
        decryptedMessage.mtype = decryptedMessage.message.mtype;
        response = await controller.msgHandlerAsync(gid, decryptedMessage, 'web');
      } catch (err) {
        if (err && err.message == "decrypt_error") {
          response = { code: 412, msg: "decryption error" };
        } else {
          response = { code: 500, msg: "Unknown error" }
        }
      }
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
            mspId: mspId
          });
        }
        log.info("response sent to back web cloud, req id:", decryptedMessage ? decryptedMessage.message.obj.id : "decryption error");
      } catch (err) {
        log.error('Socket IO connection error', err);
      }
    }
  }
}

module.exports = GuardianSensor;
