/*    Copyright 2019-2021 Firewalla Inc.
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

const Promise = require('bluebird')
const extensionManager = require('./ExtensionManager.js')

const configServerKey = "ext.guardian.socketio.server";
const configRegionKey = "ext.guardian.socketio.region";
const configBizModeKey = "ext.guardian.business";
const configAdminStatusKey = "ext.guardian.socketio.adminStatus";

const rclient = require('../util/redis_manager.js').getRedisClient();

const io = require('socket.io-client');

const EncipherTool = require('../net2/EncipherTool.js');
const et = new EncipherTool();

const CloudWrapper = require('../api/lib/CloudWrapper.js');
const cw = new CloudWrapper();
const receicveMessageAsync = Promise.promisify(cw.getCloud().receiveMessage).bind(cw.getCloud());
const encryptMessageAsync = Promise.promisify(cw.getCloud().encryptMessage).bind(cw.getCloud());

const zlib = require('zlib');
const deflateAsync = Promise.promisify(zlib.deflate);

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

    extensionManager.onSet("guardianSocketioServer", (msg, data) => {
      return this.setServer(data.server, data.region);
    });

    extensionManager.onGet("guardian.business", async (msg) => {
      const data = await rclient.getAsync(configBizModeKey);
      if(!data) {
        return null;
      }

      try {
        return JSON.parse(data);
      } catch(err) {
        log.error(`Failed to parse data, err: ${err}`);
        return null;
      }
    });

    extensionManager.onSet("guardian.business", async (msg, data) => {
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

    extensionManager.onCmd("setAndStartGuardianService", async (msg, data) => {
      const socketioServer = data.server;
      if(!socketioServer) {
        throw new Error("invalid guardian relay server");
      }
      const forceRestart = !this.socket || (await this.getRegion() != data.region) || (await this.getServer() != socketioServer)
      await this.setServer(socketioServer, data.region);
      
      forceRestart && await this.start();
    });

    const adminStatusOn = await this.isAdminStatusOn();
    if(adminStatusOn) {
      await this.start();
    }
  }

  async setServer(server, region) {
    if(server) {
      if(region) {
        await rclient.setAsync(configRegionKey, region);
      } else {
        await rclient.delAsync(configRegionKey);
      }
      return rclient.setAsync(configServerKey, server);
    } else {
      throw new Error("invalid server");
    }    
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
    if(!server) {
      throw new Error("socketio server not set");
    }

    await this._stop();

    await this.adminStatusOn();

    const gid = await et.getGID();
    const eid = await et.getEID();

    const region = await this.getRegion();
    const socketPath = region?`/${region}/socket.io`:'/socket.io'
    this.socket = io(server, {
      path: socketPath,
      transports: ['websocket']
    });
    if(!this.socket) {
      throw new Error("failed to init socket io");
    }

    this.socket.on('connect', () => {
      log.forceInfo(`Socket IO connection to ${server}, ${region} is connected.`);
      this.socket.emit("box_registration", {
        gid: gid,
        eid: eid
      });
    });

    this.socket.on('disconnect', (reason) => {
      log.forceInfo(`Socket IO connection to ${server}, ${region} is disconnected. reason:`, reason);
    });

    const key = `send_to_box_${gid}`;
    this.socket.on(key, (message) => {
      if(message.gid === gid) {
        this.onMessage(gid, message).catch((err) => {
          log.error(`Failed to process message from group ${gid}`, err);
        });
      }
    })

    const liveKey = `realtime_send_to_box_${gid}`;
    this.socket.on(liveKey, (message) => {
      if(message.gid === gid) {
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

  async _stop() {
    if(this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  async stop() {
    await this.adminStatusOff();
    return this._stop();
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
    if(this.realtimeRunning) {
      return;
    }

    const controller = await cw.getNetBotController(gid);

    this.realtimeRunning = true;

    if(controller && this.socket) {
      const encryptedMessage = message.message;
      const decryptedMessage = await receicveMessageAsync(gid, encryptedMessage);
      decryptedMessage.mtype = decryptedMessage.message.mtype;
      decryptedMessage.obj.data.value.streaming = {id: decryptedMessage.message.obj.id};
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
                gid: gid
              });
            }
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

    if(controller && this.socket) {
      const encryptedMessage = message.message;
      const decryptedMessage = await receicveMessageAsync(gid, encryptedMessage);
      decryptedMessage.mtype = decryptedMessage.message.mtype;
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
          this.socket.emit("send_from_box", {
            message: encryptedResponse,
            gid: gid
          });
        }
      } catch (err) {
        log.error('Socket IO connection error',err);
      }
    }
  }
}

module.exports = GuardianSensor;
