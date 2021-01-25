/*    Copyright 2020 Firewalla Inc
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

const log = require('./logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('./Firewalla.js');
const sysManager = require('./SysManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('./Message.js');
const VPNProfile = require('./VPNProfile.js');
const VpnManager = require('../vpn/VpnManager.js');
const vpnManager = new VpnManager();
const _ = require('lodash');
const {Address4} = require('ip-address');

class VPNProfileManager {
  constructor() {
    const c = require('./MessageBus.js');
    this.subscriber = new c("info");
    this.iptablesReady = false;
    this.vpnProfiles = {};
    this.ipProfileMap = {};

    this.scheduleRefresh();
    if (f.isMain()) {
      sem.once('IPTABLES_READY', async () => {
        this.iptablesReady = true;
        log.info("Iptables is ready, apply VPN profile policies ...");
        this.scheduleRefresh(); 
      });
    }

    sem.on('VPNConnectionAccepted', async (event) => {
      this.scheduleUpdateConnectedClients();
    });

    sem.on("VPNProfiles:Updated", async (event) => {
      log.info(`VPN profiles are updated`, event);
      this.scheduleRefresh();
    });

    return this;
  }

  getProfileCNByVirtualAddr(vaddr) {
    return this.ipProfileMap && this.ipProfileMap[vaddr] && this.ipProfileMap[vaddr].cn;
  }

  getRealAddrByVirtualAddr(vaddr) {
    return this.ipProfileMap && this.ipProfileMap[vaddr] && this.ipProfileMap[vaddr].addr;
  }

  scheduleUpdateConnectedClients() {
    if (this.updateClientsTask)
      clearTimeout(this.updateClientsTask);
    this.updateClientsTask = setTimeout(async () => {
      if (this._updateClientsInProgress) {
        log.info("Update connected clients in progress, will schedule later ...");
        this.scheduleUpdateConnectedClients();
      } else {
        try {
          this._updateClientsInProgress = true;
          await this.updateConnectedClients();
          if (f.isMain() && this.iptablesReady) {
            for (const cn in this.vpnProfiles) {
              const clientIPs = Object.keys(this.ipProfileMap).filter(ip => this.ipProfileMap[ip].cn === cn);
              this.vpnProfiles[cn] && await this.vpnProfiles[cn].updateClientIPs(clientIPs);
            }
          }
        } catch (err) {
          log.error("Failed to update connected VPN clients", err);
        } finally {
          this._updateClientsInProgress = false;
        }
      }
    }, 3000);
  }

  async updateConnectedClients() {
    const statistics = await vpnManager.getStatistics();
    if (!statistics || !statistics.clients) {
      this.ipProfileMap = {};
      return;
    }
    const clients = statistics.clients;
    const newIpProfileMap = {};
    for (const client of clients) {
      if (!client.vAddr || !client.cn)
        continue;
      for (const addr of client.vAddr) {
        if (new Address4(addr).isValid())
          newIpProfileMap[addr] = client;
      }
    }
    this.ipProfileMap = newIpProfileMap;
  }

  async toJson() {
    const json = {};
    for (const cn in this.vpnProfiles) {
      await this.vpnProfiles[cn].loadPolicy();
      json[cn] = this.vpnProfiles[cn].toJson();
    }
    return json;
  }

  getAllVPNProfiles() {
    return this.vpnProfiles;
  }

  getVPNProfile(cn) {
    return this.vpnProfiles && this.vpnProfiles[cn];
  }

  scheduleRefresh() {
    if (this.refreshTask)
      clearTimeout(this.refreshTask);
    this.refreshTask = setTimeout(async () => {
      if (this._refreshInProgress) {
        log.info("Refresh VPN profiles in progress, will schedule later ...");
        this.scheduleRefresh();
      } else {
        try {
          this._refreshInProgress = true;
          await this.refreshVPNProfiles();
          this.scheduleUpdateConnectedClients();
          if (f.isMain()) {
            if (this.iptablesReady) {
              for (let cn in this.vpnProfiles) {
                const vpnProfile = this.vpnProfiles[cn];
                vpnProfile.scheduleApplyPolicy();
              }
            }
          }
        } catch (err) {
          log.error("Failed to refresh VPN profiles", err);
        } finally {
          this._refreshInProgress = false;
        } 
      }
    }, 3000);
  }

  async refreshVPNProfiles() {
    for (let cn in this.vpnProfiles) {
      this.vpnProfiles[cn].active = false;
    }
    const allProfiles = await VpnManager.getAllSettings();
    for (const cn in allProfiles) {
      const o = allProfiles[cn];
      o.cn = cn;
      if (this.vpnProfiles[cn]) {
        this.vpnProfiles[cn].update(o);
      } else {
        this.vpnProfiles[cn] = new VPNProfile(o);
        if (f.isMain()) {
          if (this.iptablesReady) {
            log.info(`Creating environment for VPN profile ${cn} ...`);
            await this.vpnProfiles[cn].createEnv();
          } else {
            sem.once('IPTABLES_READY', async () => {
              log.info(`Creating environment for VPN profile ${cn} ...`);
              await this.vpnProfiles[cn].createEnv();
            });
          }
        }
      }
      this.vpnProfiles[cn].active = true;
    }

    const removedProfiles = {};
    Object.keys(this.vpnProfiles).filter(cn => this.vpnProfiles[cn].active === false).map((cn) => {
      removedProfiles[cn] = this.vpnProfiles[cn];
    });
    for (let cn in removedProfiles) {
      if (f.isMain()) {
        if (this.iptablesReady) {
          log.info(`Destroying environment for VPN profile ${cn} ...`);
          await removedProfiles[cn].destroyEnv();
        } else {
          sem.once('IPTABLES_READY', async () => {
            log.info(`Destroying environment for VPN profile ${cn} ...`);
            await removedProfiles[cn].destroyEnv();
          });
        }
      }
      delete this.vpnProfiles[cn];
    }
    return this.vpnProfiles;
  }
}

const instance = new VPNProfileManager();
module.exports = instance;