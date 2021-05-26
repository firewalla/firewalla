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

const events = require('events');
const exec = require('child-process-promise').exec;
const log = require('../../net2/logger.js')(__filename);
const fc = require('../../net2/config.js');
const f = require('../../net2/Firewalla.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const sem = require('../../sensor/SensorEventManager.js').getInstance();
const _ = require('lodash');

class VPNClient {
  constructor(options) {
  }

  hookLinkStateChange() {
    sem.on('link_broken', async (event) => {
      if (this._started === true && this._currentState !== false && this.profileId === event.profileId) {
        if (fc.isFeatureOn("vpn_disconnect")) {
          const Alarm = require('../../alarm/Alarm.js');
          const AlarmManager2 = require('../../alarm/AlarmManager2.js');
          const alarmManager2 = new AlarmManager2();
          const HostManager = require('../../net2/HostManager.js');
          const hostManager = new HostManager();
          const deviceCount = await hostManager.getVpnActiveDeviceCount(this.profileId);
          const alarm = new Alarm.VPNDisconnectAlarm(new Date() / 1000, null, {
            'p.vpn.profileid': this.profileId,
            'p.vpn.subtype': this.settings && this.settings.subtype,
            'p.vpn.devicecount': deviceCount,
            'p.vpn.displayname': (this.settings && (this.settings.displayName || this.settings.serverBoxName)) || this.profileId,
            'p.vpn.strictvpn': this.settings && this.settings.strictVPN || false
          });
          alarmManager2.enqueueAlarm(alarm);
        }
        this.scheduleRestart();
      }
      this._currentState = false;
    });

    sem.on('link_established', async (event) => {
      if (this._started === true && this._currentState === false && this.profileId === event.profileId) {
        if (fc.isFeatureOn("vpn_restore")) {
          const Alarm = require('../../alarm/Alarm.js');
          const AlarmManager2 = require('../../alarm/AlarmManager2.js');
          const alarmManager2 = new AlarmManager2();
          const HostManager = require('../../net2/HostManager.js');
          const hostManager = new HostManager();
          const deviceCount = await hostManager.getVpnActiveDeviceCount(this.profileId);
          const alarm = new Alarm.VPNRestoreAlarm(new Date() / 1000, null, {
            'p.vpn.profileid': this.profileId,
            'p.vpn.subtype': this.settings && this.settings.subtype,
            'p.vpn.devicecount': deviceCount,
            'p.vpn.displayname': (this.settings && (this.settings.displayName || this.settings.serverBoxName)) || this.profileId,
            'p.vpn.strictvpn': this.settings && this.settings.strictVPN || false
          });
          alarmManager2.enqueueAlarm(alarm);
        }
      }
      this._currentState = true;
    });
  }

  hookSettingsChange() {
    sem.on("VPNClient:SettingsChanged", async (event) => {
      const profileId = event.profileId;
      const settings = event.settings;
      if (profileId === this.profileId) {
        if (!this._isSettingsChanged(this.settings, settings))
          return;
        await this.loadSettings();
        if (this._started) {
          log.info(`Settings of VPN Client ${this.profileId} is changed, schedule restart ...`, this.settings);
          this.scheduleRestart();
        }
      }
    });

    sem.on("VPNClient:Stopped", async (event) => {
      const profileId = event.profileId;
      if (profileId === this.profileId)
        this._started = false;
    })
  }

  _isSettingsChanged(c1, c2) {
    const c1Copy = JSON.parse(JSON.stringify(c1));
    const c2Copy = JSON.parse(JSON.stringify(c2));
    for (const key of Object.keys(c1Copy)) {
      if (_.isArray(c1Copy[key]))
        c1Copy[key] = c1Copy[key].sort();
    }
    for (const key of Object.keys(c2Copy)) {
      if (_.isArray(c2Copy[key]))
        c2Copy[key] = c2Copy[key].sort();
    }
    return !_.isEqual(c1Copy, c2Copy);
  }

  scheduleRestart() {
    if (this.restartTask)
      clearTimeout(this.restartTask)
    this.restartTask = setTimeout(() => {
      if (!this._started)
        return;
      this.setup().then(() => this.start()).catch((err) => {
        log.error(`Failed to restart openvpn client ${this.profileId}`, err.message);
      });
    }, 5000);
  }

  getSettingsPath() {

  }

  async saveSettings(settings) {
    const settingsPath = this.getSettingsPath();
    let defaultSettings = {
      serverSubnets: [],
      overrideDefaultRoute: true,
      routeDNS: true,
      strictVPN: false
    }; // default settings
    const mergedSettings = Object.assign({}, defaultSettings, settings);
    this.settings = mergedSettings;
    await fs.writeFileAsync(settingsPath, JSON.stringify(mergedSettings), {encoding: 'utf8'});
    sem.emitEvent({
      type: "VPNClient:SettingsChanged",
      profileId: this.profileId,
      settings: this.settings,
      toProcess: "FireMain"
    });
  }

  async loadSettings() {
    const settingsPath = this.getSettingsPath();
    let settings = {
      serverSubnets: [],
      overrideDefaultRoute: true,
      routeDNS: true,
      strictVPN: false
    }; // default settings
    if (await fs.accessAsync(settingsPath, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      const settingsContent = await fs.readFileAsync(settingsPath, {encoding: 'utf8'});
      settings = Object.assign({}, settings, JSON.parse(settingsContent));
    }
    this.settings = settings;
    return settings;
  }

  async setup() {
  }

  async start() {
  }

  async stop() {
  }

  async status() {

  }

  async getStatistics() {

  }

  // applicable to pointtopoint interfaces
  async getRemoteIP() {
  }

  async getInterfaceName() {
  }

  static getRouteIpsetName(uid) {
    if (uid) {
      return `c_route_${uid.substring(0, 13)}_set`;
    } else
      return null;
  }

  static async ensureCreateEnforcementEnv(uid) {
    if (!uid)
      return;
    const routeIpsetName = VPNClient.getRouteIpsetName(uid);
    const routeIpsetName4 = `${routeIpsetName}4`;
    const routeIpsetName6 = `${routeIpsetName}6`;
    await exec(`sudo ipset create -! ${routeIpsetName} list:set skbinfo`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${routeIpsetName}`, err.message);
    });
    await exec(`sudo ipset create -! ${routeIpsetName4} hash:net maxelem 10`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${routeIpsetName4}`, err.message);
    });
    await exec(`sudo ipset create -! ${routeIpsetName6} hash:net family inet6 maxelem 10`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${routeIpsetName6}`, err.message);
    });
  }
}

module.exports = VPNClient;