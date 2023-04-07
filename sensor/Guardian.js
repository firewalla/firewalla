/*    Copyright 2019-2023 Firewalla Inc.
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

const fc = require('../net2/config.js')

const Promise = require('bluebird')

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

const PolicyManager2 = require('../alarm/PolicyManager2.js');
const LiveTransport = require('./LiveTransport.js');
const pm2 = new PolicyManager2();

const FireRouter = require('../net2/FireRouter');
const _ = require('lodash');

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

module.exports = class {
  constructor(name, config = {}) {
    this.name = name;
    const suffix = this.getKeySuffix(name);
    this.configServerKey = `ext.guardian.socketio.server${suffix}`;
    this.configRegionKey = `ext.guardian.socketio.region${suffix}`;
    this.configBizModeKey = `ext.guardian.business${suffix}`;
    this.configAdminStatusKey = `ext.guardian.socketio.adminStatus${suffix}`;
    this.liveTransportCache = {};
    setInterval(() => {
      this.cleanupLiveTransport()
    }, (config.cleanInterval || 30) * 1000);
  }

  cleanupLiveTransport() {
    for (const alias in this.liveTransportCache) {
      const liveTransport = this.liveTransportCache[alias];
      if (!liveTransport.isLivetimeValid()) {
        log.info("Destory live transport for", alias);
        delete this.liveTransportCache[alias];
      }
    }
  }

  registerLiveTransport(options) {
    const alias = options.alias;
    if (!(alias in this.liveTransportCache)) {
      this.liveTransportCache[alias] = new LiveTransport(options);
    }

    return this.liveTransportCache[alias];
  }

  getKeySuffix(name) {
    if (name == "default") return '';
    return name ? `.${name.toLowerCase()}` : '';
  }

  async init() {
    const adminStatusOn = await this.isAdminStatusOn();
    if (adminStatusOn) {
      await this.start();
    }
    await this.handlLegacy();
  }

  scheduleCheck() {
    if (this.checkId) {
      clearTimeout(this.checkId);
    }
    this.checkId = setTimeout(async () => {
      await this.handlLegacy();
    }, 15 * 60 * 1000) // check every 15 mins
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
        if (!result || result.id != business.id) {
          log.forceInfo(`The box had removed from the ${business.name}-${business.id}, reset guardian ${this.name}`);
          await this.reset();
        }
      }
    } catch (e) {
      log.warn("Check license from msp error", e && e.message, this.name);
    }
  }

  async setServer(data) {
    if (await this.locked(data.id, data.force)) {
      throw new Error("Box had been locked");
    }
    const { server, region } = data;
    if (server) {
      if (region) {
        await rclient.setAsync(this.configRegionKey, region);
      } else {
        await rclient.unlinkAsync(this.configRegionKey);
      }
      return rclient.setAsync(this.configServerKey, server);
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
    const data = await rclient.getAsync(this.configBizModeKey);
    if (!data) {
      return null;
    }
    try {
      return JSON.parse(data);
    } catch (err) {
      log.error(`Failed to parse data, err: ${err}`, this.name);
      return null;
    }
  }

  async setBusiness(data) {
    if (await this.locked(data.id, data.force)) {
      throw new Error("Box had been locked");
    }
    await rclient.setAsync(this.configBizModeKey, JSON.stringify(data));
  }

  async getMspId() {
    const business = await this.getBusiness();
    const mspId = business ? business.id : "";
    return mspId;
  }

  async getServer() {
    const value = await rclient.getAsync(this.configServerKey);
    return value || "";
  }

  async getRegion() {
    return rclient.getAsync(this.configRegionKey);
  }

  async isAdminStatusOn() {
    const status = await rclient.getAsync(this.configAdminStatusKey);
    return status === '1';
  }

  async adminStatusOn() {
    return rclient.setAsync(this.configAdminStatusKey, '1');
  }

  async adminStatusOff() {
    return rclient.setAsync(this.configAdminStatusKey, '0');
  }

  async getGuardianInfo() {
    const server = await this.getServer();
    const region = await this.getRegion();
    const business = await this.getBusiness();
    if (business) delete business.jwtToken;
    return { server, region, business, alias: this.name };
  }

  async setAndStartGuardianService(data) {
    const socketioServer = data.server;
    if (!socketioServer) {
      throw new Error("invalid guardian relay server");
    }
    const forceRestart = !this.socket || (await this.getRegion() != data.region) || (await this.getServer() != socketioServer)
    await this.setServer(data);

    forceRestart && await this.start();
  }

  async start() {
    this.scheduleCheck();
    const server = await this.getServer();
    if (!server) {
      throw new Error("socketio server not set");
    }

    this._stop();

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
      log.forceInfo(`Socket IO connection to ${this.name} ${server}${region ? ", "+region : ""} is connected.`);
      this.socket.emit("box_registration", {
        gid: gid,
        eid: eid,
        mspId: mspId
      });
    });

    this.socket.on('disconnect', (reason) => {
      log.forceInfo(`Socket IO connection to ${this.name} ${server}${region ? ", "+region : ""} is disconnected. reason:`, reason);
    });

    const key = `send_to_box_${gid}`;
    this.socket.on(key, (message) => {
      if (message.gid === gid) {
        this.onMessage(gid, message).catch((err) => {
          log.error(`Failed to process message from group ${gid}`, err, this.name);
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
              log.error(`Failed to process message from group ${gid}`, err, this.name);
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
    log.info("Reset guardian settings", this.name);
    const mspId = await this.getMspId();
    try {
      // remove all msp related rules
      const policies = await pm2.loadActivePoliciesAsync();
      await Promise.all(policies.map(async p => {
        if (p.msp_rid && (p.msp_id == mspId ||
          p.mspId == mspId ||
          !p.msp_id // compatible purpose
        )) {
          await pm2.disableAndDeletePolicy(p.pid);
        }
      }))

      if (platform.isFireRouterManaged()) {
        // delete related mesh settings
        const networkConfig = await FireRouter.getConfig(true);

        const wireguard = networkConfig.interface.wireguard || {};
        let updateNetworkConfig = false;
        Object.keys(wireguard).map(intf => {
          if (wireguard[intf] && wireguard[intf].mspId == mspId) {
            networkConfig.interface.wireguard = _.omit(wireguard, intf);

            // delete dns config
            const dns = networkConfig.dns || {};
            networkConfig.dns = _.omit(dns, intf);

            // delete icmp config
            const icmp = networkConfig.icmp || {};
            networkConfig.icmp = _.omit(icmp, intf);

            // delete mdns_reflector config
            const mdns_reflector = networkConfig.mdns_reflector || {};
            networkConfig.mdns_reflector = _.omit(mdns_reflector, intf);

            // delete sshd config
            const sshd = networkConfig.sshd || {};
            networkConfig.sshd = _.omit(sshd, intf);

            // delete nat config
            const nat = networkConfig.nat || {};
            for (const key in nat) {
              if (key.startsWith(`${intf}-`)) {
                delete nat[key];
              }
            }
            networkConfig.nat = nat;
            updateNetworkConfig = true;
          }
        })
        if (updateNetworkConfig) {
          await FireRouter.setConfig(networkConfig);
        }
      }
    } catch (e) {
      log.warn('Clean msp rules failed', e);
    }

    await rclient.unlinkAsync(this.configServerKey);
    await rclient.unlinkAsync(this.configRegionKey);
    await rclient.unlinkAsync(this.configBizModeKey);
    await rclient.unlinkAsync(this.configAdminStatusKey);
    this._stop();

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
            log.info("response sent back to web cloud via realtime, req id:", decryptedMessage.message.obj.id, this.name);
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
    this.scheduleCheck(); // every time recived message, clean job and restart the check job
    const controller = await cw.getNetBotController(gid);
    const mspId = await this.getMspId();
    if (controller && this.socket) {
      const encryptedMessage = message.message;
      const replyid = message.replyid; // replyid will not encrypted
      let response, decryptedMessage, code = 200, encryptedResponse;
      try {
        decryptedMessage = await receicveMessageAsync(gid, encryptedMessage);
        decryptedMessage.mtype = decryptedMessage.message.mtype;
        const obj = decryptedMessage.message.obj;
        const item = obj.data.item;
        const value = JSON.parse(JSON.stringify(obj.data.value || {}))
        if (value.streaming) {
          const liveTransport = this.registerLiveTransport({
            alias: item,
            gid: gid,
            mspId: mspId,
            guardianAlias: this.name,
            message: decryptedMessage,
            streaming: value.streaming,
            replyid: replyid,
            socket: this.socket
          });
          switch (value.action) {
            case "keepalive":
              return liveTransport.setLivetimeExpirationDate();
            case "close":
              return liveTransport.resetLivetimeExpirationDate();
            default:
              return liveTransport.onLiveTimeMessage();
          }
        }
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
        if (this.socket) {
          this.socket.emit("send_from_box", {
            message: encryptedResponse,
            gid: gid,
            mspId: mspId,
            replyid: replyid,
            code: code
          });
        }
        log.info("response sent to back web cloud, req id:", decryptedMessage ? decryptedMessage.message.obj.id : "decryption error", this.name);
      } catch (err) {
        log.error('Socket IO connection error', err);
      }
    }
  }
}
