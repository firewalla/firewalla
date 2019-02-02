/*    Copyright 2016 Firewalla LLC
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

const rclient = require('../util/redis_manager.js').getRedisClient();

const io = require('socket.io-client');

const EncipherTool = require('../net2/EncipherTool.js');
const et = new EncipherTool();

const CloudWrapper = require('../api/lib/CloudWrapper.js');
const cw = new CloudWrapper();
const receicveMessageAsync = Promise.promisify(cw.getCloud().receiveMessage);
const encryptMessageAsync = Promise.promisify(cloudWrapper.getCloud().encryptMessage);

const zlib = require('zlib');
const deflateAsync = Promise.promisify(zlib.deflate);

class GuardianSensor extends Sensor {
  constructor() {
    super();
  }

  apiRun() {
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
  }

  async setServer(server) {
    if(server) {
      return rclient.setAsync(configServerKey, server);
    } else {
      throw new Error("invalid server");
    }
  }

  async getServer() {
    const value = await rclient.getAsync(configServerKey, server);
    return value || "";
  }

  async start() {
    const server = await this.getServer();
    if(!server) {
      throw new Error("socketio server not set");
    }

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

  async stop() {
    this.socket.disconnect();
    this.socket = null;
  }

  async onMessage(gid, message) {
    const controller = cw.getNetBotController(gid);

    if(controller && this.socket) {
      const encryptedMessage = message.message;
      const decryptedMessage = await receicveMessageAsync(gid, encryptedMessage);
      decryptedMessage.mtype = decryptedMessage.message.mtype;
      const response = await controller.msgHandlerAsync(gid, decryptedMessage);

      const input = new Buffer(response, 'utf8');
      const output = deflateAsync(input);

      const compressedResponse = JSON.stringify({
        compressed: 1,
        payload: output.toString('base64')
      });

      const encryptedResponse = encryptMessageAsync(compressedResponse);

      this.socket.emit("send_from_box", {
        message: encryptedMessage,
        gid: gid
      });
    }
  }
}

module.exports = GuardianSensor;
