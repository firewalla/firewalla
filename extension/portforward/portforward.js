/*    Copyright 2016-2026 Firewalla Inc.
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

'use strict'

let instance = null;
const log = require('../../net2/logger.js')(__filename)
const _ = require('lodash');

const f = require('../../net2/Firewalla.js')

const rclient = require('../../util/redis_manager.js').getRedisClient()
const sem = require('../../sensor/SensorEventManager.js').getInstance();

const sysManager = require('../../net2/SysManager')

const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();
const exec = require('child-process-promise').exec;
const {Address4} = require('ip-address');

const { Rule } = require("../../net2/Iptables.js");
const iptc = require('../../control/IptablesControl.js');
const Message = require('../../net2/Message.js');
const pl = require('../../platform/PlatformLoader.js');
const platform = pl.getPlatform();

const IdentityManager = require('../../net2/IdentityManager.js');
const VPN_CLIENT_WAN_PREFIX = "VC:";
const VPNClient = require('../../extension/vpnclient/VPNClient.js');
const NetworkProfile = require('../../net2/NetworkProfile.js');
const Mode = require('../../net2/Mode.js');

// Configurations
const configKey = 'extension.portforward.config'

const AsyncLock = require('../../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_SHARED = "LOCK_SHARED";
const LOCK_QUEUE = "LOCK_QUEUE";

const scheduler = require('../../util/scheduler.js');
const cronParser = require('cron-parser');

// re-arm the schedule check at least this often, so that a long pending schedule survives
// a timezone change or a suspended box
const MAX_SCHEDULE_DELAY = 6 * 3600 * 1000;
// always evaluate a bit after the boundary, a timer that fires right on it would see the
// previous cron occurrence and miss the window
const SCHEDULE_SKEW = 500;

// Configure Port Forwarding
// Example:
// {
//  maps:
//   [
//      description: "string"
//      protocol: tcp/udp
//      dport: integer
//      toIP: ip address
//      toMac: mac of the destination
//      toPort: ip port
//      enabled: true/false, activate/deactivate port forward, default to true
//      expireTs: optional epoch timestamp in seconds, the port forward expires at this moment
//      autoDeleteWhenExpires: optional, defaults to true, whether the entry is removed when expireTs is reached
//        instead of being kept in a disabled state. Only meaningful together with expireTs
//      idleTs: optional epoch timestamp in seconds, a disabled port forward is turned back on automatically at this moment
//      cronTime: optional cron expression, same as the one in rules, the port forward is only applied in the scheduled window
//      duration: optional length of the scheduled window in seconds, mandatory if cronTime is set
//   ]
// }
//
// expireTs/idleTs/cronTime are evaluated by applySchedules(), which asserts the desired
// iptables state of every scheduled entry on each pass. A cron window is gated without
// touching the user facing enabled flag, so manual on/off keeps working on a scheduled entry.

// only supports IPv4 for now
class PortForward {
  constructor() {
    if (!instance) {
      this.config = { maps: [] }
      this.scheduleCheckTimer = null;
      if (f.isMain()) {
        this.requestQueue = [];
        // this job will be scheduled each time a new portforward request is received, or the firemain is restarted
        this.applyRequestJob = new scheduler.UpdateJob(async () => {
          while (this.requestQueue.length != 0) {
            let obj = null;
            // fetch request object from request queue
            await lock.acquire(LOCK_QUEUE, async () => {
              obj = this.requestQueue.shift();
            }).catch((err) => {});
            if (!obj)
              continue;
            // apply the request object
            await lock.acquire(LOCK_SHARED, async () => {
              log.info('Apply portfoward policy', obj)
              if (obj != null) {
                if (!obj.hasOwnProperty("enabled"))
                  obj.enabled = true;
                if (obj.state == false) {
                  await this.removePort(obj);
                } else {
                  if (!this.normalizeSchedule(obj)) {
                    log.error("Invalid schedule in port forward request, ignore it", obj);
                    return;
                  }
                  const oldIndex = this.find(obj);
                  // the schedule of an existing entry is changed, remove the old one first so that
                  // the iptables rule is re-applied according to the new schedule
                  if (oldIndex >= 0 && this._scheduleChanged(this.config.maps[oldIndex], obj))
                    await this.removePort(obj);
                  if (obj.enabled === false || this._isScheduleSuppressed(obj))
                    await this.removePort(obj);
                  if (obj.toMac && !obj.toIP) {
                    const macEntry = await hostTool.getMACEntry(obj.toMac);
                    if (!macEntry) {
                      log.error("MAC entry is not found: ", obj);
                    } else {
                      if (macEntry.ipv4Addr)
                        obj.toIP = macEntry.ipv4Addr;
                    }
                  }
                  await this.addPort(obj);
                }
                // TODO: config should be saved after rule successfully applied
                await this.saveConfig();
                this._scheduleNextCheck();
              }
            }).catch((err) => {
              log.error('Error applying port-forward', obj, err);
            });
          }
        }, 1000);

        this.ready = false;
        let c = require('../../net2/MessageBus.js');
        this.channel = new c('debug');
        this.channel.subscribe("FeaturePolicy", "Extension:PortForwarding", null, async (channel, type, ip, obj) => {
          if (type != "Extension:PortForwarding") return
          await lock.acquire(LOCK_QUEUE, async() => {
            this.requestQueue.push(obj);
          }).catch((err) => {});
          // request objects will be cached in queue if iptables is not ready yet
          if (this.ready)
            await this.applyRequestJob.exec();
        });


        sem.on('Mode:Applied', async (event) => {
          if (!this._started) return;
          await lock.acquire(LOCK_SHARED, async () => {
            const routerMode = event.mode === Mode.MODE_ROUTER;
            await this._syncDMZRules(routerMode);
            await this._syncDMZAllowRules(routerMode);
          }).catch((err) => {
            log.error("Failed to sync DMZ rules on mode change", err);
          });
        });

        sem.once('IPTABLES_READY', () => {
          this.ready = true;
          sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async () => {
            if (!this._started)
              return;
            await lock.acquire(LOCK_SHARED, async () => {
              const myWanIps = sysManager.myWanIps().v4
              if (this._wanIPs && (myWanIps.length !== this._wanIPs.length || myWanIps.some(i => !this._wanIPs.includes(i)))) {
                this._wanIPs = myWanIps;
                if (platform.isOverlayNetworkAvailable()) {
                  const primaryInterface = sysManager.getDefaultWanInterface();
                  if (primaryInterface) {
                    const overlayInterface = sysManager.getInterface(primaryInterface.name + ":0");
                    const overlayIP = overlayInterface && overlayInterface.ip_address;
                    if (overlayIP && sysManager.inMySubnets4(overlayIP, primaryInterface.name)) {
                      if (!this._wanIPs.includes(overlayIP))
                        this._wanIPs.push(overlayIP);
                    }
                  }
                }
                await this.updateExtIPChain(this._wanIPs);
              }
              await this.loadConfig();
              await this.restore();
              await this.refreshConfig();
              await this.applySchedules();
              this._scheduleNextCheck();
            }).catch((err) => {
              log.error("Failed to refresh port forward rules", err);
            });
          })
        })
      }
      instance = this;
    }

    return instance;
  }

  async updateExtIPChain(extIPs) {
    await iptc.addRule(new Rule('nat').chn('FW_PREROUTING_EXT_IP').opr('-F'));
    for (const extIP of extIPs) {
      await iptc.addRule(new Rule('nat').chn('FW_PREROUTING_EXT_IP').dst(extIP).jmp('FW_PRERT_PORT_FORWARD'));
    }
  }

  async refreshConfig() {
    if (this.config == null || this.config.maps == null)
      return;
    const mapsCopy = JSON.parse(JSON.stringify(this.config.maps));
    const updatedMaps = [];
    for (let map of mapsCopy) {
      if (!map.toIP && !map.toMac && !map.toGuid) {
        log.error("Neither toMac nor toIP is defined: ", map);
        await this.removePort(map);
        continue;
      }
      if (!map.toMac && !map.toGuid) {
        // need to convert toIP to mac address of the internal host. Legacy port forwarding rules only contain IP address.
        const mac = await hostTool.getMacByIP(map.toIP);
        if (!mac) {
          log.error("No corresponding MAC address found: ", map);
          await this.removePort(map);
          continue;
        }
        const macEntry = await hostTool.getMACEntry(mac);
        if (!macEntry) {
          log.error("MAC entry is not found: ", map);
          await this.removePort(map);
          continue;
        }
        const ipv4Addr = macEntry.ipv4Addr;
        if (!ipv4Addr || ipv4Addr !== map.toIP) {
          // the toIP is already taken over by another device
          log.error("IP address is already taken by other device: ", map);
          await this.removePort(map);
          continue;
        }
        map.toMac = mac;
        updatedMaps.push(map);
      } else {
        let ipv4Addr;
        if (map.toMac) {
          // update IP of the device from host:mac:* entries.
          const macEntry = await hostTool.getMACEntry(map.toMac);
          if (!macEntry) {
            log.error("MAC entry is not found: ", map);
            await this.removePort(map);
            continue;
          }
          ipv4Addr = macEntry.ipv4Addr;
        } else {
          // update IP from identity
          log.debug("Find identity to port forward", map.toGuid);
          const identity = IdentityManager.getIdentityByGUID(map.toGuid);
          if (!identity) {
            log.error("Port forwarding entry is not found in host or identity: ", map);
            await this.removePort(map);
            continue;
          } else {
            const ips = identity.getIPs();
            // ips from identity.getIPs may be cidr with subnet mask length
            const ip4s = ips.filter(ip => new Address4(ip).isValid()).map(ip => ip.split('/')[0]);
            if (ip4s.length !== 0) {
              ipv4Addr = ip4s[0];
            } else {
              ipv4Addr = null;
            }
          }
        }
        if (ipv4Addr !== map.toIP) {
          // remove old port forwarding rule with legacy IP address
          log.info("IP changed, remove old rule:", map.dport, map.toMac, map.toIP, map.toPort);
          await this.removePort(map);
          if (ipv4Addr) {
            // add new port forwarding rule with updated IP address
            map.toIP = ipv4Addr;
            map.active = true;
            log.info("IP changed, add new rule:", map.dport, map.toMac, map.toIP, map.toPort);
            await this.addPort(map);
          } else {
            map.toIP = null;
            map.active = false;
            log.info("IP address is not available, deactivating rule: ", map);
            await this.addPort(map);
          }
        }
        map.toIP = ipv4Addr; // ensure the latest ipv4 address is synced no matter if it is changed
        updatedMaps.push(map);
      }
    }
    this.config.maps = updatedMaps;
    await this.saveConfig();
  }

  async saveConfig() {
    if (this.config == null) {
      return;
    }
    let string = JSON.stringify(this.config)
    log.debug("PortForwarder:Saving:", string);
    return rclient.setAsync(configKey, string)
  }

  async loadConfig() {
    let json = await rclient.getAsync(configKey)
    log.debug("PortForwarder:Config:", json);
    if (json) {
      try {
        let config = JSON.parse(json)
        this.config = config
      } catch (err) {
        log.error("PortForwarder:Failed to parse config:", json, err);
        this.config = { maps: [] };
      }
    } else {
      log.info("PortForwarder:EmptyConfig");
      this.config = { maps: [] };
    }
  }

  setConfig(config) {
    this.config = config
    return this.saveConfig()
  }

  // return -1 if not found
  //        index if found
  //        undefined, null, 0, false, '*' will be recognized as wildcards

  find(map) {
    if (this.config == null || this.config.maps == null) {
      return -1;
    } else {
      for (let i in this.config.maps) {
        let _map = this.config.maps[i];
        if (
          (map.applyToAll == "*" || _map.applyToAll == map.applyToAll) &&
          (map.wanUUID == "*" || _map.wanUUID == map.wanUUID) &&
          (map.extIP == "*" || _map.extIP == map.extIP) &&
          (!map.dport || map.dport == "*" || _map.dport == map.dport) &&
          (!map.toPort || map.toPort == "*" || _map.toPort == map.toPort) &&
          (!map.protocol || map.protocol == "*" || _map.protocol == map.protocol) &&
          (!map.toIP && map.toMac && _map.toMac == map.toMac || map.toIP && _map.toIP == map.toIP || map.toGuid && _map.toGuid === map.toGuid || map.toMac == "*" || map.toGuid == "*") &&
          (map._type == "*" || (_map._type || "port_forward") === (map._type || "port_forward"))
        ) {
          return i;
        }
      }
    }
    return -1;
  }

  // save config should follow this
  async addPort(map, init) {
    try {
      if (init == false || init == null) {
        let old = this.find(map);
        if (old >= 0) {
          if (this.config.maps[old].enabled === map.enabled && !this._scheduleChanged(this.config.maps[old], map)) {
            log.verbose("PORTMAP:addPort Duplicated MAP", map);
            return;
          } else {
            this.config.maps[old] = map;
          }
        } else {
          this.config.maps.push(map);
        }
      }

      if (map.active === false) {
        log.debug("Port forward is not active now", map);
        return;
      }

      if (map.enabled === false) {
        log.debug("Port forward is disabled now", map);
        return;
      }

      if (this._isScheduleSuppressed(map)) {
        log.debug("Port forward is outside of its scheduled window now", map);
        return;
      }

      if (!this._isLANInterfaceIP(map.toIP)) {
        log.warn("IP is not in LAN network, port forward will not be applied: ", map);
        return;
      }

      if (map._type === "dmz_host" && !(await Mode.isRouterModeOn())) {
        log.info("Box is not in router mode, DMZ host rule will not be applied:", map);
        return;
      }

      log.debug(`Add port forward`, map);
      map.state = true;
      map.active = true;
      map.enabled = true;
      const dupMap = JSON.parse(JSON.stringify(map));
      await this.enforceIptables(dupMap);
    } catch (err) {
      log.error("Failed to add port mapping:", err);
    }
  }

  // save config should follow this
  async removePort(map) {
    let old = this.find(map);
    while (old >= 0) {
      this.config.maps[old].state = false;
      if (this.config.maps[old].active !== false && this.config.maps[old].enabled !== false) {
        log.debug(`Remove port forward`, this.config.maps[old]);
        const dupMap = JSON.parse(JSON.stringify(this.config.maps[old]));
        await this.enforceIptables(dupMap);
      }

      this.config.maps.splice(old, 1);
      old = this.find(map);
    }
  }

  async restore() {
    try {
      log.info("PortForwarder:ApplyConfig ...")
      if (this.config && this.config.maps) {
        for (let i in this.config.maps) {
          let map = this.config.maps[i];
          await this.addPort(map, true)
        }
      }
    } catch (err) { }
  }

  async start() {
    log.info("PortForwarder:Starting PortForwarder ...")
    this._wanIPs = sysManager.myWanIps().v4;
    if (platform.isOverlayNetworkAvailable()) {
      const primaryInterface = sysManager.getDefaultWanInterface();
      if (primaryInterface) {
        const overlayInterface = sysManager.getInterface(primaryInterface.name + ":0");
        const overlayIP = overlayInterface && overlayInterface.ip_address;
        if (overlayIP && sysManager.inMySubnets4(overlayIP, primaryInterface.name)) {
          if (!this._wanIPs.includes(overlayIP))
            this._wanIPs.push(overlayIP);
        }
      }
    }
    if (f.isMain()) {
      this.ready = true;
      await lock.acquire(LOCK_SHARED, async () => {
        await this.updateExtIPChain(this._wanIPs);
        await this.loadConfig()
        await this.restore()
        await this.refreshConfig()
        await this.applySchedules()
        await this._syncDMZAllowRules(await Mode.isRouterModeOn());
      }).catch((err) => {
        log.error(`Failed to initialize PortForwarder`, err);
      });
      await this.applyRequestJob.exec();
      this._scheduleNextCheck();

      setInterval(() => {
        lock.acquire(LOCK_SHARED, async () => {
          await this.refreshConfig();
          await this.applySchedules();
        }).catch((err) => {
          log.error(`Failed to refresh config`, err);
        }).then(() => this._scheduleNextCheck());
      }, 60000); // refresh config once every minute
    }
    this._started = true;
  }

  async stop() {
    log.info("PortForwarder:Stopping PortForwarder ...")
    if (this.scheduleCheckTimer) {
      clearTimeout(this.scheduleCheckTimer);
      this.scheduleCheckTimer = null;
    }
    await this.saveConfig().catch(() => { })
  }

  // normalize the optional scheduling fields of a port forward entry in place,
  // returns an error message if they are invalid, null otherwise
  static validateSchedule(map) {
    if (!_.isObject(map))
      return null;
    for (const key of ["expireTs", "idleTs", "duration"]) {
      // the app clears a schedule by sending 0 as readily as by sending "" or null
      if (map[key] === undefined || map[key] === null || map[key] === "" || Number(map[key]) === 0) {
        delete map[key];
        continue;
      }
      const value = Number(map[key]);
      if (!Number.isFinite(value) || value <= 0)
        return `${key} of port forward should be a positive number`;
      map[key] = value;
    }
    if (map.cronTime === null || map.cronTime === "")
      delete map.cronTime;
    if (map.cronTime) {
      if (!_.isString(map.cronTime))
        return "cronTime of port forward should be a string";
      if (!map.duration)
        return "duration of port forward is required when cronTime is set";
      try {
        cronParser.parseExpression(map.cronTime, { tz: sysManager.getTimezone() });
      } catch (err) {
        return `invalid cronTime of port forward: ${map.cronTime}`;
      }
    } else {
      // duration alone is meaningless
      delete map.duration;
    }
    if (!map.expireTs || map.autoDeleteWhenExpires === undefined || map.autoDeleteWhenExpires === null || map.autoDeleteWhenExpires === "")
      // the flag only makes sense with expireTs, and leaving it out means true
      delete map.autoDeleteWhenExpires;
    else
      map.autoDeleteWhenExpires = ![false, 0, "0", "false"].includes(map.autoDeleteWhenExpires);
    return null;
  }

  // validate an incoming request, returns false if its schedule is invalid
  normalizeSchedule(map) {
    const err = PortForward.validateSchedule(map);
    if (err) {
      log.error("Failed to validate port forward schedule:", err);
      return false;
    }
    return true;
  }

  _hasSchedule(map) {
    return Boolean(map.expireTs || map.idleTs || (map.cronTime && map.duration));
  }

  _scheduleChanged(oldMap, newMap) {
    // autoDeleteWhenExpires false and absent mean different things, so compare the raw
    // values and only fold undefined into null
    const value = (map, key) => (map[key] === undefined ? null : map[key]);
    return ["expireTs", "idleTs", "cronTime", "duration", "autoDeleteWhenExpires"]
      .some(key => value(oldMap, key) !== value(newMap, key));
  }

  // the most recent occurrence of cronTime at or before now. prev() in cron-parser is strictly
  // before currentDate, so look from 1ms later, otherwise an occurrence exactly at now, which is
  // when the schedule timer fires, is reported as the previous one and the window start is missed
  _cronWindowBegin(map, now) {
    const interval = cronParser.parseExpression(map.cronTime, { tz: sysManager.getTimezone(), currentDate: new Date(now * 1000 + 1) });
    return interval.prev().getTime() / 1000;
  }

  // the first occurrence of cronTime strictly after now
  _cronNextBegin(map, now) {
    const interval = cronParser.parseExpression(map.cronTime, { tz: sysManager.getTimezone(), currentDate: new Date(now * 1000) });
    return interval.next().getTime() / 1000;
  }

  // whether now is inside a window that starts at an occurrence of cronTime and lasts for duration
  _inCronWindow(map, now = Date.now() / 1000) {
    try {
      return now < this._cronWindowBegin(map, now) + Number(map.duration);
    } catch (err) {
      // keep the port closed if the schedule cannot be evaluated
      log.error(`Failed to parse cron expression ${map.cronTime}`, err.message);
      return false;
    }
  }

  _isScheduleSuppressed(map, now = Date.now() / 1000) {
    if (map.idleTs && now < Number(map.idleTs))
      return true;
    if (map.expireTs && now >= Number(map.expireTs))
      return true;
    if (map.cronTime && map.duration && !this._inCronWindow(map, now))
      return true;
    return false;
  }

  // the desired state of an entry: whether its iptables rule should be installed right now.
  // addPort() gates on the same conditions, this is the single place they are written down
  async _shouldBeApplied(map, now = Date.now() / 1000) {
    if (map.active === false || map.enabled === false)
      return false;
    if (this._isScheduleSuppressed(map, now))
      return false;
    if (!this._isLANInterfaceIP(map.toIP))
      return false;
    if (map._type === "dmz_host" && !(await Mode.isRouterModeOn()))
      return false;
    return true;
  }

  async _setIptables(map, apply) {
    const dupMap = JSON.parse(JSON.stringify(map));
    dupMap.state = apply;
    await this.enforceIptables(dupMap);
    map.state = apply;
  }

  // evaluate the schedule of every entry and assert the resulting iptables state.
  // the desired state is recomputed from now rather than driven by a CronJob per entry the way
  // scheduler.js does for rules: a port forward entry has no stable id and removePort() drops it
  // from a dozen call sites, so a job registry would leak jobs that re-open a deleted port.
  // nothing records whether a rule is currently installed either: IptablesControl dedups -I/-A
  // and drops a -D that matches nothing, so asserting the desired state every pass is idempotent
  // and self-heals after a missed tick, a clock jump, a reload or a timezone change
  async applySchedules() {
    if (!this.config || !_.isArray(this.config.maps))
      return;
    const now = Date.now() / 1000;
    const previously = this.lastScheduleEvalTs;
    this.lastScheduleEvalTs = now;
    let dirty = false;
    const expiredMaps = new Set();
    // iterate a snapshot, an expired entry may be dropped from this.config.maps below
    for (const map of this.config.maps.slice()) {
      if (!this._hasSchedule(map))
        continue;

      if (map.expireTs && now >= Number(map.expireTs)) {
        // an expired entry is finished: idleTs must not resurrect it in this same pass
        delete map.expireTs;
        delete map.idleTs;
        map.enabled = false;
        dirty = true;
        if (map.autoDeleteWhenExpires !== false) {
          log.info("Port forward is expired, removing it", map);
          expiredMaps.add(map);
        } else {
          log.info("Port forward is expired, turning it off", map);
        }
      } else if (map.idleTs && now >= Number(map.idleTs)) {
        log.info("Port forward pause is over, turning it back on", map);
        delete map.idleTs;
        map.enabled = true;
        dirty = true;
      } else if (previously && map.cronTime && map.duration
          && this._isScheduleSuppressed(map, previously) !== this._isScheduleSuppressed(map, now)) {
        // logging only, the assert below is what actually changes anything
        log.info(`Port forward scheduled window ${this._inCronWindow(map, now) ? "opened" : "closed"}`, map);
      }

      const apply = !expiredMaps.has(map) && await this._shouldBeApplied(map, now);
      await this._setIptables(map, apply);
    }
    if (expiredMaps.size)
      this.config.maps = this.config.maps.filter(map => !expiredMaps.has(map));
    if (dirty)
      await this.saveConfig();
  }

  // the nearest moment in the future at which any entry changes its scheduled state
  _getNextScheduleTs(now = Date.now() / 1000) {
    if (!this.config || !_.isArray(this.config.maps))
      return null;
    let next = null;
    const update = (ts) => {
      if (Number.isFinite(ts) && ts > now && (next === null || ts < next))
        next = ts;
    };
    for (const map of this.config.maps) {
      if (!this._hasSchedule(map))
        continue;
      update(Number(map.expireTs));
      update(Number(map.idleTs));
      if (map.cronTime && map.duration) {
        try {
          // end of the current window and beginning of the next one
          update(this._cronWindowBegin(map, now) + Number(map.duration));
          update(this._cronNextBegin(map, now));
        } catch (err) {
          log.error(`Failed to parse cron expression ${map.cronTime}`, err.message);
        }
      }
    }
    return next;
  }

  _scheduleNextCheck() {
    if (this.scheduleCheckTimer) {
      clearTimeout(this.scheduleCheckTimer);
      this.scheduleCheckTimer = null;
    }
    const next = this._getNextScheduleTs();
    if (next === null)
      return;
    const delay = Math.min(Math.max((next - Date.now() / 1000) * 1000 + SCHEDULE_SKEW, SCHEDULE_SKEW), MAX_SCHEDULE_DELAY);
    log.debug(`Next port forward schedule check in ${Math.floor(delay / 1000)} seconds`);
    this.scheduleCheckTimer = setTimeout(() => {
      lock.acquire(LOCK_SHARED, async () => {
        await this.applySchedules();
      }).catch((err) => {
        log.error("Failed to apply port forward schedules", err);
      }).then(() => this._scheduleNextCheck());
    }, delay);
  }

  async _syncDMZRules(routerMode) {
    if (!this.config || !Array.isArray(this.config.maps)) return;
    for (const map of this.config.maps) {
      if (map._type !== "dmz_host") continue;
      if (map.active === false || map.enabled === false || this._isScheduleSuppressed(map)) continue;
      if (!map.toIP || !this._isLANInterfaceIP(map.toIP)) continue;
      const dupMap = JSON.parse(JSON.stringify(map));
      dupMap.state = false;
      await this.enforceIptables(dupMap);
      if (routerMode) {
        dupMap.state = true;
        await this.enforceIptables(dupMap);
      }
    }
  }

  async _syncDMZAllowRules(routerMode) {
    const PolicyManager2 = require('../../alarm/PolicyManager2.js');
    const Policy = require('../../alarm/Policy.js');
    const pm2 = new PolicyManager2();
    const rules = await pm2.getPurposeRelatedPolicies("dmz");
    log.info(`Syncing ${rules.length} DMZ allow rule(s), routerMode=${routerMode}`);
    for (const rule of rules) {
      const suspendedByThis = rule.dmzModeSuspended === "1";
      const currentlyDisabled = rule.disabled == "1";
      if (routerMode) {
        if (!suspendedByThis || !currentlyDisabled) continue;
        const newRule = new Policy(Object.assign({}, rule, { disabled: "0", dmzModeSuspended: "", updatedTime: Date.now() / 1000 }));
        const oldRule = new Policy(rule);
        await pm2.updatePolicyAsync(newRule);
        pm2.tryPolicyEnforcement(newRule, "reenforce", oldRule);
      } else {
        if (currentlyDisabled) continue;
        const newRule = new Policy(Object.assign({}, rule, { disabled: "1", dmzModeSuspended: "1", updatedTime: Date.now() / 1000 }));
        const oldRule = new Policy(rule);
        await pm2.updatePolicyAsync(newRule);
        pm2.tryPolicyEnforcement(newRule, "reenforce", oldRule);
      }
    }
  }

  _isLANInterfaceIP(ip) {
    const iface = sysManager.getInterfaceViaIP(ip);
    if (!iface || !iface.name)
      return false;
    if (iface.type === "lan")
      return true;
    if (platform.isOverlayNetworkAvailable()) {
      // on red/blue/navy, if overlay and primary network are in the same subnet, getInterfaceViaIP4 will return primary network, which is LAN
      if (sysManager.inMySubnets4(ip, `${iface.name}:0`))
        return true;
    }
    return false;
  }

  async enforceIptables(rule) {
    let state = rule.state;
    let protocol = rule.protocol;
    let dport = rule.dport;
    let toIP = rule.toIP;
    let toPort = rule.toPort;
    let extIP = rule.extIP || null;
    let wanUUID = rule.wanUUID || null;
    const applyToAll = rule.applyToAll || null;
    const type = rule._type || "port_forward";
    let chains = [];
    let dstSet = null;
    if (wanUUID) {
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        await VPNClient.ensureCreateEnforcementEnv(profileId);
        dstSet = VPNClient.getSelfIpsetName(profileId, 4);
        chains.push("FW_PRERT_VC_PORT_FORWARD");
      } else {
        await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
        dstSet = NetworkProfile.getSelfIpsetName(wanUUID, 4);
        chains.push("FW_PRERT_PORT_FORWARD");
      }
    }
    if (applyToAll)
      chains = ["FW_PRERT_VC_PORT_FORWARD", "FW_PRERT_PORT_FORWARD"];
    if (_.isEmpty(chains)) // only apply to wans by default
      chains = ["FW_PRERT_PORT_FORWARD"];
    if (type === "dmz_host")
      chains = ["FW_PREROUTING_DMZ_HOST"];

    const operation = state ? (type === "port_forward" ? "-I" : "-A") : "-D";
    const baseRule = new Rule('nat')
    if (protocol) baseRule.pro(protocol);
    if (extIP) baseRule.dst(extIP);
    if (dstSet) baseRule.set(dstSet, 'dst');
    if (dport) baseRule.dport(dport);
    baseRule.opr(operation);

    const hairpinRule = new Rule('nat')
    if (protocol) hairpinRule.pro(protocol);
    hairpinRule.jmp('FW_POSTROUTING_HAIRPIN').opr(operation);
    switch (type) {
      case "port_forward": {
        baseRule.dnat(`${toIP}:${toPort}`)
        hairpinRule.chn('FW_POSTROUTING_PORT_FORWARD').dst(toIP);
        hairpinRule.dport(toPort.toString().replace(/-/, ':'));
        break;
      }
      case "dmz_host": {
        baseRule.dnat(toIP);
        hairpinRule.chn('FW_POSTROUTING_DMZ_HOST').dst(toIP);
        if (dport) hairpinRule.dport(dport);
        break;
      }
      default:
        log.error("Unrecognized port forward type", type);
        return;
    }
    for (const chain of chains) {
      await iptc.addRule(baseRule.chn(chain));
    }
    await iptc.addRule(hairpinRule);
  }
}

module.exports = PortForward;
