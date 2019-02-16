/*    Copyright 2019 Firewalla LLC
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

const sem = require('../sensor/SensorEventManager.js').getInstance()

const Promise = require('bluebird')
const extensionManager = require('./ExtensionManager.js')

const fc = require('../net2/config.js')

const configServerKey = "ext.guardian.socketio.server";
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
  }

  async apiRun() {
    extensionManager.onGet("guardianSocketioServer", (msg) => {
      return this.getServer();
    })

    extensionManager.onSet("guardianSocketioServer", (msg, data) => {
      return this.setServer(data.server);
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

      await this.setServer(socketioServer);
      
      await this.start();
    });

    const adminStatusOn = await this.isAdminStatusOn();
    if(adminStatusOn) {
      await this.start();
    }
  }

  async setServer(server) {
    if(server) {
      return rclient.setAsync(configServerKey, server);
    } else {
      throw new Error("invalid server");
    }
  }

  async getServer() {
    const value = await rclient.getAsync(configServerKey);
    return value || "";
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

    this.socket = io.connect(server);
    if(!this.socket) {
      throw new Error("failed to init socket io");
    }

    const gid = await et.getGID();
    const key = `send_to_box_${gid}`;
    this.socket.on(key, (message) => {
      if(message.gid === gid) {
        this.onMessage(gid, message);
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

  async onMessage(gid, message) {
    const controller = await cw.getNetBotController(gid);

    if(controller && this.socket) {
      const encryptedMessage = message.message;
      const decryptedMessage = await receicveMessageAsync(gid, encryptedMessage);
      decryptedMessage.mtype = decryptedMessage.message.mtype;
      const response = await controller.msgHandlerAsync(gid, decryptedMessage);

      const input = new Buffer(JSON.stringify(response), 'utf8');
      const output = await deflateAsync(input);

      const compressedResponse = JSON.stringify({
        compressed: 1,
        compressMode: 1,
        data: output.toString('base64')
      });

      const encryptedResponse = await encryptMessageAsync(gid, compressedResponse);

      this.socket.emit("send_from_box", {
        message: encryptedResponse,
        gid: gid
      });
    }
  }
}

module.exports = GuardianSensor;
