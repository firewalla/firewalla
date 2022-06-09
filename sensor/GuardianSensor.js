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
const subMspListKey = "ext.guardian.sub.msp.list";
const rclient = require('../util/redis_manager.js').getRedisClient();
const license = require('../util/license.js');
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
    this.socketMap = {};
  }

  async apiRun() {
    extensionManager.onGet("guardianSocketioServer", (msg) => {
      return this.getServer();
    });

    extensionManager.onSet("guardianSocketioServer", async (msg, data) => {
      data.sub = true;
      if (await this.locked(data)) {
        throw new Error("Box had been locked");
      }
      return this.setServer(data);
    });

    extensionManager.onGet("guardian.business", async (msg) => {
      return this.getBusiness();
    });

    extensionManager.onGet("guardian.msps", (msg) => {
      return this.getMsps();
    })

    extensionManager.onSet("guardian.business", async (msg, data) => {
      data.sub = true;
      if (await this.locked(data)) {
        throw new Error("Box had been locked");
      }
      return this.setMsp(data);
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
      return this.reset(data);
    });

    extensionManager.onCmd("setAndStartGuardianService", async (msg, data) => {
      data.sub = true;
      if (await this.locked(data)) {
        throw new Error("Box had been locked");
      }
      await this.setServer(data);
      let msp;
      if (data.sub && data.id) {
        msp = await this.getSubMsp(data.id);
      } else {
        msp = await this.getMainMsp();
      }
      await this.start(msp);
    });

    await this.connectMsps();
    await this.handlLegacy();
  }
  async handlLegacy() {
    const msps = await this.getMsps();
    for (const msp of msps) {
      try {
        // box might be removed from msp but it was offline before
        // remove legacy settings to avoid the box been locked forever
        const { region, server, jwtToken, name, id, type } = msp;
        if (type == "msp" && jwtToken && server) {
          const licenseJSON = license.getLicense();
          const licenseString = licenseJSON && licenseJSON.DATA && licenseJSON.DATA.UUID;
          const uri = region ? `${server}/${region}/v1/binding/checkLicense/${licenseString}` : `${server}/v1/binding/checkLicense/${licenseString}`
          const options = {
            method: 'GET',
            family: 4,
            uri: uri,
            headers: {
              Authorization: `Bearer ${jwtToken}`,
              ContentType: 'application/json'
            },
            json: true
          }
          const result = await rp(options);
          log.info(`checkLicense on msp ${id}-${name}`, result);
          if (!result || result.id != id) {
            await this.reset(msp);
          }
        }
      } catch (e) {
        log.warn("Check license from msp error", e && e.message);
      }
    }
  }

  async setMsp(data) {
    const { sub, id } = data;
    if (sub) {
      const key = this.getSubMspInfoKey(id);
      await rclient.saddAsync(subMspListKey, id);
      await rclient.hmsetAsync(key, data);
    } else {
      await rclient.setAsync(configBizModeKey, JSON.stringify(data));
    }
  }

  async connectMsps() {
    const msps = await this.getMsps();
    await Promise.all(msps.map(msp => {
      return this.start(msp)
    }))
  }

  getSubMspInfoKey(mspId) {
    return `ext.guardian.sub.msp.${mspId}`;
  }

  async getSubMsp(id) {
    const key = this.getSubMspInfoKey(id);
    try {
      const msp = await rclient.hgetallAsync(key);
      return msp;
    } catch (e) {
      return null;
    }
  }

  async getMsps() {
    // get main msp (ext.guardian.business)
    const msps = [];
    const server = await this.getServer();
    const region = await this.getRegion();
    let mainMspInfo = await this.getBusiness();
    if (server && server.includes("my.firewalla.com")) {
      // set my.firewalla.com as a special msp too
      mainMspInfo = { id: "firewalla_web", name: "firewalla_web", type: "firewalla_web" }
    }
    if (mainMspInfo) {
      mainMspInfo.region = region;
      mainMspInfo.server = server;
      mainMspInfo.main = true;
      msps.push(mainMspInfo)
    }

    // get sub msp
    const ids = await rclient.zrangeAsync(subMspListKey, 0, -1);
    ids.map(async id => {
      const msp = await this.getSubMsp(id);
      msp && msps.push(msp);
    })
    return msps;
  }

  async getMainMsp() {
    const msps = await this.getMsps();
    const mainMsp = msps.find(msp => msp.main);
    !mainMsp && log.warn('There is no main msp, please check');
    return mainMsp;
  }

  async setServer(data) {
    const { server, region, id, sub } = data;
    if (!server) throw new Error("invalid server");
    if (sub) { // support multipe msps, can add sub msp to the sub msp list
      const key = this.getSubMspInfoKey(id);
      await rclient.hsetAsync(key, 'server', server);
    } else {
      if (region) {
        await rclient.setAsync(configRegionKey, region);
      } else {
        await rclient.unlinkAsync(configRegionKey);
      }
      return rclient.setAsync(configServerKey, server);
    }
  }

  async locked(options = {}) {
    const { id, force, sub } = options
    if (sub) return false; // if set sub msp, no lock
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

  async getServer() {
    const value = await rclient.getAsync(configServerKey);
    return value || "";
  }

  async getRegion() {
    return rclient.getAsync(configRegionKey);
  }

  async start(options) {
    if (!options) {
      options = await this.getMainMsp(); // main msp as default
    }
    const { server, region, name, id } = options;
    if (!server) {
      throw new Error("socketio server not set");
    }
    await this._stop(this.socketMap[id]);
    const gid = await et.getGID();
    const eid = await et.getEID();
    const socketPath = region ? `/${region}/socket.io` : '/socket.io'
    this.socketMap[id] = io(server, {
      path: socketPath,
      transports: ['websocket']
    });
    const socket = this.socketMap[id];
    if (!socket) {
      throw new Error("failed to init socket io");
    }
    socket.on('connect', () => {
      log.forceInfo(`Socket IO connection to ${name} ${server}, ${region} is connected.`, socket.id);
      socket.emit("box_registration", {
        gid: gid,
        eid: eid,
        mspId: id
      });
    });

    socket.on('disconnect', (reason) => {
      log.forceInfo(`Socket IO connection to ${name} ${server}, ${region} is disconnected. reason:`, reason);
    });

    const key = `send_to_box_${gid}`;
    socket.on(key, (message) => {
      if (message.gid === gid) {
        this.onMessage({ gid, message, socket: socket, mspId: id }).catch((err) => {
          log.error(`Failed to process message from group ${gid}`, err);
        });
      }
    })

    const liveKey = `realtime_send_to_box_${gid}`;
    socket.on(liveKey, (message) => {
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
            this.onRealTimeMessage({ gid, message, socket: socket, mspId: id }).catch((err) => {
              log.error(`Failed to process message from group ${gid}`, err);
            });
        }
      }
    })
  }

  _stop(socket) {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  }

  async stop(id) {
    if (!id) {
      const mainMspInfo = await this.getMainMsp();
      id = mainMspInfo.id;
    }
    const socket = this.socketMap[id];
    this._stop(socket);
  }

  async reset(options = {}) {
    const msps = await this.getMsps();
    let msp = msps.find(m => m.id == options.id)
    if (!options.id) msp = await this.getMainMsp(); // compatiable purpose
    if (msp.main) {
      await rclient.unlinkAsync(configServerKey);
      await rclient.unlinkAsync(configRegionKey);
      await rclient.unlinkAsync(configBizModeKey);
      await this.stop(msp.id);
    } else {
      const key = this.getSubMspInfoKey(msp.id);
      await rclient.unlinkAsync(key);
      await rclient.sremAsync(subMspListKey, msp.id);
      await this.stop(msp.id);
    }

    // no need to wait on this so that app/web can get the api response before key becomes invalid
    this.enable_key_rotation();
  }

  async enable_key_rotation() {
    await delay(10 * 1000);
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

  async onRealTimeMessage(options = {}) {
    const { gid, message, socket, mspId } = options
    if (this.realtimeRunning) {
      return;
    }

    const controller = await cw.getNetBotController(gid);
    this.realtimeRunning = true;

    if (controller && socket) {
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
            if (socket) {
              socket.emit("realtime_send_from_box", {
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

  async onMessage(options = {}) {
    const { gid, message, socket, mspId } = options;
    const controller = await cw.getNetBotController(gid);
    if (controller && socket) {
      const encryptedMessage = message.message;
      const replyid = message.replyid; // replyid will not encrypted
      let response, decryptedMessage, code = 200, encryptedResponse;
      try {
        decryptedMessage = await receicveMessageAsync(gid, encryptedMessage);
        decryptedMessage.mtype = decryptedMessage.message.mtype;
        response = await controller.msgHandlerAsync(gid, decryptedMessage, 'web');
        const input = Buffer.from(JSON.stringify(response), 'utf8');
        const output = await deflateAsync(input);
        const compressedResponse = JSON.stringify({
          compressed: 1,
          compressMode: 1,
          data: output.toString('base64')
        });
        encryptedResponse = await encryptMessageAsync(gid, compressedResponse);
      } catch (err) {
        log.warn(`Process web message error`, err);
        if (err && err.message == "decrypt_error") {
          code = 412; // "decryption error"
        } else {
          code = 500; // "Unknown error"
        }
      }

      try {
        if (socket) {
          socket.emit("send_from_box", {
            message: encryptedResponse,
            gid: gid,
            mspId: mspId,
            replyid: replyid,
            code: code
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
