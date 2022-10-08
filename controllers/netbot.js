#!/usr/bin/env node
/*    Copyright 2016-2022 Firewalla Inc.
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

process.title = "FireApi";
const _ = require('lodash');
const log = require('../net2/logger.js')(__filename, "info");

const util = require('util');
const asyncNative = require('../util/asyncNative.js');

const ControllerBot = require('../lib/ControllerBot.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const fc = require('../net2/config.js')
const pairedMaxHistoryEntry = fc.getConfig().pairedDeviceMaxHistory || 100;
const URL = require("url");
const bone = require("../lib/Bone");

const SysInfo = require('../extension/sysinfo/SysInfo.js');

const EptCloudExtension = require('../extension/ept/eptcloud.js');

const TypeFlowTool = require('../flow/TypeFlowTool.js')
const categoryFlowTool = new TypeFlowTool('category')

const HostManager = require('../net2/HostManager.js');
const sysManager = require('../net2/SysManager.js');
const FlowManager = require('../net2/FlowManager.js');
const flowManager = new FlowManager('info');
const VpnManager = require("../vpn/VpnManager.js");
const IntelManager = require('../net2/IntelManager.js');
const intelManager = new IntelManager('debug');
const upgradeManager = require('../net2/UpgradeManager.js');
const modeManager = require('../net2/ModeManager.js');

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

const DeviceMgmtTool = require('../util/DeviceMgmtTool');

const Promise = require('bluebird');

const SysTool = require('../net2/SysTool.js')
const sysTool = new SysTool()

const Constants = require('../net2/Constants.js');

const flowUtil = require('../net2/FlowUtil');

const iptool = require('ip');
const traceroute = require('../vendor/traceroute/traceroute.js');

const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const pclient = require('../util/redis_manager.js').getPublishClient();

const execAsync = require('child-process-promise').exec;
const { exec, execSync } = require('child_process');

const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();

const EM = require('../alarm/ExceptionManager.js');
const em = new EM();

const Policy = require('../alarm/Policy.js');
const PM2 = require('../alarm/PolicyManager2.js');
const pm2 = new PM2();

const SSH = require('../extension/ssh/ssh.js');
const ssh = new SSH('info');

const builder = require('botbuilder');
const uuid = require('uuid');

const NM = require('../ui/NotifyManager.js');
const nm = new NM();

const FRPManager = require('../extension/frp/FRPManager.js')
const fm = new FRPManager()
const frp = fm.getSupportFRP();

const speedtest = require('../extension/speedtest/speedtest.js')

const fireWeb = require('../mgmt/FireWeb.js');
const clientMgmt = require('../mgmt/ClientMgmt.js');

const f = require('../net2/Firewalla.js');

const flowTool = require('../net2/FlowTool');
const auditTool = require('../net2/AuditTool');

const i18n = require('../util/i18n');

const FlowAggrTool = require('../net2/FlowAggrTool');
const flowAggrTool = new FlowAggrTool();

const NetBotTool = require('../net2/NetBotTool');
const netBotTool = new NetBotTool();

const HostTool = require('../net2/HostTool');
const hostTool = new HostTool();

const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()

const vipManager = require('../net2/VipManager');

const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();

const appTool = require('../net2/AppTool')();

const sm = require('../net2/SpooferManager.js')

const extMgr = require('../sensor/ExtensionManager.js')

const policyManager = require('../net2/PolicyManager.js');

const tokenManager = require('../api/middlewares/TokenManager').getInstance();

const migration = require('../migration/migration.js');

const FireRouter = require('../net2/FireRouter.js');

const VPNClient = require('../extension/vpnclient/VPNClient.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const conncheck = require('../diagnostic/conncheck.js');
const { delay } = require('../util/util.js');
const Alarm = require('../alarm/Alarm.js');
const FRPSUCCESSCODE = 0;
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();
const RateLimiterRedis = require('../vendor_lib/rate-limiter-flexible/RateLimiterRedis.js');
const cpuProfile = require('../net2/CpuProfile.js');
const ea = require('../event/EventApi.js');
const wrapIptables = require('../net2/Iptables.js').wrapIptables;

const Message = require('../net2/Message')

const restartUPnPTask = {};

class netBot extends ControllerBot {

  _vpn(ip, value, callback = () => { }) {
    if (ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.loadPolicy((err, data) => {
      let oldValue = {};
      if (data["vpn"]) {
        oldValue = JSON.parse(data["vpn"]);
      }
      const newValue = Object.assign({}, oldValue, value);
      this.hostManager.setPolicy("vpn", newValue, callback)
    });
  }

  _ipAllocation(ip, value, callback = () => { }) {
    if (ip === "0.0.0.0") {
      // ip allocation is only applied on device
      callback(null)
      return;
    }
    if (value.alternativeIp && value.type === "static") {
      const mySubnet = sysManager.mySubnet();
      if (!iptool.cidrSubnet(mySubnet).contains(value.alternativeIp)) {
        callback(new Error(`Alternative IP address should be in ${mySubnet}`));
        return;
      }
    }
    if (value.secondaryIp && value.type === "static") {
      const mySubnet2 = sysManager.mySubnet2();
      if (!iptool.cidrSubnet(mySubnet2).contains(value.secondaryIp)) {
        callback(new Error(`Secondary IP address should be in ${mySubnet2}`));
        return;
      }
    }
    this.hostManager.getHost(ip, (err, host) => {
      if (host != null) {
        host.loadPolicy((err, data) => {
          if (err == null) {
            host.setPolicy("ipAllocation", value, callback)
          } else {
            log.error("Failed to load policy of " + ip, err);
            callback(err);
          }
        })
      } else {
        callback(new Error("host not found: " + ip));
      }
    })
  }

  _shadowsocks(ip, value, callback = () => { }) {
    if (ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.setPolicy("shadowsocks", value, callback)
  }

  _enhancedSpoof(ip, value, callback = () => { }) {
    if (ip !== "0.0.0.0") {
      callback(null);
      return;
    }

    this.hostManager.setPolicy("enhancedSpoof", value, callback)
  }

  _vulScan(ip, value, callback = () => { }) {
    if (ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.setPolicy("vulScan", value, callback)
  }

  _dnsmasq(target, value, callback = () => { }) {
    if (target === "0.0.0.0") {
      this.hostManager.loadPolicy((err, data) => {
        if (!data) callback(new Error('Error loading policy'))
        else {
          let oldValue = {};
          if (data["dnsmasq"]) {
            oldValue = JSON.parse(data["dnsmasq"]);
          }
          const newValue = Object.assign({}, oldValue, value);
          this.hostManager.setPolicy("dnsmasq", newValue, callback);
        }
      });
    } else {
      if (target.startsWith("network:")) {
        const uuid = target.substring(8);
        const network = this.networkProfileManager.getNetworkProfile(uuid);
        if (network) {
          network.loadPolicy().then(() => {
            network.setPolicy("dnsmasq", value).then(() => {
              callback(null);
            });
          }).catch((err) => {
            callback(err);
          });
        } else {
          callback(new Error(`Network ${uuid} is not found`));
        }
      } else {
        if (this.identityManager.isGUID(target)) {
          const identity = this.identityManager.getIdentityByGUID(target);
          if (identity) {
            identity.loadPolicy().then(() => {
              identity.setPolicy("dnsmasq", value).then(() => {
                callback(null);
              });
            }).catch((err) => {
              callback(err);
            });
          } else {
            callback(new Error(`Identity GUID ${target} not found`));
          }
        } else {
          if (hostTool.isMacAddress(target)) {
            this.hostManager.getHost(target, (err, host) => {
              if (host != null) {
                host.loadPolicy((err, data) => {
                  if (err == null) {
                    host.setPolicy('dnsmasq', value, callback);
                  } else {
                    callback(new Error("Unable to change dnsmasq config of " + target));
                  }
                });
              } else {
                callback(new Error("Host not found"));
              }
            });
          } else {
            callback(new Error(`Unknown target ${target}`));
          }
        }
      }
    }
  }

  _externalAccess(ip, value, callback = () => { }) {
    if (ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.setPolicy("externalAccess", value, callback)
  }

  _ssh(ip, value, callback = () => { }) {
    this.hostManager.setPolicy("ssh", value, callback)
  }

  /*
   *   {
   *      state: BOOL;  overall notification
   *      ALARM_XXX: standard alarm definition
   *      ALARM_BEHAVIOR: may be mapped to other alarms
   *   }
   */
  _notify(ip, value, callback = () => { }) {
    this.hostManager.setPolicy("notify", value, (err, data) => {
      callback(err)
      log.info("Notification Set", value, " CurrentPolicy:", JSON.stringify(this.hostManager.policy.notify));
      nm.loadConfig();
    });
  }

  _sendLog(msg, callback = () => { }) {
    let password = require('../extension/common/key.js').randomPassword(10)
    let filename = this.primarygid + ".tar.gz.gpg";
    this.eptcloud.getStorage(this.primarygid, 18000000, 0, (e, url) => {
      if (url == null || url.url == null) {
        this.simpleTxData(msg, {}, "Unable to get storage", callback);
      } else {
        const path = URL.parse(url.url).pathname;
        const homePath = f.getFirewallaHome();
        let cmdline = `${homePath}/scripts/encrypt-upload-s3.sh ${filename} ${password} '${url.url}'`;
        exec(cmdline, (err, out, code) => {
          if (err) {
            log.error("sendLog: unable to process encrypt-upload", err, out, code);
          }
        });
        this.simpleTxData(msg, { password: password, filename: path }, null, callback);
      }
    });
  }

  _portforward(target, msg, callback = () => { }) {
    log.info("_portforward", msg);
    this.messageBus.publish("FeaturePolicy", "Extension:PortForwarding", null, msg);
    callback(null, null);
  }

  _setUpstreamDns(ip, value, callback = () => { }) {
    log.info("In _setUpstreamDns with ip:", ip, "value:", value);
    this.hostManager.setPolicy("upstreamDns", value, callback);
  }

  setupRateLimit() {
    // Enhancement: need rate limit on the box api
    const rateLimitOptions = platform.getRatelimitConfig();
    return {
      app: new RateLimiterRedis({
        redis: rclient,
        keyPrefix: "ratelimit:app",
        points: rateLimitOptions.appMax || 60,
        duration: rateLimitOptions.duration || 60//per second
      }),
      web: new RateLimiterRedis({
        redis: rclient,
        keyPrefix: "ratelimit:web",
        points: rateLimitOptions.webMax || 200,
        duration: rateLimitOptions.duration || 60//per second
      }),
      streaming: new RateLimiterRedis({
        redis: rclient,
        keyPrefix: "ratelimit:streaming",
        points: rateLimitOptions.streamingMax || 180,
        duration: rateLimitOptions.duration || 60//per second
      })
    };
  }

  constructor(config, fullConfig, eptcloud, groups, gid, debug, offlineMode) {
    super(config, fullConfig, eptcloud, groups, gid, debug, offlineMode);
    this.bot = new builder.TextBot();
    //      this.dialog = new builder.LuisDialog(config.dialog.api);
    this.dialog = new builder.CommandDialog();
    this.bot.add('/', this.dialog);
    this.compress = true;

    this.eptCloudExtension = new EptCloudExtension(eptcloud, gid);
    this.eptCloudExtension.run(); // auto update group info from cloud

    this.sensorConfig = config.controller.sensor;

    this.rateLimiter = this.setupRateLimit();

    //flow.summaryhours
    sysManager.update()

    setInterval(() => {
      try {
        if (global.gc) {
          global.gc();
        }
      } catch (e) {
      }
    }, 1000 * 60);

    setTimeout(() => {
      setInterval(() => {
        //          this.refreshCache(); // keep cache refreshed every 50 seconds so that app will load data fast
      }, 50 * 1000);
    }, 30 * 1000)

    this.hostManager = new HostManager();
    this.hostManager.loadPolicy((err, data) => { });  //load policy

    this.networkProfileManager = require('../net2/NetworkProfileManager.js');
    this.tagManager = require('../net2/TagManager.js');
    this.identityManager = require('../net2/IdentityManager.js');
    this.virtWanGroupManager = require('../net2/VirtWanGroupManager.js');

    let c = require('../net2/MessageBus.js');
    this.messageBus = new c('debug');

    sem.on('Alarm:NewAlarm', async (event) => {
      let alarm, notifMsg;
      try {
        alarm = await am2.getAlarm(event.alarmID)
        notifMsg = alarm.localizedNotification();
      }
      catch (err) {
        log.error("Failed to fetch alarm", event, err)
        return
      }

      if (!notifMsg) return;

      log.info("Sending notification: " + JSON.stringify(alarm));
      if (this.hostManager.policy && this.hostManager.policy["notify"]) {
        if (this.hostManager.policy['notify']['state'] == false) {
          log.info("ALARM_NOTIFY_GLOBALL_BLOCKED", alarm);
          return;
        }
        if (alarm.type) {
          let alarmType = alarm.type;
          if (alarmType === "ALARM_LARGE_UPLOAD") {
            alarmType = "ALARM_BEHAVIOR";
          }
          if (this.hostManager.policy["notify"][alarmType] === false ||
            this.hostManager.policy["notify"][alarmType] === 0
          ) {
            log.info("ALARM_NOTIFY_BLOCKED", alarm);
            return;
          }
        }
      }

      log.info("ALARM_NOTIFY_PASSED");

      notifMsg = {
        title: i18n.__(alarm.getNotifType()),
        body: notifMsg
      }

      let data = {
        gid: this.primarygid,
        notifType: "ALARM"
      };

      if (alarm.aid) {
        data.aid = alarm.aid;
        data.alarmID = alarm.aid;
      }

      if (alarm.result_method === "auto" && alarm.result === "block") {
        data.category = "com.firewalla.category.autoblockalarm";
      } else {
        if (alarm.getManagementType() === "") {
          // default category
          data.category = "com.firewalla.category.alarm";
        } else {
          data.category = "com.firewalla.category.alarm." + alarm.getManagementType();
        }
      }

      if (data.gid) {
        data["thread-id"] = data.gid;
      }

      // check if device name should be included, sometimes it is helpful if multiple devices are bound to one app
      if (alarm["p.monkey"] && alarm["p.monkey"] == 1) {
        notifMsg.title = `[Monkey] ${notifMsg.title}`;
      }

      const pa = alarm.cloudAction();
      if (pa && f.isDevelopmentVersion()) {
        notifMsg.body = `${notifMsg.body} - Cloud Action ${pa}`;
      }

      if (alarm) {
        const includeNameInNotification = await rclient.hgetAsync("sys:config", "includeNameInNotification");
        const newArray = alarm.localizedNotificationTitleArray().slice(0);
        if (includeNameInNotification === "1") {
          newArray.push(`[${this.getDeviceName()}] `);
        } else {
          newArray.push("");
        }

        notifMsg["title-loc-key"] = alarm.localizedNotificationTitleKey();
        notifMsg["title-loc-args"] = newArray;
        notifMsg["loc-key"] = alarm.localizedNotificationContentKey();
        notifMsg["loc-args"] = alarm.localizedNotificationContentArray();
        notifMsg["title_loc_key"] = alarm.localizedNotificationTitleKey().replace(/[.:-]/g, '_');
        notifMsg["title_loc_args"] = newArray;
        notifMsg["body_loc_key"] = alarm.localizedNotificationContentKey().replace(/[.:-]/g, '_');
        notifMsg["body_loc_args"] = alarm.localizedNotificationContentArray();

        delete notifMsg.title;
        delete notifMsg.body;
      }

      this.tx2(this.primarygid, "test", notifMsg, data);

    });

    sem.on("FW_NOTIFICATION", async (event) => {
      const titleKey = event.titleKey;
      const bodyKey = event.bodyKey;
      const payload = event.payload;

      if (!titleKey || !bodyKey || !payload) {
        return;
      }

      const notifyMsg = {
      };

      if (event.titleLocalKey) {
        notifyMsg["title-loc-key"] = `notif.title.${event.titleLocalKey}`;
        notifyMsg["title_loc_key"] = notifyMsg["title-loc-key"].replace(/[.:-]/g, '_');

        let titleArgs = [];

        if (event.titleLocalArgs) {
          titleArgs = event.titleLocalArgs.slice(0);
        }

        const includeNameInNotification = await rclient.hgetAsync("sys:config", "includeNameInNotification");
        if (includeNameInNotification === "1") {
          titleArgs.push(`[${this.getDeviceName()}] `);
        } else {
          titleArgs.push("");
        }
        notifyMsg["title-loc-args"] = titleArgs;
        notifyMsg["title_loc_args"] = titleArgs;
      }

      if (event.bodyLocalKey) {
        notifyMsg["loc-key"] = `notif.content.${event.bodyLocalKey}`;
        notifyMsg["body_loc_key"] = notifyMsg["loc-key"].replace(/[.:-]/g, '_');

        if (event.bodyLocalArgs) {
          notifyMsg["loc-args"] = event.bodyLocalArgs;
          notifyMsg["body_loc_args"] = event.bodyLocalArgs;
        }
      }

      const data = {
        gid: this.primarygid,
      };

      this.tx2(this.primarygid, "", notifyMsg, data);
    });

    setTimeout(async () => {
      let branchChanged = await sysManager.isBranchJustChanged();
      let upgradeInfo = await upgradeManager.getUpgradeInfo();
      log.debug('isBranchJustChanged:', branchChanged, ', upgradeInfo:', upgradeInfo);

      if (upgradeInfo.upgraded) {
        if (fc.isMajorVersion()) {
          sem.sendEventToFireApi({
            type: 'FW_NOTIFICATION',
            titleKey: 'NOTIF_UPGRADE_COMPLETE_TITLE',
            bodyKey: 'NOTIF_UPGRADE_COMPLETE',
            titleLocalKey: 'SOFTWARE_UPGRADE',
            bodyLocalKey: `SOFTWARE_UPGRADE`,
            bodyLocalArgs: [fc.getSimpleVersion()],
            payload: {
              version: fc.getSimpleVersion()
            }
          });
        }

        try {
          log.info("add action event on firewalla_upgrade");
          const eventRequest = {
            "ts": Date.now(),
            "event_type": "action",
            "action_type": "firewalla_upgrade",
            "action_value": 1,
            "labels": { "version": fc.getSimpleVersion() }
          }
          await ea.addEvent(eventRequest, eventRequest.ts);
        } catch (err) {
          log.error("failed to add action event on firewalla_upgrade:", err);
        }

        upgradeManager.updateVersionTag();
      }
      else {
        if (sysManager.systemRebootedByUser(true)) {
          if (nm.canNotify() == true) {
            sem.sendEventToFireApi({
              type: 'FW_NOTIFICATION',
              titleKey: 'NOTIF_REBOOT_COMPLETE_TITLE',
              bodyKey: 'NOTIF_REBOOT_COMPLETE',
              titleLocalKey: 'REBOOT',
              bodyLocalKey: 'REBOOT',
              payload: {}
            });
          }
        } else if (sysManager.systemRebootedDueToIssue(true) == false) {
          if (nm.canNotify() == true) {
            sem.sendEventToFireApi({
              type: 'FW_NOTIFICATION',
              titleKey: 'NOTIF_AWAKES',
              bodyKey: 'NOTIF_AWAKES_BODY',
              titleLocalKey: 'AWAKEN',
              bodyLocalKey: 'AWAKEN',
              payload: {}
            });
          }
        }
      }

      this.setupDialog();
    }, 20 * 1000);

    sclient.on("message", (channel, msg) => {
      log.silly("Msg", channel, msg);
      switch (channel) {
        case "System:Upgrade:Hard":
          if (msg) {
            let notifyMsg = {
              title: "Upgrade Needed",
              body: "Firewalla new version " + msg + " is avaliable, please open firewalla app then tap on settings->upgrade.",
            }
            let data = {
              gid: this.primarygid,
            };
            this.tx2(this.primarygid, "", notifyMsg, data);
          }
          break;
        case "DNS:Down":
          if (msg) {
            const notifyMsg = {
              title: "DNS status check failed!",
              body: `DNS status check has failed ${msg} consecutive times.`
            }
            const data = {
              gid: this.primarygid,
            };
            this.tx2(this.primarygid, "", notifyMsg, data)
          }
          break;
        case "APP:NOTIFY":
          try {
            const jsonMessage = JSON.parse(msg);

            if (jsonMessage && jsonMessage.title && jsonMessage.body) {
              const { title, body } = jsonMessage
              const notifyMsg = { title, body }
              const data = {
                gid: this.primarygid,
              };
              this.tx2(this.primarygid, "", notifyMsg, data)
            }
          } catch (err) {
            log.error("Failed to parse app notify message:", msg, err);
          }
          break;
      }
    });
    sclient.subscribe("System:Upgrade:Hard");
    sclient.subscribe("SS:DOWN");
    sclient.subscribe("SS:FAILOVER");
    sclient.subscribe("SS:START:FAILED");
    sclient.subscribe("APP:NOTIFY");
  }

  boneMsgHandler(msg) {
    log.debug("Bone Message", JSON.stringify(msg));
    if (msg.type == "MSG" && msg.title) {
      let notifyMsg = {
        title: msg.title,
        body: msg.body
      }
      let data = {
        gid: this.primarygid,
        data: msg.data
      };
      this.tx2(this.primarygid, "", notifyMsg, data);
    } else if (msg.type == "CONTROL") {
      if (msg.control && msg.control === "reboot") {
        log.error("FIREWALLA REMOTE REBOOT");
        exec('sync & /home/pi/firewalla/scripts/fire-reboot-normal', (err, out, code) => {
        });
      } else if (msg.control && msg.control === "upgrade") {
        log.error("FIREWALLA REMOTE UPGRADE ");
        exec('sync & /home/pi/firewalla/scripts/upgrade', (err, out, code) => {
        });
      } else if (msg.control && msg.control === "clean_intel") {
        log.error("FIREWALLA CLEAN INTEL ");
        exec("redis-cli keys 'intel:ip:*' | xargs -n 100 redis-cli del", (err, out, code) => {
        });
      } else if (msg.control && msg.control === "ping") {
        log.error("FIREWALLA CLOUD PING ");
      } else if (msg.control && msg.control === "v6on") {
        exec('sync & touch /home/pi/.firewalla/config/enablev6', (err, out, code) => {
        });
      } else if (msg.control && msg.control === "v6off") {
        exec('sync & rm /home/pi/.firewalla/config/enablev6', (err, out, code) => {
        });
      } else if (msg.control && msg.control === "script") {
        exec('sync & /home/pi/firewalla/scripts/' + msg.command, (err, out, code) => {
        });
      } else if (msg.control && msg.control === "raw") {
        log.error("FIREWALLA CLOUD RAW ");
        // RAW commands will never / ever be ran on production
        if (sysManager.isSystemDebugOn() || !f.isProduction()) {
          if (msg.command) {
            log.error("FIREWALLA CLOUD RAW EXEC", msg.command);
            exec('sync & ' + msg.command, (err, out, code) => {
            });
          }
        }
      } else if (msg.control === 'cloud') {
        log.error("Firewalla Cloud");
        // cloud commands will never / ever be ran on production
        if (sysManager.isSystemDebugOn() || !f.isProduction()) {
          if (msg.command) {
            const cloudManager = require('../extension/cloud/CloudManager.js');
            cloudManager.run(msg.command, msg.info).catch((err) => {
              log.error("Got error when handling cloud action, err:", err);
            });
          }
        }
      }
    }
  }

  setHandler(gid, msg /*rawmsg.message.obj*/, callback = () => { }) {
    // mtype: set
    // target = "ip address" 0.0.0.0 is self
    // data.item = policy
    // data.value = {'block':1},
    //
    //       log.info("Set: ",gid,msg);

    // invalidate cache
    this.invalidateCache();
    if (extMgr.hasSet(msg.data.item)) {
      (async () => {
        const result = await extMgr.set(msg.data.item, msg, msg.data.value)
        this.simpleTxData(msg, result, null, callback)
      })().catch((err) => {
        log.error(err)
        this.simpleTxData(msg, null, err, callback)
      })
      return
    }

    let value = msg.data.value;
    switch (msg.data.item) {
      case "policy":
        (async () => {
          // further policy enforcer should be implemented in Host.js or PolicyManager.js
          const processorMap = {
            "ipAllocation": this._ipAllocation,
            "vpn": this._vpn,
            "shadowsocks": this._shadowsocks,
            "enhancedSpoof": this._enhancedSpoof,
            "vulScan": this._vulScan,
            "dnsmasq": this._dnsmasq,
            "externalAccess": this._externalAccess,
            "ssh": this._ssh,
            "notify": this._notify,
            "portforward": this._portforward,
            "upstreamDns": this._upstreamDns,
          }
          for (const o of Object.keys(value)) {
            if (processorMap[o]) {
              await util.promisify(processorMap[o]).bind(this)(msg.target, value[o])
              continue
            }

            const target = msg.target
            let policyData = value[o]

            log.info(o, target, policyData)
            if (o === "tags" && _.isArray(policyData)) {
              policyData = policyData.map(String);
            }

            if (target === "0.0.0.0") {
              await this.hostManager.setPolicyAsync(o, policyData);
              continue
            }

            if (target.startsWith("network:")) {
              const uuid = target.substring(8);
              const network = this.networkProfileManager.getNetworkProfile(uuid);
              if (network) {
                await network.loadPolicy();
                await network.setPolicy(o, policyData);
              }
            } else if (target.startsWith("tag:")) {
              const tagUid = target.substring(4);
              const tag = await this.tagManager.getTagByUid(tagUid);
              if (tag) {
                await tag.loadPolicy();
                await tag.setPolicy(o, policyData)
              }
            } else {
              if (this.identityManager.isGUID(target)) {
                const identity = this.identityManager.getIdentityByGUID(target);
                if (identity) {
                  await identity.loadPolicy();
                  await identity.setPolicy(o, policyData);
                } else {
                  throw new Error(`Identity GUID ${target} not found`);
                }
              } else {
                if (hostTool.isMacAddress(target)) {
                  let host = await this.hostManager.getHostAsync(target)
                  if (host) {
                    await host.loadPolicyAsync()
                    await host.setPolicyAsync(o, policyData)
                  } else {
                    throw new Error('Invalid host')
                  }
                } else {
                  throw new Error(`Unknow target ${target}`);
                }
              }
            }
          }
          log.info("Repling ", value);
          this._scheduleRedisBackgroundSave();
          this.simpleTxData(msg, value, null, callback);
        })().catch(err =>
          this.simpleTxData(msg, {}, err, callback)
        )
        break
      case "host": {
        //data.item = "host" test
        //data.value = "{ name: " "}"
        let data = msg.data;
        log.info("Setting Host", msg);
        let reply = {
          type: 'jsonmsg',
          mtype: 'init',
          id: uuid.v4(),
          expires: Math.floor(Date.now() / 1000) + 60 * 5,
          replyid: msg.id,
        };
        reply.code = 200;

        if (!data.value.name) {
          this.simpleTxData(msg, {}, new Error("host name required for setting name"), callback)
          return
        }

        (async () => {
          let ip = null;
          if (hostTool.isMacAddress(msg.target)) {
            const macAddress = msg.target
            log.info("set host name alias by mac address", macAddress);
            let macObject = {
              mac: macAddress,
              name: data.value.name
            }
            await hostTool.updateMACKey(macObject);
            const generateResult = await hostTool.generateLocalDomain(macAddress) || {};
            const localDomain = generateResult.localDomain;
            sem.emitEvent({
              type: "LocalDomainUpdate",
              message: `Update device:${macAddress} localDomain`,
              macArr: [macAddress],
              toProcess: 'FireMain'
            });
            this.simpleTxData(msg, { localDomain }, null, callback)
            return

          } else {
            ip = msg.target
          }

          let host = await this.hostManager.getHostAsync(ip)

          if (!host) {
            this.simpleTxData(msg, {}, new Error("invalid host"), callback)
            return
          }

          if (data.value.name == host.o.name) {
            this.simpleTxData(msg, {}, null, callback)
            return
          }

          host.o.name = data.value.name
          log.info("Changing names", host.o.name);
          await host.save()
          this.simpleTxData(msg, {}, new Error("failed to save host name"), callback)

        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })

        break;
      }
      case "tag": {
        let data = msg.data;
        log.info("Setting tag", msg);

        if (!data.value.name) {
          this.simpleTxData(msg, {}, new Error("tag name required for setting name"), callback);
          return;
        }

        (async () => {
          const name = value.name;
          const tag = this.tagManager.getTagByUid(msg.target);

          if (!tag) {
            this.simpleTxData(msg, {}, new Error("invalid tag"), callback);
            return;
          }

          if (name == tag.getTagName()) {
            this.simpleTxData(msg, {}, null, callback);
            return;
          }

          const result = await this.tagManager.changeTagName(msg.target, name);
          log.info("Changing tag name", name);
          if (!result) {
            this.simpleTxData(msg, {}, new Error("Can't use already exsit tag name"), callback);
          } else {
            this.simpleTxData(msg, data.value, null, callback);
          }

        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })

        break;
      }
      case "hostDomain": {
        let data = msg.data;
        (async () => {
          if (hostTool.isMacAddress(msg.target) || msg.target == '0.0.0.0') {
            const macAddress = msg.target
            let { customizeDomainName, suffix } = data.value;
            if (customizeDomainName && hostTool.isMacAddress(macAddress)) {
              let macObject = {
                mac: macAddress,
                customizeDomainName: customizeDomainName
              }
              await hostTool.updateMACKey(macObject);
            }
            if (suffix && macAddress == '0.0.0.0') {
              await rclient.setAsync('local:domain:suffix', suffix);
            }
            let userLocalDomain;
            if (hostTool.isMacAddress(macAddress)) {
              const generateResult = await hostTool.generateLocalDomain(macAddress) || {};
              userLocalDomain = generateResult.userLocalDomain;
            }
            sem.emitEvent({
              type: "LocalDomainUpdate",
              message: `Update device:${macAddress} userLocalDomain`,
              macArr: [macAddress],
              toProcess: 'FireMain'
            });
            this.simpleTxData(msg, { userLocalDomain }, null, callback)
          } else {
            this.simpleTxData(msg, {}, new Error("Invalid mac address"), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      }
      case "timezone":
        if (value.timezone) {
          (async () => {
            const err = await sysManager.setTimezone(value.timezone);
            this.simpleTxData(msg, {}, err, callback);
          })();
        } else {
          this.simpleTxData(msg, {}, new Error("Invalid timezone"), callback);
        }
        break;
      case "includeNameInNotification": {
        let flag = "0";

        if (value.includeNameInNotification) {
          flag = "1"
        }

        (async () => {
          await rclient.hsetAsync("sys:config", "includeNameInNotification", flag)
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })

        break;
      }
      case "forceNotificationLocalization": {
        let flag = "0";

        if (value.forceNotificationLocalization) {
          flag = "1"
        }

        (async () => {
          await rclient.hsetAsync("sys:config", "forceNotificationLocalization", flag)
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      }
      case "mode": {
        let v4 = value;
        let err = null;
        if (v4.mode) {
          (async () => {
            let mode = require('../net2/Mode.js')
            let curMode = await mode.getSetupMode()
            if (v4.mode === curMode) {
              this.simpleTxData(msg, {}, err, callback);
              return
            }

            switch (v4.mode) {
              case "spoof":
              case "autoSpoof":
                await modeManager.setAutoSpoofAndPublish()
                break;
              case "dhcpSpoof":
                await modeManager.setDHCPSpoofAndPublish()
                break;
              case "manualSpoof":
                await modeManager.setManualSpoofAndPublish()
                break;
              case "dhcp":
                await modeManager.setDHCPAndPublish()
                break;
              case "router":
                await modeManager.setRouterAndPublish()
                break;
              case "none":
                await modeManager.setNoneAndPublish()
                break;
              default:
                log.error("unsupported mode: " + v4.mode);
                err = new Error("unsupport mode: " + v4.mode);
                break;
            }

            // force sysManager.update after set mode, this is to prevent device assigned in 218.*
            // can't be discovered by fireapi if sysManager.update is not called (Thanks to Annie)
            sysManager.update((err, data) => {
            });

            this._scheduleRedisBackgroundSave();

            this.simpleTxData(msg, {}, err, callback);
          })().catch((err) => {
            this.simpleTxData(msg, {}, err, callback);
          })
        }
        break;
      }
      case "userConfig":
        (async () => {
          const updatedPart = value || {};
          await fc.updateUserConfig(updatedPart);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "dataPlan":
        (async () => {
          const { total, date, enable } = value;
          let oldPlan = {};
          try {
            oldPlan = JSON.parse(await rclient.getAsync("sys:data:plan")) || {};
          } catch (e) {
          }
          const featureName = 'data_plan';
          oldPlan.enable = fc.isFeatureOn(featureName);
          if (enable) {
            await fc.enableDynamicFeature(featureName)
            await rclient.setAsync("sys:data:plan", JSON.stringify({ total: total, date: date }));
            await rclient.setAsync('monthly:data:usage:ready', '0');
            sem.emitEvent({
              type: "DataPlan:Updated",
              date: date,
              toProcess: "FireMain"
            });
          } else {
            await fc.disableDynamicFeature(featureName);
            await rclient.unlinkAsync("sys:data:plan");
          }
          if (!_.isEqual(oldPlan, value)) {
            await execAsync("redis-cli keys 'data:plan:*' | xargs redis-cli del");
          }
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "networkConfig": {
        (async () => {
          await FireRouter.setConfig(value.config, value.restart);
          // successfully set config, save config to history
          const latestConfig = await FireRouter.getConfig();
          await FireRouter.saveConfigHistory(latestConfig);
          this._scheduleRedisBackgroundSave();
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "eptGroupName": {
        (async () => {
          const { name } = value;
          const result = await this.eptcloud.rename(this.primarygid, name);
          if(result) {
            this.updatePrimaryDeviceName(name);
            this.simpleTxData(msg, {}, null, callback);
          } else {
            this.simpleTxData(msg, null, new Error("rename failed"), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "intelAdvice": {
        (async () => {
          const { target, ip, intel } = value
          intel.localIntel = await intelTool.getIntel(ip)
          await bone.intelAdvice({
            target: target,
            key: ip,
            value: intel,
          });
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "feedback": {
        (async () => {
          await bone.intelAdvice(value);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "cpuProfile": {
        (async () => {
          const { applyProfileName, profiles } = value;
          if (profiles && profiles.length > 0) {
            await cpuProfile.addProfiles(profiles);
          }
          if (applyProfileName) {
            await cpuProfile.applyProfile(applyProfileName);
          }
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      default:
        this.simpleTxData(msg, null, new Error("Unsupported set action"), callback);
        break;
    }
  }


  getAllIPForHost(ip, callback) {
    let listip = [];
    this.hostManager.getHost(ip, (err, host) => {
      if (host != null) {
        listip.push(host.o.ipv4Addr);
        if (host.ipv6Addr && host.ipv6Addr.length > 0) {
          for (let j in host['ipv6Addr']) {
            listip.push(host['ipv6Addr'][j]);
          }
        }
      }
      callback(err, listip);
    });
  }


  async processAppInfo(appInfo) {
    // if(appInfo.language) {
    //   if(sysManager.language !== appInfo.language) {
    //     await sysManager.setLanguageAsync(appInfo.language)
    //   }
    // }

    if (appInfo.deviceName && appInfo.eid) {
      const keyName = "sys:ept:memberNames"
      try {
        const device = await rclient.hgetAsync(keyName, appInfo.eid)
        if (!device) {
          const len = await rclient.hlenAsync("sys:ept:members:history");
          if (len < pairedMaxHistoryEntry) {
            const historyStr = await rclient.hgetAsync("sys:ept:members:history", appInfo.eid);
            let historyMsg;
            if (historyStr) historyMsg = JSON.parse(historyStr)["msg"]
            if (!historyMsg) historyMsg = "";
            const result = {};
            result["deviceName"] = appInfo.deviceName;
            const date = Math.floor(new Date() / 1000)
            result["msg"] = `${historyMsg}paired at ${date},`;
            await rclient.hsetAsync("sys:ept:members:history", appInfo.eid, JSON.stringify(result));
          }
        }
      } catch (err) {
        log.info("error when record paired device history info", err)
      }
      await rclient.hsetAsync(keyName, appInfo.eid, appInfo.deviceName)

      const keyName2 = "sys:ept:member:lastvisit"
      await rclient.hsetAsync(keyName2, appInfo.eid, Math.floor(new Date() / 1000))
    }

  }

  async checkLogQueryArgs(msg) {
    const options = Object.assign({}, msg.data);
    delete options.item
    delete options.type
    delete options.apiVer
    if (options.atype) {
      options.type = options.atype
      delete options.atype
    }

    if (msg.data.type == 'tag') {
      options.tag = msg.target;
    } else if (msg.data.type == 'intf') {
      options.intf = msg.target;
    } else if (msg.target != '0.0.0.0') {
      options.mac = msg.target
    }

    return options
  }

  getHandler(gid, msg, appInfo, callback) {

    // backward compatible
    if (typeof appInfo === 'function') {
      callback = appInfo;
      appInfo = undefined;
    }

    if (appInfo) {
      this.processAppInfo(appInfo)
    }

    if (!msg.data) {
      this.simpleTxData(msg, null, new Error("Malformed request"), callback);
      return
    }

    // mtype: get
    // target = ip address
    // data.item = [app, alarms, host]
    if (extMgr.hasGet(msg.data.item)) {
      (async () => {
        const result = await extMgr.get(msg.data.item, msg, msg.data.value)
        this.simpleTxData(msg, result, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback)
      })
      return
    }

    const value = msg.data.value;
    const apiVer = msg.data.apiVer;

    switch (msg.data.item) {
      case "host":
      case "tag":
      case "intf":
        if (msg.target) {
          log.info(`Loading ${msg.data.item} info: ${msg.target}`);
          msg.data.begin = msg.data.begin || msg.data.start;
          delete msg.data.start
          this.flowHandler(msg, msg.data.item)
            .then((json) => {
              this.simpleTxData(msg, json, null, callback);
            })
            .catch((err) => {
              this.simpleTxData(msg, null, err, callback);
            })
        }
        break;
      case "flows":
        (async () => {
          // options:
          //  count: number of entries returned, default 100
          //  ts: timestamp used to query alarms, default to now
          //  asc: return results in ascending order, default to false
          //  begin/end: time range used to query, will be ommitted when ts is set
          //  type: 'tag' || 'intf' || 'host' (undefined)
          //  atype: 'ip' || 'dns'
          //  direction: 'in' || 'out' || 'lo'
          //  ... all other possible fields ...
          //
          //  note that if a field filter is given, all entries without that field are filtered

          const options = await this.checkLogQueryArgs(msg)

          if (options.start && !options.begin) {
            options.begin = options.start;
            delete options.start
          }

          const flows = await flowTool.prepareRecentFlows({}, options)
          if (!apiVer || apiVer == 1) flows.forEach(f => {
            if (f.ltype == 'flow') delete f.type
          })
          const data = {
            count: flows.length,
            flows,
            nextTs: flows.length ? flows[flows.length - 1].ts : null
          }
          this.simpleTxData(msg, data, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      case "auditLogs": // arguments are the same as get flows
        (async () => {

          const options = await this.checkLogQueryArgs(msg)

          const logs = await auditTool.getAuditLogs(options)
          let data = {
            count: logs.length,
            logs,
            nextTs: logs.length ? logs[logs.length - 1].ts : null
          }
          this.simpleTxData(msg, data, null, callback);
        })().catch(err => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      case "topFlows":
        (async () => {
          //  count: tox x flows
          //  target: mac address || intf:uuid || tag:tagId
          const value = msg.data.value;
          const count = value && value.count || 50;
          const flows = await this.hostManager.loadStats({}, msg.target, count);
          this.simpleTxData(msg, { flows: flows }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      case "mypubkey": {
        this.simpleTxData(msg, { key: this.eptcloud && this.eptcloud.mypubkey() }, null, callback);
        break;
      }
      case "vpn":
      case "vpnreset": {
        let regenerate = false
        if (msg.data.item === "vpnreset") {
          regenerate = true;
        }
        this.hostManager.loadPolicy((err, data) => {
          let datamodel = {};
          if (err != null) {
            log.error("Failed to load system policy for VPN", err);
            // msg.data.item = "device"
            this.simpleTxData(msg, null, err, callback)
          } else {
            const vpnConfig = JSON.parse(data["vpn"] || "{}");
            let externalPort = "1194";
            if (vpnConfig && vpnConfig.externalPort)
              externalPort = vpnConfig.externalPort;
            const protocol = vpnConfig && vpnConfig.protocol;
            const ddnsConfig = JSON.parse(data["ddns"] || "{}");
            const ddnsEnabled = ddnsConfig.hasOwnProperty("state") ? ddnsConfig.state : true;
            VpnManager.configureClient("fishboneVPN1", null).then(() => {
              VpnManager.getOvpnFile("fishboneVPN1", null, regenerate, externalPort, protocol, ddnsEnabled, (err, ovpnfile, password, timestamp) => {
                if (err == null) {
                  datamodel.data = {
                    ovpnfile: ovpnfile,
                    password: password,
                    portmapped: JSON.parse(data['vpnPortmapped'] || "false"),
                    timestamp: timestamp
                  };
                  (async () => {
                    const doublenat = await rclient.getAsync("ext.doublenat");
                    if (doublenat !== null) {
                      datamodel.data.doublenat = doublenat;
                    }
                    msg.data.item = "device"
                    this.simpleTxData(msg, datamodel.data, null, callback);
                  })();
                } else {
                  this.simpleTxData(msg, null, err, callback)
                }
              });
            }).catch((err) => {
              log.error("Failed to get ovpn profile", err);
              this.simpleTxData(msg, null, err, callback)
            })
          }
        });
        break;
      }
      case "shadowsocks":
      case "shadowsocksResetConfig": {
        let shadowsocks = require('../extension/shadowsocks/shadowsocks.js');
        let ss = new shadowsocks('info');

        if (msg.data.item === "shadowsocksResetConfig") {
          ss.refreshConfig();
        }

        let config = ss.readConfig();
        this.simpleTxData(msg, { config: config }, null, callback)
        break;
      }
      case "generateRSAPublicKey": {
        const identity = value.identity;
        (async () => {
          const regenerate = value.regenerate;
          const prevKey = await ssh.getRSAPublicKey(identity);
          if (prevKey === null || regenerate) {
            await ssh.generateRSAKeyPair(identity);
            const pubKey = await ssh.getRSAPublicKey(identity);
            this.simpleTxData(msg, { publicKey: pubKey }, null, callback);
          } else this.simpleTxData(msg, { publicKey: prevKey }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "sshPrivateKey":

        ssh.getPrivateKey((err, data) => {
          if (err) {
            log.error("Got error when loading ssh private key: " + err);
            data = "";
          }
          this.simpleTxData(msg, { key: data }, null, callback);
        });
        break;
      case "sshRecentPassword":
        ssh.loadPassword().then((obj) => {
          this.simpleTxData(msg, obj, null, callback);
        }).catch((err) => {
          log.error("Got error when loading password", err);
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "sysInfo":
        this.simpleTxData(msg, SysInfo.getSysInfo(), null, callback);
        break;
      case "logFiles":
        SysInfo.getRecentLogs().then(results => {
          this.simpleTxData(msg, results, null, callback);
        }).catch(err => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "language":
        this.simpleTxData(msg, { language: sysManager.language }, null, callback);
        break;
      case "timezone":
        this.simpleTxData(msg, { timezone: sysManager.timezone }, null, callback);
        break;
      case "alarms":
        am2.loadActiveAlarms(value, (err, alarms) => {
          this.simpleTxData(msg, { alarms: alarms, count: alarms.length }, err, callback);
        });
        break;
      case "loadAlarmsWithRange":
        (async () => {
          //value {bedin:'',end:''}
          const result = await am2.loadAlarmsWithRange(value);
          this.simpleTxData(msg, result, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "fetchNewAlarms":
        (async () => {
          const sinceTS = value.sinceTS;
          const timeout = value.timeout || 60;
          const alarms = await am2.fetchNewAlarms(sinceTS, { timeout });
          this.simpleTxData(msg, { alarms: alarms, count: alarms.length }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "alarm":
        am2.getAlarm(value.alarmID)
          .then((alarm) => this.simpleTxData(msg, alarm, null, callback))
          .catch((err) => this.simpleTxData(msg, null, err, callback));
        break;
      case "alarmDetail": {
        (async () => {
          const alarmID = value.alarmID;
          if (alarmID) {
            const basic = await am2.getAlarm(alarmID);
            const detail = (await am2.getAlarmDetail(alarmID)) || {};
            this.simpleTxData(msg, Object.assign({}, basic, detail), null, callback);
          } else {
            this.simpleTxData(msg, {}, new Error("Missing alarm ID"), callback);
          }
        })().catch((err) => this.simpleTxData(msg, null, err, callback));
        break;
      }
      case "selfCheck": {
        (async () => {
          const sc = require("../diagnostic/selfcheck.js");
          const result = await sc.check();
          this.simpleTxData(msg, result, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      }
      case "blockCheck": {
        const ipOrDomain = value.ipOrDomain;
        (async () => {
          const rc = require("../diagnostic/rulecheck.js");
          const result = await rc.checkIpOrDomain(ipOrDomain);
          this.simpleTxData(msg, result, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      }
      case "transferTrend": {
        const deviceMac = value.deviceMac;
        const destIP = value.destIP;
        (async () => {
          if (destIP && deviceMac) {
            const transfers = await flowTool.getTransferTrend(deviceMac, destIP);
            this.simpleTxData(msg, transfers, null, callback);
          } else {
            this.simpleTxData(msg, {}, new Error("Missing device MAC or destination IP"), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      }
      case "archivedAlarms": {
        const offset = value && value.offset;
        const limit = value && value.limit;

        (async () => {
          const archivedAlarms = await am2.loadArchivedAlarms({
            offset: offset,
            limit: limit
          })
          this.simpleTxData(msg,
            {
              alarms: archivedAlarms,
              count: archivedAlarms.length
            },
            null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      }
      case "exceptions":
        em.loadExceptions((err, exceptions) => {
          this.simpleTxData(msg, { exceptions: exceptions, count: exceptions.length }, err, callback);
        });
        break;
      case "frpConfig": {
        let _config = frp.getConfig()
        if (_config.started) {
          ssh.loadPassword().then((obj) => {
            _config.password = obj && obj.password;
            this.simpleTxData(msg, _config, null, callback);
          }).catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          })
        } else {
          this.simpleTxData(msg, _config, null, callback);
        }
        break;
      }
      case "upstreamDns":
        (async () => {
          let response;
          try {
            response = await policyManager.getUpstreamDns();
            log.info("upstream dns response", response);
            this.simpleTxData(msg, response, null, callback);
          } catch (err) {
            log.error("Error when get upstream dns configs", err);
            this.simpleTxData(msg, {}, err, callback);
          }
        })();
        break;
      case "linkedDomains":
        (async () => {
          const target = value.target;
          const isDomainPattern = value.isDomainPattern || false;
          if (!target) {
            this.simpleTxData(msg, {}, { code: 400, msg: "'target' should be specified." }, callback);
          } else {
            const domains = await dnsTool.getLinkedDomains(target, isDomainPattern);
            this.simpleTxData(msg, { domains: domains }, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      case "liveCategoryDomains":
        (async () => {
          const category = value.category
          const domains = await categoryUpdater.getDomainsWithExpireTime(category)
          this.simpleTxData(msg, { domains: domains }, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "liveCategoryDomainsWithoutExcluded":
        (async () => {
          const category = value.category
          const domains = await categoryUpdater.getDomainsWithExpireTime(category)
          const excludedDomains = await categoryUpdater.getExcludedDomains(category)
          const defaultDomains = await categoryUpdater.getDefaultDomains(category)
          const includedDomains = await categoryUpdater.getIncludedDomains(category)

          const finalDomains = domains.filter(d => !defaultDomains.includes(d.domain)).concat(defaultDomains.map((d) => {
            return { domain: d, expire: 0 };
          })).filter(d => !excludedDomains.includes(d.domain));

          let compareFuction = (x, y) => {
            if (!x || !y) {
              return 0;
            }

            let a = x.domain
            let b = y.domain

            if (!a || !b) {
              return 0;
            }

            if (a.startsWith("*.")) {
              a = a.substring(2)
            }
            if (b.startsWith("*.")) {
              b = b.substring(2)
            }

            if (a.toLowerCase() > b.toLowerCase()) {
              return 1
            } else if (a.toLowerCase() < b.toLowerCase()) {
              return -1
            } else {
              return 0
            }
          };

          let sortedFinalDomains = finalDomains.sort(compareFuction)

          const patternDomains = sortedFinalDomains.filter((de) => {
            return de.domain.startsWith("*.")
          }).map((de) => de.domain.substring(2))

          // dedup battle.net if battle.net and *.battle.net co-exist
          const outputDomains = sortedFinalDomains.filter((de) => {
            const domain = de.domain
            if (excludedDomains.includes(domain)) return false;
            if (!domain.startsWith("*.") && patternDomains.includes(domain)) {
              return false;
            } else {
              return true;
            }
          })

          this.simpleTxData(msg, { domains: outputDomains, includes: includedDomains }, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "includedDomains":
        (async () => {
          const category = value.category
          const domains = await categoryUpdater.getIncludedDomains(category)
          this.simpleTxData(msg, { domains: domains }, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "excludedDomains":
        (async () => {
          const category = value.category
          const domains = await categoryUpdater.getExcludedDomains(category)
          this.simpleTxData(msg, { domains: domains }, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "includedElements": {
        (async () => {
          const category = value.category;
          const elements = await categoryUpdater.getIncludedElements(category);
          this.simpleTxData(msg, { elements: elements }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        });
        break;
      }
      case "customizedCategories": {
        (async () => {
          const categories = await categoryUpdater.getCustomizedCategories();
          this.simpleTxData(msg, { categories: categories }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        });
        break;
      }
      case "whois":
        (async () => {
          const target = value.target;
          let whois = await intelManager.whois(target);
          this.simpleTxData(msg, { target, whois }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "ipinfo":
        (async () => {
          const ip = value.ip;
          let ipinfo = intelManager.ipinfo(ip);
          this.simpleTxData(msg, { ip, ipinfo }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "proToken":
        (async () => {
          this.simpleTxData(msg, { token: tokenManager.getToken(gid) }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "policies":
        pm2.loadActivePolicies((err, list) => {
          if (err) {
            this.simpleTxData(msg, {}, err, callback);
          } else {
            let alarmIDs = list.map((p) => p.aid);
            am2.idsToAlarms(alarmIDs, (err, alarms) => {
              if (err) {
                log.error("Failed to get alarms by ids:", err);
                this.simpleTxData(msg, {}, err, callback);
                return;
              }

              for (let i = 0; i < list.length; i++) {
                if (list[i] && alarms[i]) {
                  list[i].alarmMessage = alarms[i].localizedInfo();
                  list[i].alarmTimestamp = alarms[i].timestamp;
                }
              }
              this.simpleTxData(msg, { policies: list }, null, callback);
            });
          }
        });
        break;
      case "hosts": {
        let hosts = {};
        this.hostManager.getHosts(() => {
          this.hostManager.legacyHostsStats(hosts)
            .then(() => {
              this.simpleTxData(msg, hosts, null, callback);
            }).catch((err) => {
              this.simpleTxData(msg, {}, err, callback);
            });
        });
        break;
      }
      case "vpnProfile":
      case "ovpnProfile": {
        const type = (value && value.type) || "openvpn";
        const profileId = value.profileId;
        if (!profileId) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'profileId' should be specified." }, callback);
          return;
        }
        const c = VPNClient.getClass(type);
        if (!c) {
          this.simpleTxData(msg, {}, { code: 400, msg: `Unsupported VPN client type: ${type}` });
          return;
        }
        (async () => {
          // backward compatibility in case api call payload does not contain type, directly use singleton in VPNClient.js based on profileId if available
          let vpnClient = VPNClient.getInstance(profileId);
          if (!vpnClient) {
            const exists = await c.profileExists(profileId);
            if (!exists) {
              this.simpleTxData(msg, {}, { code: 404, msg: "Specified profileId is not found." }, callback);
              return;
            }
            vpnClient = new c({ profileId });
          }
          const attributes = await vpnClient.getAttributes(true);
          this.simpleTxData(msg, attributes, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "vpnProfiles":
      case "ovpnProfiles": {
        const types = (value && value.types) || ["openvpn"];
        if (!Array.isArray(types)) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'types' should be an array." }, callback);
          return;
        }
        (async () => {
          let profiles = [];
          for (let type of types) {
            const c = VPNClient.getClass(type);
            if (!c) {
              log.error(`Unsupported VPN client type: ${type}`);
              continue;
            }
            const profileIds = await c.listProfileIds();
            Array.prototype.push.apply(profiles, await Promise.all(profileIds.map(profileId => new c({ profileId }).getAttributes())));
          }
          this.simpleTxData(msg, { "profiles": profiles }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "country:supported":
        rclient.smembersAsync('country:list').then(list => {
          this.simpleTxData(msg, { supported: list }, null, callback);
        }).catch(err => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      case "publicIp":
        traceroute.trace(value.checkHost || "8.8.8.8", (err, hops, destination) => {
          if (err) {
            this.simpleTxData(msg, {}, err, callback);
          } else {
            let secondStepIp = hops[1] ? hops[1].ip : "";
            let isPublic = iptool.isPublic(secondStepIp);
            this.simpleTxData(msg, { hops: hops, secondStepIp: secondStepIp, isPublic: isPublic, destination: destination }, null, callback);
          }
        })
        break;
      case "networkStatus":
        (async () => {
          const ping = await rclient.hgetallAsync("network:status:ping");
          const dig = await rclient.getAsync("network:status:dig");
          const speedtestResult = (await speedtest()) || {};
          const { download, upload, server } = speedtestResult;
          this.simpleTxData(msg, {
            ping: ping,
            dig: JSON.parse(dig),
            gigabit: await platform.getNetworkSpeed() >= 1000,
            speedtest: {
              download: download,
              upload: upload,
              server: server
            }
          }, null, callback);
        })();
        break;
      case "monthlyDataUsage":
        (async () => {
          let target = msg.target;
          if (!target || target == '0.0.0.0') {
            target = null;
          } else {
            target = target.toUpperCase();
          }
          const { download, upload, totalDownload, totalUpload,
            monthlyBeginTs, monthlyEndTs } = await this.hostManager.monthlyDataStats(target);
          this.simpleTxData(msg, {
            download: download,
            upload: upload,
            totalDownload: totalDownload,
            totalUpload: totalUpload,
            monthlyBeginTs: monthlyBeginTs,
            monthlyEndTs: monthlyEndTs
          }, null, callback)
        })();
        break;
      case "dataPlan":
        (async () => {
          const featureName = 'data_plan';
          let dataPlan = await rclient.getAsync('sys:data:plan');
          const enable = fc.isFeatureOn(featureName)
          if (dataPlan) {
            dataPlan = JSON.parse(dataPlan);
          } else {
            dataPlan = {}
          }
          this.simpleTxData(msg, { dataPlan: dataPlan, enable: enable }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "network:filenames": {
        (async () => {
          const filenames = await FireRouter.getFilenames();
          this.simpleTxData(msg, { filenames: filenames }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "networkConfig": {
        (async () => {
          const config = await FireRouter.getConfig();
          this.simpleTxData(msg, config, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "networkConfigHistory": {
        (async () => {
          const count = value.count || 10;
          const history = await FireRouter.loadRecentConfigFromHistory(count);
          this.simpleTxData(msg, { history: history }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "networkConfigImpact": {
        (async () => {
          const result = FireRouter.checkConfig(value.config);
          this.simpleTxData(msg, result, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "networkState": {
        (async () => {
          const live = value.live || false;
          const networks = await FireRouter.getInterfaceAll(live);
          this.simpleTxData(msg, networks, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "availableWlans": {
        (async () => {
          const wlans = await FireRouter.getAvailableWlans()
          this.simpleTxData(msg, wlans, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, [], err, callback);
        });
        break;
      }
      case "wlanChannels": {
        (async () => {
          const channels = await FireRouter.getWlanChannels()
          this.simpleTxData(msg, channels, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "wanConnectivity": {
        (async () => {
          const status = await FireRouter.getWanConnectivity(value.live);
          this.simpleTxData(msg, status, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "wanInterfaces": {
        (async () => {
          const wanInterfaces = await FireRouter.getSystemWANInterfaces();
          this.simpleTxData(msg, wanInterfaces, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "eptGroup": {
        (async () => {
          const result = await this.eptcloud.groupFind(this.primarygid);
          if (!result) throw new Error('Group not found!')

          // write members to sys:ept:members
          await this.eptCloudExtension.recordAllRegisteredClients(this.primarygid)
          const resp = { groupName: result.group.name }
          // read from sys:ept:members
          await this.hostManager.encipherMembersForInit(resp)
          this.simpleTxData(msg, resp, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "branchUpdateTime": {
        (async () => {
          const branches = (value && value.branches) || ['beta_6_0', 'release_6_0', 'release_7_0'];
          const result = {};
          for (const branch of branches) {
            result[branch] = await sysManager.getBranchUpdateTime(branch);
          }
          this.simpleTxData(msg, result, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      default:
        this.simpleTxData(msg, null, new Error("unsupported action"), callback);
    }
  }

  async validateFlowAppIntel(json) {
    return;

    // await bone.flowgraphAsync(...)
    let flows = json.flows

    let hashCache = {}

    let appFlows = flows.appDetails

    if (Object.keys(appFlows).length > 0) {
      flowUtil.hashIntelFlows(appFlows, hashCache)

      let data;
      try {
        data = await bone.flowgraphAsync('summarizeApp', appFlows)
      } catch (err) {
        log.error("Error when summarizing flowgraph for app", err);
      }

      if (data) {
        flows.appDetails = flowUtil.unhashIntelFlows(data, hashCache)
      }
    }
  }

  async validateFlowCategoryIntel(json) {
    return;

    // await bone.flowgraphAsync(...)
    let flows = json.flows

    let hashCache = {}

    let categoryFlows = flows.categoryDetails

    if (Object.keys(categoryFlows).length > 0) {
      flowUtil.hashIntelFlows(categoryFlows, hashCache)

      let data;
      try {
        data = await bone.flowgraphAsync('summarizeActivity', categoryFlows)
      } catch (err) {
        log.error("Error when summarizing flowgraph for activity", err);
      }

      if (data) {
        flows.categoryDetails = flowUtil.unhashIntelFlows(data, hashCache)
      }
    }
  }

  async flowHandler(msg, type) {
    let { target } = msg
    log.info("Getting info on", type, target);

    let begin = msg.data && (msg.data.begin || msg.data.start);
    let end = (msg.data && msg.data.end) || begin + 3600 * 24;

    // A backward compatibility fix for query host network stats for 'NOW'
    // extend it to a full hour if not enough
    if ((end - begin) < 3600 && msg.data.hourblock === 0) {
      end = begin + 3600;
    }

    let options = {}
    if (begin && end) {
      options.begin = begin
      options.end = end
    }

    // 0 => now, 1 => single hour stats, other => overall stats (last 24 hours)
    if (msg.data.hourblock != "1" && msg.data.hourblock != "0") {
      options.queryall = true
    }

    if (msg.data.audit) options.audit = true

    log.info(type, "FlowHandler FROM: ", new Date(begin * 1000).toLocaleTimeString());
    log.info(type, "FlowHandler TO: ", new Date(end * 1000).toLocaleTimeString());

    await this.hostManager.getHostsAsync();
    let jsonobj = {}
    switch (type) {
      case 'tag': {
        const tag = this.tagManager.getTagByUid(target);
        if (!tag) throw new Error("Invalid Tag ID");
        options.tag = target;
        target = `${type}:${target}`
        jsonobj = tag.toJson();

        options.macs = await this.hostManager.getTagMacs(target);
        break
      }
      case 'intf': {
        const intf = this.networkProfileManager.getNetworkProfile(target);
        if (!intf) throw new Error("Invalid Network ID")
        options.intf = target;
        if (intf.o && (intf.o.intf === "tun_fwvpn" || intf.o.intf.startsWith("wg"))) {
          // add additional macs into options for VPN server network
          const allIdentities = this.identityManager.getIdentitiesByNicName(intf.o.intf);
          const macs = [];
          for (const ns of Object.keys(allIdentities)) {
            const identities = allIdentities[ns];
            for (const uid of Object.keys(identities)) {
              if (identities[uid])
                macs.push(this.identityManager.getGUID(identities[uid]));
            }
          }
          options.macs = macs;
        } else {
          options.macs = this.hostManager.getIntfMacs(options.intf);
        }
        target = `${type}:${target}`
        jsonobj = intf.toJson();
        break
      }
      case 'host': {
        if (target == '0.0.0.0') {
          const macs = this.hostManager.getActiveMACs();
          // add additional macs into options for identities
          const guids = this.identityManager.getAllIdentitiesGUID();
          options.macs = macs.concat(guids)
          break;
        }

        if (this.identityManager.isGUID(target)) {
          const identity = this.identityManager.getIdentityByGUID(target);
          if (!identity) {
            const error = new Error(`Identity GUID ${target} not found`);
            error.code = 404;
            throw error;
          }
          options.mac = this.identityManager.getGUID(identity);
          jsonobj = identity.toJson();
        } else if (target.startsWith(`${Constants.NS_INTERFACE}:`)) {
          const uuid = target.substring(Constants.NS_INTERFACE.length + 1)
          const intf = this.networkProfileManager.getNetworkProfile(uuid);
          if (!intf) throw new Error("Invalid Network ID")
          options.mac = target
          jsonobj = intf.toJson();
          break
        } else {
          const host = await this.hostManager.getHostAsync(target);
          if (!host || !host.o.mac) {
            let error = new Error("Invalid Host");
            error.code = 404;
            throw error;
          }
          options.mac = host.o.mac;
          jsonobj = host.toJson();
        }
        break
      }
      default:
        throw new Error('Invalid target type', type)
    }

    // target: 'uuid'
    const promises = [
      netBotTool.prepareTopUploadFlows(jsonobj, options),
      netBotTool.prepareTopDownloadFlows(jsonobj, options),
      // return more top flows for block statistics
      netBotTool.prepareTopFlows(jsonobj, 'dnsB', null, Object.assign({}, options, {limit: 400})),
      netBotTool.prepareTopFlows(jsonobj, 'ipB', "in", Object.assign({}, options, {limit: 400})),
      netBotTool.prepareTopFlows(jsonobj, 'ipB', "out", Object.assign({}, options, {limit: 400})),
      netBotTool.prepareTopFlows(jsonobj, 'ifB', "out", Object.assign({}, options, {limit: 400})),

      netBotTool.prepareDetailedFlowsFromCache(jsonobj, 'app', options),
      netBotTool.prepareDetailedFlowsFromCache(jsonobj, 'category', options),

      this.hostManager.last60MinStatsForInit(jsonobj, target),
      this.hostManager.last30daysStatsForInit(jsonobj, target),
      this.hostManager.newLast24StatsForInit(jsonobj, target),
      this.hostManager.last12MonthsStatsForInit(jsonobj, target),
    ]

    jsonobj.hosts = {}
    promises.push(asyncNative.eachLimit(options.macs, 20, async (t) => {
      if (msg.data.hourblock == 24) {
        const stats = await this.hostManager.getStats({ granularities: '1hour', hits: 24 }, t, ['upload','download'])
        jsonobj.hosts[t] = { upload: stats.totalUpload, download: stats.totalDownload }
      } else {
        const stats = await this.hostManager.getStats(
          { granularities: '1hour', hits: Math.ceil((Date.now()/1000 - options.begin) / 3600) },
          t, ['upload','download'])
        jsonobj.hosts[t] = {}
        for (const m of ['upload', 'download']) {
          const hit = stats[m] && stats[m].find(s => s[0] == options.begin)
          jsonobj.hosts[t][m] = hit && hit[1] || 0
        }
      }
    }))

    if (!msg.data.apiVer || msg.data.apiVer == 1) {
      promises.push(flowTool.prepareRecentFlows(jsonobj, _.omit(options, ['queryall'])))
    }

    // const platformSpecificStats = platform.getStatsSpecs();
    // jsonobj.stats = {};
    // for (const statSettings of platformSpecificStats) {
    //   promises.push(this.hostManager.getStats(statSettings, target)
    //     .then(s => jsonobj.stats[statSettings.stat] = s)
    //   );
    // }
    await Promise.all(promises)

    if (!msg.data.apiVer || msg.data.apiVer == 1) jsonobj.flows.recent.forEach(f => {
      if (f.ltype == 'flow') delete f.type
    })

    if (!jsonobj.flows['appDetails']) { // fallback to old way
      await netBotTool.prepareDetailedFlows(jsonobj, 'app', options)
      await this.validateFlowAppIntel(jsonobj)
    }

    if (!jsonobj.flows['categoryDetails']) { // fallback to old model
      await netBotTool.prepareDetailedFlows(jsonobj, 'category', options)
      await this.validateFlowCategoryIntel(jsonobj)
    }

    return jsonobj;
  }

  /*
   Received jsondata { mtype: 'cmd',
   id: '6C998946-ECC6-4535-90C5-E9525D4BB5B6',
   data: { item: 'reboot' },
   type: 'jsonmsg',
   target: '0.0.0.0' }
   */

  // Main Entry Point
  cmdHandler(gid, msg, callback) {

    if (msg && msg.data && msg.data.item === 'ping') {

    } else {
      log.info("API: CmdHandler ", gid, msg);
    }

    if (extMgr.hasCmd(msg.data.item)) {
      (async () => {
        let result = null;
        let err = null;
        try {
          result = await extMgr.cmd(msg.data.item, msg, msg.data.value);
        } catch (e) {
          err = e;
        } finally {
          this.simpleTxData(msg, result, err, callback)
        }
      })();
      return;
    }

    if (msg.data.item === "dhcpCheck") {
      (async () => {
        const mode = require('../net2/Mode.js');
        const dhcp = require("../extension/dhcp/dhcp.js");
        await mode.reloadSetupMode();
        const routerIP = sysManager.myDefaultGateway();
        let DHCPDiscover = false;
        if (routerIP) {
          DHCPDiscover = await dhcp.dhcpServerStatus(routerIP);
        }
        this.simpleTxData(msg, {
          DHCPMode: await mode.isDHCPModeOn(),
          DHCPDiscover: DHCPDiscover
        }, null, callback)
      })().catch((err) => {
        log.error("Failed to do DHCP discover", err);
        this.simpleTxData(msg, null, err, callback);
      });
      return;
    }
    if (msg.data.item === "reset") {
      (async () => {
        log.info("System Reset");
        platform.ledStartResetting();
        log.info("Resetting device...");
        const result = await DeviceMgmtTool.resetDevice(msg.data.value);
        if (result) {
          try {
            log.info("Sending reset response back to app before group is deleted...");
            // direct reply back to app that system is being reset
            await this.simpleTxData(msg, null, null, callback);

            log.info("Deleting Group...");
            // only delete group if reset device is really successful
            await DeviceMgmtTool.deleteGroup(this.eptcloud, this.primarygid);
            log.info("Group deleted");
          } catch(err) {
            log.error("Got error when deleting group, err:", err.message);
          }
        } else {
          this.simpleTxData(msg, {}, new Error("reset failed"), callback);
        }
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback);
      });
      return;
    } else if (msg.data.item === "sendlog") {
      log.info("sendLog");
      this._sendLog(msg, callback);
      return;
    } else if (msg.data.item === "resetSSHKey") {
      ssh.resetRSAPassword((err) => {
        this.simpleTxData(msg, null, null, callback)
      });
      return;
    }

    let value = msg.data.value;
    switch (msg.data.item) {
      case "upgrade":
        (async () => {
          sysTool.upgradeToLatest()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "shutdown":
        (async () => {
          sysTool.shutdownServices()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "shutdown:cancel":
        (async () => {
          await sysTool.cancelShutdown()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "reboot":
        (async () => {
          sysTool.rebootSystem()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "resetpolicy":
        (async () => {
          sysTool.resetPolicy()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "stopService":
        (async () => {
          await sysTool.stopServices();
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      case "startService":
        (async () => {
          // no need to await, otherwise fireapi will also be restarted
          sysTool.restartServices();
          sysTool.restartFireKickService();
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      case "restartFirereset":
        (async () => {
          await execAsync("sudo systemctl restart firereset");
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "restartFirestatus":
        (async () => {
          await execAsync("sudo systemctl restart firestatus");
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "restartBluetoothRTKService":
        (async () => {
          await execAsync("sudo systemctl restart rtk_hciuart");
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "cleanIntel":
        (async () => {
          await sysTool.cleanIntel();
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      case "rekey":
        (async () => {
          await this.eptcloud.reKeyForAll(gid);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "syncLegacyKeyToNewKey":
        (async () => {
          await this.eptcloud.syncLegacyKeyToNewKey(gid);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "checkIn":
        sem.sendEventToFireMain({
          type: "PublicIP:Check",
          message: ""
        });
        sem.once("PublicIP:Check:Complete", (e) => {
          log.info("public ip check is complete, check-in cloud now ...");
          sem.sendEventToFireMain({
            type: 'CloudReCheckin',
            message: "",
          });
          sem.once("CloudReCheckinComplete", async (event) => {
            let { ddns, publicIp } = await rclient.hgetallAsync('sys:network:info')
            try {
              ddns = JSON.parse(ddns);
              publicIp = JSON.parse(publicIp);
            } catch (err) {
              log.error("Failed to parse strings:", ddns, publicIp);
            }
            this.simpleTxData(msg, { ddns, publicIp }, null, callback);
          });
        });
        break;
      case "debugOn":
        sysManager.debugOn((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "debugOff":
        sysManager.debugOff((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "resetSSHPassword":
        ssh.resetRandomPassword().then((obj) => {
          this.simpleTxData(msg, null, null, callback);
        }).catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;

      case "ping": {
        let uptime = process.uptime();
        let now = new Date();
        this.simpleTxData(msg, {
          uptime: uptime,
          timestamp: now
        }, null, callback)
        break;
      }
      case "tag:create": {
        (async () => {
          if (!value || !value.name)
            this.simpleTxData(msg, {}, { code: 400, msg: "'name' is not specified." }, callback);
          else {
            const name = value.name;
            const obj = value.obj;
            const tag = await this.tagManager.createTag(name, obj);
            this.simpleTxData(msg, tag, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "tag:remove": {
        (async () => {
          if (!value || !value.name)
            this.simpleTxData(msg, {}, { code: 400, msg: "'name' is not specified" }, callback);
          else {
            const name = value.name;
            await this.tagManager.removeTag(name);
            this.simpleTxData(msg, {}, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "alarm:block":
        am2.blockFromAlarm(value.alarmID, value, (err, result) => {
          if (err) {
            this.simpleTxData(msg, {}, err, callback);
          } else {
            const { policy, otherBlockedAlarms, alreadyExists } = result

            // only return other matched alarms matchAll is set, originally for backward compatibility
            // matchAll is not used for blocking check
            if (value.matchAll) {
              this.simpleTxData(msg, {
                policy: policy,
                otherAlarms: otherBlockedAlarms,
                alreadyExists: alreadyExists === "duplicated",
                updated: alreadyExists === "duplicated_and_updated"
              }, err, callback);
            } else {
              this.simpleTxData(msg, policy, err, callback);
            }
          }
        });
        break;
      case "alarm:allow":
        am2.allowFromAlarm(value.alarmID, value, (err, exception, otherAlarms, alreadyExists) => {
          if (value && value.matchAll) { // only return other matched alarms if this option is on, for better backward compatibility
            this.simpleTxData(msg, {
              exception: exception,
              otherAlarms: otherAlarms,
              alreadyExists: alreadyExists
            }, err, callback);
          } else {
            this.simpleTxData(msg, exception, err, callback);
          }
        });
        break;
      case "alarm:unblock":
        am2.unblockFromAlarm(value.alarmID, value, (err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "alarm:unallow":
        am2.unallowFromAlarm(value.alarmID, value, (err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;

      case "alarm:unblock_and_allow":
        am2.unblockFromAlarm(value.alarmID, value, (err) => {
          if (err) {
            log.error("Failed to unblock", value.alarmID, ", err:", err);
            this.simpleTxData(msg, {}, err, callback);
            return;
          }

          am2.allowFromAlarm(value.alarmID, value, (err) => {
            if (err) {
              log.error("Failed to allow", value.alarmID, ", err:", err);
            }
            this.simpleTxData(msg, {}, err, callback);
          });
        });
        break;

      case "alarm:ignore":
        (async () => {
          const ignoreIds = await am2.ignoreAlarm(value.alarmID, value || {})
          this.simpleTxData(msg, { ignoreIds: ignoreIds }, null, callback)
        })().catch((err) => {
          log.error("Failed to ignore alarm:", err)
          this.simpleTxData(msg, {}, err, callback)
        })
        break

      case "alarm:ignoreAll":
        (async () => {
          await am2.ignoreAllAlarmAsync();
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          log.error("Failed to ignoreAll alarm:", err)
          this.simpleTxData(msg, {}, err, callback)
        })
        break;

      case "alarm:report":
        (async () => {
          await am2.reportBug(value.alarmID, value.feedback)
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          log.error("Failed to report bug on alarm:", err)
          this.simpleTxData(msg, {}, err, callback)
        })
        break

      case "alarm:delete":
        try {
          (async () => {
            const alarmIDs = value.alarmIDs;
            if (alarmIDs && _.isArray(alarmIDs)) {
              for (const alarmID of alarmIDs) {
                alarmID && await am2.removeAlarmAsync(alarmID);
              }
            } else {
              await am2.removeAlarmAsync(value.alarmID);
            }
            this.simpleTxData(msg, {}, null, callback)
          })()
        } catch (err) {
          log.error("Failed to delete alarm:", err)
          this.simpleTxData(msg, null, err, callback)
        }
        break;

      case "alarm:deleteActiveAll":
        (async () => {
          await am2.deleteActiveAllAsync();
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          log.error("Failed to deleteActiveAll alarm:", err)
          this.simpleTxData(msg, {}, err, callback)
        })
        break;

      case "alarm:deleteArchivedAll":
        (async () => {
          await am2.deleteArchivedAllAsync();
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          log.error("Failed to deleteArchivedAll alarm:", err)
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      case "alarm:archiveByException":
        (async () => {
          const exceptionID = value.exceptionID;
          const result = await am2.archiveAlarmByExceptionAsync(exceptionID);
          this.simpleTxData(msg, result, null, callback)
        })().catch((err) => {
          log.error("Failed to archive alarm by exception:", err)
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      case "policy:create": {
        let policy
        try {
          policy = new Policy(value)
        } catch (err) {
          log.error('Error creating policy', err);
          this.simpleTxData(msg, null, err, callback);
          return;
        }

        pm2.checkAndSave(policy, (err, policy2, alreadyExists) => {
          if (alreadyExists == "duplicated") {
            this.simpleTxData(msg, policy2, { code: 409, msg: "Policy already exists" }, callback)
            return
          } else if (alreadyExists == "duplicated_and_updated") {
            const p = JSON.parse(JSON.stringify(policy2))
            p.updated = true // a kind hacky, but works
            sem.emitEvent({
              type: "Policy:Updated",
              pid: policy2.pid,
              toProcess: "FireMain"
            });
            this.simpleTxData(msg, p, err, callback)
          } else {
            this._scheduleRedisBackgroundSave();
            this.simpleTxData(msg, policy2, err, callback)
          }
        });
        break;
      }

      case "policy:update":
        (async () => {
          const policy = value

          const pid = policy.pid
          const oldPolicy = await pm2.getPolicy(pid)
          const policyObj = new Policy(Object.assign({}, oldPolicy, policy));
          const samePolicies = await pm2.getSamePolicies(policyObj);
          if (_.isArray(samePolicies) && samePolicies.filter(p => p.pid != pid).length > 0) {
            this.simpleTxData(msg, samePolicies[0], { code: 409, msg: "policy already exists" }, callback);
          } else {
            await pm2.updatePolicyAsync(policy)
            const newPolicy = await pm2.getPolicy(pid)
            pm2.tryPolicyEnforcement(newPolicy, 'reenforce', oldPolicy)
            sem.emitEvent({
              type: "Policy:Updated",
              pid: pid,
              toProcess: "FireMain"
            });
            this._scheduleRedisBackgroundSave();
            this.simpleTxData(msg, newPolicy, null, callback)
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })

        break;
      case "policy:delete":
        (async () => {
          const policyIDs = value.policyIDs;
          if (policyIDs && _.isArray(policyIDs)) {
            let results = {};
            for (const policyID of policyIDs) {
              let policy = await pm2.getPolicy(policyID);
              if (policy) {
                await pm2.disableAndDeletePolicy(policyID)
                policy.deleted = true;
                results[policyID] = policy;
              } else {
                results[policyID] = "invalid policy";
              }
            }
            this._scheduleRedisBackgroundSave();
            this.simpleTxData(msg, results, null, callback);
          } else {
            let policy = await pm2.getPolicy(value.policyID)
            if (policy) {
              await pm2.disableAndDeletePolicy(value.policyID)
              policy.deleted = true // policy is marked ask deleted
              this._scheduleRedisBackgroundSave();
              this.simpleTxData(msg, policy, null, callback);
            } else {
              this.simpleTxData(msg, null, new Error("invalid policy"), callback);
            }
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      case "policy:batch":
        (async () => {
          /*
            actions: {create: [policy instance], delete: [policy instance], update:[policyID]}
          */
          const actions = value.actions;
          if (actions) {
            const result = await pm2.batchPolicy(actions)
            this._scheduleRedisBackgroundSave();
            this.simpleTxData(msg, result, null, callback);
          } else {
            this.simpleTxData(msg, null, new Error("invalid actions"), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      case "policy:enable":
        (async () => {
          const policyID = value.policyID
          if (policyID) {
            let policy = await pm2.getPolicy(value.policyID)
            if (policy) {
              await pm2.enablePolicy(policy)
              this.simpleTxData(msg, policy, null, callback);
            } else {
              this.simpleTxData(msg, null, new Error("invalid policy"), callback);
            }
          } else {
            this.simpleTxData(msg, null, new Error("invalid policy ID"), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      case "policy:disable":
        (async () => {
          const policyID = value.policyID
          if (policyID) {
            let policy = await pm2.getPolicy(value.policyID)
            if (policy) {
              await pm2.disablePolicy(policy)
              this.simpleTxData(msg, policy, null, callback);
            } else {
              this.simpleTxData(msg, null, new Error("invalid policy"), callback);
            }
          } else {
            this.simpleTxData(msg, null, new Error("invalid policy ID"), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      case "policy:resetStats":
        (async () => {
          const policyIDs = value.policyIDs;
          if (policyIDs && _.isArray(policyIDs)) {
            let results = {};
            results.reset = [];
            for (const policyID of policyIDs) {
              let policy = await pm2.getPolicy(policyID);
              if (policy) {
                await pm2.resetStats(policyID)
                results.reset.push(policyID);
              }
            }
            this.simpleTxData(msg, results, null, callback);
          } else {
            this.simpleTxData(msg, null, Error("Invalid request"), callback)
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      case "policy:search": {
        (async () => {
          const resultCheck = await pm2.checkSearchTarget(value.target);
          if (resultCheck.err != null) {
            this.simpleTxData(msg, null, resultCheck.err, callback)
            return;
          }

          let data = await pm2.searchPolicy(resultCheck.waitSearch, resultCheck.isDomain, value.target);
          data.exceptions = await em.searchException(value.target);
          if (resultCheck.isDomain) {
            data.dnsmasqs = await dnsmasq.searchDnsmasq(value.target);
          }
          this.simpleTxData(msg, data, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      }
      case "policy:setDisableAll": {
        (async () => {
          await pm2.setDisableAll(value.flag, value.expireMinute);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      }
      case "acl:check": {
        (async () => {
          const matchedRule = await pm2.checkACL(value.localMac, value.localPort, value.remoteType, value.remoteVal, value.remotePort, value.protocol, value.direction || "outbound");
          this.simpleTxData(msg, { matchedRule: matchedRule }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      }
      case "wifi:switch": {
        (async () => {
          if (!value.ssid || !value.intf) {
            this.simpleTxData(msg, {}, { code: 400, msg: "both 'ssid' and 'intf' should be specified" }, callback);
          } else {
            const resp = await FireRouter.switchWifi(value.intf, value.ssid, value.params, value.testOnly);
            if (resp && _.isArray(resp.errors) && resp.errors.length > 0) {
              this.simpleTxData(msg, { errors: resp.errors }, { code: 400, msg: `Failed to switch wifi on ${value.intf} to ${value.ssid}` }, callback);
            } else {
              this.simpleTxData(msg, {}, null, callback);
            }
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      }
      case "network:txt_file:save": {
        (async () => {
          if (!value.filename || !value.content) {
            this.simpleTxData(msg, {}, { code: 400, msg: "both 'filename' and 'content' should be specified" }, callback);
          } else {
            await FireRouter.saveTextFile(value.filename, value.content);
            this.simpleTxData(msg, {}, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      }
      case "network:txt_file:load": {
        (async () => {
          if (!value.filename) {
            this.simpleTxData(msg, {}, { code: 400, msg: "'filename' should be specified" }, callback);
          } else {
            const content = await FireRouter.loadTextFile(value.filename);
            this.simpleTxData(msg, { content: content }, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      }
      case "network:file:remove": {
        (async () => {
          if (!value.filename) {
            this.simpleTxData(msg, {}, { code: 400, msg: "'filename' should be specified" }, callback);
          } else {
            await FireRouter.removeFile(value.filename);
            this.simpleTxData(msg, {}, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      }
      case "intel:finger":
        (async () => {
          const target = value.target;
          if (target) {
            let result;
            try {
              result = await bone.intelFinger(target);
            } catch (err) {
              log.error("Error when intel finger", err);
            }
            if (result && result.whois) {
              this.simpleTxData(msg, result, null, callback);
            } else {
              this.simpleTxData(msg, null, new Error(`failed to fetch intel for target: ${target}`), callback);
            }
          } else {
            this.simpleTxData(msg, null, new Error(`invalid target: ${target}`), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      case 'customIntel:list':
        (async () => {
          const result = await intelTool.listCustomIntel(value.type)
          this.simpleTxData(msg, result, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break
      case 'customIntel:update':
        (async () => {
          const { target, type, del } = value
          const add = !del

          const intel = add ? value.intel : await intelTool.getCustomIntel(type, target)
          if (!intel) throw new Error('Intel not found')

          log.debug(add ? 'add' : 'remove', intel)

          await intelTool.updateCustomIntel(type, target, value.intel, add)

          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break
      case "exception:create":
        em.createException(value)
          .then((result) => {
            sem.sendEventToAll({
              type: "ExceptionChange",
              message: ""
            });
            this.simpleTxData(msg, result, null, callback);
          })
          .catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          });
        break;
      case "exception:update":
        em.updateException(value)
          .then((result) => {
            sem.sendEventToAll({
              type: "ExceptionChange",
              message: ""
            });
            this.simpleTxData(msg, result, null, callback);
          })
          .catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          });
        break;
      case "exception:delete":
        em.deleteException(value.exceptionID)
          .then(() => {
            sem.sendEventToAll({
              type: "ExceptionChange",
              message: ""
            });
            this.simpleTxData(msg, null, null, callback);
          }).catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          });
        break;
      case "reset":
        break;
      case "startSupport":
        (async () => {
          const timeout = (value && value.timeout) || null;
          let { config, errMsg } = await frp.remoteSupportStart(timeout);
          if (config.startCode == FRPSUCCESSCODE) {
            const obj = await ssh.resetRandomPassword();
            config.password = obj && obj.password;
            config.passwordTs = obj && obj.timestamp;
            this.simpleTxData(msg, config, null, callback);
          } else {
            this.simpleTxData(msg, config, errMsg.join(";"), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      case "stopSupport":
        (async () => {
          await frp.stop()
          await ssh.resetRandomPassword();
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      case "setManualSpoof":
        (async () => {
          let mac = value.mac
          let manualSpoof = value.manualSpoof ? "1" : "0"

          if (!mac) {
            this.simpleTxData(msg, null, new Error("invalid request"), callback)
            return
          }

          await hostTool.updateMACKey({
            mac: mac,
            manualSpoof: manualSpoof
          })

          let mode = require('../net2/Mode.js')
          if (await mode.isManualSpoofModeOn()) {
            await sm.loadManualSpoof(mac)
          }

          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break
      case "manualSpoofUpdate":
        (async () => {
          await modeManager.publishManualSpoofUpdate()
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break
      case "isSpoofRunning":
        (async () => {
          let timeout = value.timeout

          let running = false

          if (timeout) {
            let begin = new Date() / 1000;

            while (new Date() / 1000 < begin + timeout) {
              const secondsLeft = Math.floor((begin + timeout) - new Date() / 1000);
              log.info(`Checking if spoofing daemon is active... ${secondsLeft} seconds left`)
              running = await sm.isSpoofRunning()
              if (running) {
                break
              }
              await delay(1000)
            }

          } else {
            running = await sm.isSpoofRunning()
          }

          this.simpleTxData(msg, { running: running }, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break
      case "spoofMe":
        (async () => {
          let ip = value.ip
          let name = value.name

          if (iptool.isV4Format(ip)) {
            sem.emitEvent({
              type: "DeviceUpdate",
              message: `Manual submit a new device via API ${ip} ${name}`,
              host: {
                ipv4: ip,
                ipv4Addr: ip,
                bname: name,
                from: "spoofMe"
              },
              toProcess: 'FireMain'
            })

            this.simpleTxData(msg, {}, null, callback)
          } else {
            this.simpleTxData(msg, {}, new Error("Invalid IP Address"), callback)
          }

        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break
      case "validateSpoof": {
        (async () => {
          let ip = value.ip
          let timeout = value.timeout || 60 // by default, wait for 60 seconds

          // add current ip to spoof list
          await sm.directSpoof(ip)

          let begin = new Date() / 1000;

          let result = false

          while (new Date() / 1000 < begin + timeout) {
            log.info(`Checking if IP ${ip} is being spoofed, ${-1 * (new Date() / 1000 - (begin + timeout))} seconds left`)
            result = await sm.isSpoof(ip)
            if (result) {
              break
            }
            await delay(1000)
          }

          this.simpleTxData(msg, {
            result: result
          }, null, callback)

        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break
      }
      case "bootingComplete":
        (async () => {
          await f.setBootingComplete()
          this._scheduleRedisBackgroundSave();
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break
      case "resetBootingComplete":
        (async () => {
          await f.resetBootingComplete()
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break
      case "joinBeta":
        (async () => {
          await this.switchBranch("beta")
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      case "leaveBeta":
        (async () => {
          await this.switchBranch("prod")
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      case "switchBranch":
        (async () => {
          await this.switchBranch(value.target)
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "switchFirmwareBranch":
        (async () => {
          await FireRouter.switchBranch(value.target);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "enableBinding":
        sysTool.restartFireKickService()
          .then(() => {
            this.simpleTxData(msg, {}, null, callback)
          })
          .catch((err) => {
            this.simpleTxData(msg, {}, err, callback)
          })
        break
      case "disableBinding":
        sysTool.stopFireKickService()
          .then(() => {
            this.simpleTxData(msg, {}, null, callback)
          })
          .catch((err) => {
            this.simpleTxData(msg, {}, err, callback)
          })
        break
      case "isBindingActive": {
        (async () => {
          try {
            const active = await sysTool.isFireKickRunning();
            this.simpleTxData(msg, { active }, null, callback);
          } catch (err) {
            this.simpleTxData(msg, {}, err, callback)
          }
        })();
        break;
      }
      case "enableFeature": {
        const featureName = value.featureName;
        (async () => {
          if (featureName) {
            await fc.enableDynamicFeature(featureName)
          }
        })().then(() => {
          this.simpleTxData(msg, {}, null, callback)
        })
          .catch((err) => {
            this.simpleTxData(msg, {}, err, callback)
          })
        break
      }
      case "disableFeature": {
        const featureName = value.featureName;
        (async () => {
          if (featureName) {
            await fc.disableDynamicFeature(featureName)
          }
        })().then(() => {
          this.simpleTxData(msg, {}, null, callback)
        })
          .catch((err) => {
            this.simpleTxData(msg, {}, err, callback)
          })
        break
      }
      case "clearFeatureDynamicFlag": {
        const featureName = value.featureName;
        (async () => {
          if (featureName) {
            await fc.clearDynamicFeature(featureName)
          }
        })().then(() => {
          this.simpleTxData(msg, {}, null, callback)
        })
          .catch((err) => {
            this.simpleTxData(msg, {}, err, callback)
          })
        break
      }
      case "releaseMonkey": {
        (async () => {
          sem.emitEvent({
            type: "ReleaseMonkey",
            message: "Release a monkey to test system",
            toProcess: 'FireMain',
            monkeyType: value && value.monkeyType
          })
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      }
      case "reloadCategoryFromBone": {
        const category = value.category
        sem.emitEvent({
          type: "Categorty:ReloadFromBone", // force re-activate category
          category: category,
          toProcess: "FireMain"
        })
        this.simpleTxData(msg, {}, null, callback)
        break;
      }
      case "deleteCategory": {
        const category = value.category;
        if (category) {
          sem.emitEvent({
            type: "Category:Delete",
            category: category,
            toProcess: "FireMain"
          })
          this.simpleTxData(msg, {}, null, callback)
        } else {
          this.simpleTxData(msg, {}, { code: 400, msg: `Invalid category: ${category}` }, callback);
        }

        break;
      }
      case "addIncludeDomain": {
        (async () => {
          const category = value.category
          let domain = value.domain
          const regex = /^[-a-zA-Z0-9.*]+?/;
          if (!regex.test(domain)) {
            this.simpleTxData(msg, {}, { code: 400, msg: "Invalid domain." }, callback);
            return;
          }

          domain = domain.toLowerCase();
          await categoryUpdater.addIncludedDomain(category, domain)
          const event = {
            type: "UPDATE_CATEGORY_DOMAIN",
            category: category,
            domain: domain,
            action: "addIncludeDomain"
          }
          sem.sendEventToAll(event);
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      }
      case "removeIncludeDomain": {
        (async () => {
          const category = value.category
          const domain = value.domain
          await categoryUpdater.removeIncludedDomain(category, domain)
          const event = {
            type: "UPDATE_CATEGORY_DOMAIN",
            category: category,
            domain: domain,
            action: "removeIncludeDomain"
          };
          sem.sendEventToAll(event);
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      }
      case "addExcludeDomain": {
        (async () => {
          const category = value.category
          let domain = value.domain
          domain = domain.toLowerCase();
          await categoryUpdater.addExcludedDomain(category, domain)
          const event = {
            type: "UPDATE_CATEGORY_DOMAIN",
            domain: domain,
            action: "addExcludeDomain",
            category: category
          };
          sem.sendEventToAll(event);
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      }
      case "removeExcludeDomain": {
        (async () => {
          const category = value.category
          const domain = value.domain
          await categoryUpdater.removeExcludedDomain(category, domain)
          const event = {
            type: "UPDATE_CATEGORY_DOMAIN",
            domain: domain,
            action: "removeExcludeDomain",
            category: category
          };
          sem.sendEventToAll(event);
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      }
      case "updateIncludedElements": {
        (async () => {
          const category = value.category;
          const elements = value.elements;
          await categoryUpdater.updateIncludedElements(category, elements);
          const event = {
            type: "UPDATE_CATEGORY_DOMAIN",
            category: category
          };
          sem.sendEventToAll(event);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        });
        break;
      }
      case "createOrUpdateCustomizedCategory": {
        (async () => {
          const category = value.category;
          const obj = value.obj;
          const c = await categoryUpdater.createOrUpdateCustomizedCategory(category, obj);
          this.simpleTxData(msg, c, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        });
        break;
      }
      case "removeCustomizedCategory": {
        (async () => {
          const category = value.category;
          await categoryUpdater.removeCustomizedCategory(category);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "createOrUpdateRuleGroup": {
        (async () => {
          const uuid = value.uuid;
          const obj = value.obj;
          const rg = await pm2.createOrUpdateRuleGroup(uuid, obj);
          this.simpleTxData(msg, rg, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "removeRuleGroup": {
        (async () => {
          const uuid = value.uuid;
          await pm2.deleteRuleGroupRelatedPolicies(uuid);
          await pm2.removeRuleGroup(uuid);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "createOrUpdateVirtWanGroup": {
        (async () => {
          if (_.isEmpty(value.name) || _.isEmpty(value.wans) || _.isEmpty(value.type)) {
            this.simpleTxData(msg, {}, {code: 400, msg: "'name', 'wans' and 'type' should be specified"}, callback);
            return;
          }
          await this.virtWanGroupManager.createOrUpdateVirtWanGroup(value);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "removeVirtWanGroup": {
        (async () => {
          if (_.isEmpty(value.uuid)) {
            this.simpleTxData(msg, {}, {code: 400, msg: "'uuid' should be specified"}, callback);
            return;
          }
          await pm2.deleteVirtWanGroupRelatedPolicies(value.uuid);
          await this.virtWanGroupManager.removeVirtWanGroup(value.uuid);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "boneMessage": {
        this.boneMsgHandler(value);
        this.simpleTxData(msg, {}, null, callback);
        break;
      }

      case "generateProToken": {
        tokenManager.generateToken(gid);
        break;
      }
      case "revokeProToken": {
        tokenManager.revokeToken(gid);
        break;
      }
      case "vpnProfile:grant": {
        const cn = value.cn;
        const regenerate = value.regenerate || false;
        if (!cn) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'cn' is not specified." }, callback);
          return;
        }
        const matches = cn.match(/^[a-zA-Z0-9]+/g);
        if (cn.length > 32 || matches == null || matches.length != 1 || matches[0] !== cn) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'cn' should only contain alphanumeric letters and no longer than 32 characters." }, callback);
          return;
        }
        const settings = value.settings || {};
        (async () => {
          const allowCustomizedProfiles = platform.getAllowCustomizedProfiles() || 1;
          const allSettings = await VpnManager.getAllSettings();
          if (Object.keys(allSettings).filter((name) => {
            return name !== "fishboneVPN1" && name !== cn;
          }).length >= allowCustomizedProfiles) {
            // Only one customized VPN profile is supported currently besides default VPN profile fishboneVPN1
            this.simpleTxData(msg, {}, { code: 401, msg: `Only ${allowCustomizedProfiles} customized VPN profile${allowCustomizedProfiles > 1 ? 's are' : ' is'} supported.` }, callback);
          } else {
            const systemPolicy = await this.hostManager.loadPolicyAsync();
            const vpnConfig = JSON.parse(systemPolicy["vpn"] || "{}");
            let externalPort = "1194";
            if (vpnConfig && vpnConfig.externalPort)
              externalPort = vpnConfig.externalPort;
            const protocol = vpnConfig && vpnConfig.protocol;
            const ddnsConfig = JSON.parse(systemPolicy["ddns"] || "{}");
            const ddnsEnabled = ddnsConfig.hasOwnProperty("state") ? ddnsConfig.state : true;
            await VpnManager.configureClient(cn, settings).then(() => {
              VpnManager.getOvpnFile(cn, null, regenerate, externalPort, protocol, ddnsEnabled, (err, ovpnfile, password, timestamp) => {
                if (!err) {
                  this.simpleTxData(msg, { ovpnfile: ovpnfile, password: password, settings: settings, timestamp }, null, callback);
                } else {
                  this.simpleTxData(msg, null, err, callback);
                }
              });
            }).catch((err) => { // usually caused by invalid configuration
              log.error("Failed to grant vpn profile to " + cn, err);
              this.simpleTxData(msg, null, { code: 400, msg: err }, callback);
            });
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      }
      case "vpnProfile:delete": {
        const cn = value.cn;
        if (!cn) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'cn' is not specified." }, callback);
          return;
        }
        (async () => {
          await VpnManager.revokeOvpnFile(cn);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      }
      case "vpnProfile:get": {
        const cn = value.cn;
        if (!cn) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'cn' is not specified." }, callback);
          return;
        }
        (async () => {
          const settings = await VpnManager.getSettings(cn);
          if (!settings) {
            this.simpleTxData(msg, {}, { code: 404, msg: `VPN profile of ${cn} does not exist.` }, callback);
            return;
          }
          const systemPolicy = await this.hostManager.loadPolicyAsync();
          const vpnConfig = JSON.parse(systemPolicy["vpn"] || "{}");
          let externalPort = "1194";
          if (vpnConfig && vpnConfig.externalPort)
            externalPort = vpnConfig.externalPort;
          const protocol = vpnConfig && vpnConfig.protocol;
          const ddnsConfig = JSON.parse(systemPolicy["ddns"] || "{}");
          const ddnsEnabled = ddnsConfig.hasOwnProperty("state") ? ddnsConfig.state : true;
          VpnManager.getOvpnFile(cn, null, false, externalPort, protocol, ddnsEnabled, (err, ovpnfile, password, timestamp) => {
            if (!err) {
              this.simpleTxData(msg, { ovpnfile: ovpnfile, password: password, settings: settings, timestamp }, null, callback);
            } else {
              this.simpleTxData(msg, null, err, callback);
            }
          });
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      }
      case "vpnProfile:list": {
        (async () => {
          const allSettings = await VpnManager.getAllSettings();
          const statistics = await new VpnManager().getStatistics();
          const vpnProfiles = [];
          for (let cn in allSettings) {
            // special handling for common name starting with fishboneVPN1
            const timestamp = await VpnManager.getVpnConfigureTimestamp(cn);
            vpnProfiles.push({ cn: cn, settings: allSettings[cn], connections: statistics && statistics.clients && Array.isArray(statistics.clients) && statistics.clients.filter(c => (cn === "fishboneVPN1" && c.cn.startsWith(cn)) || c.cn === cn) || [], timestamp: timestamp });
          }
          this.simpleTxData(msg, vpnProfiles, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      }
      case "vpnConnection:kill": {
        if (!value.addr) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'addr' is not specified." }, callback);
          return;
        }
        const addrPort = value.addr.split(":");
        if (addrPort.length != 2) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'addr' should consist of '<ip address>:<port>" }, callback);
          return;
        }
        const addr = addrPort[0];
        const port = addrPort[1];
        if (!iptool.isV4Format(addr) || Number.isNaN(port) || !Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) {
          this.simpleTxData(msg, {}, { code: 400, msg: "IP address should be IPv4 format and port should be in [0, 65535]" }, callback);
          return;
        }
        (async () => {
          await new VpnManager().killClient(value.addr);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      }
      case "startVpnClient": {
        const type = value.type;
        if (!type) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'type' is not specified." }, callback);
          return;
        }
        const profileId = value.profileId;
        if (!profileId) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'profileId' is not specified." }, callback);
          return;
        }
        const c = VPNClient.getClass(type);
        if (!c) {
          this.simpleTxData(msg, {}, { code: 400, msg: `Unsupported VPN client type: ${type}` });
          return;
        }
        const vpnClient = new c({profileId});
        (async () => {
          await vpnClient.setup().then(async () => {
            const {result, errMsg} = await vpnClient.start();
            if (!result) {
              await vpnClient.stop();
              // HTTP 408 stands for request timeout
              this.simpleTxData(msg, {}, { code: 408, msg: !_.isEmpty(errMsg) ? errMsg : `Failed to connect to ${vpnClient.getDisplayName()}, please check the profile settings and try again.` }, callback);
            } else {
              this.simpleTxData(msg, {}, null, callback);
            }
          }).catch((err) => {
            log.error(`Failed to start ${type} vpn client for ${profileId}`, err);
            this.simpleTxData(msg, {}, { code: 400, msg: _.isObject(err) ? err.message : err}, callback);
          });
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "stopVpnClient": {
        const type = value.type;
        if (!type) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'type' is not specified." }, callback);
          return;
        }
        const profileId = value.profileId;
        if (!profileId) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'profileId' is not specified." }, callback);
          return;
        }
        const c = VPNClient.getClass(type);
        if (!c) {
          this.simpleTxData(msg, {}, { code: 400, msg: `Unsupported VPN client type: ${type}` });
          return;
        }
        const vpnClient = new c({profileId});
        (async () => {
          // error in setup should not interrupt stop vpn client
          await vpnClient.setup().catch((err) => {
            log.error(`Failed to setup ${type} vpn client for ${profileId}`, err);
          });
          const stats = await vpnClient.getStatistics();
          await vpnClient.stop();
          this.simpleTxData(msg, { stats: stats }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "saveVpnProfile":
      case "saveOvpnProfile": {
        let type = value.type || "openvpn";
        const profileId = value.profileId;
        const settings = value.settings || {};
        if (!profileId) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'profileId' should be specified" }, callback);
          return;
        }
        const matches = profileId.match(/^[a-zA-Z0-9_]+/g);
        if (profileId.length > 10 || matches == null || matches.length != 1 || matches[0] !== profileId) {
          this.simpleTxData(msg, {}, { code: 400, msg: "'profileId' should only contain alphanumeric letters or underscore and no longer than 10 characters" }, callback);
          return;
        }
        const c = VPNClient.getClass(type);
        if (!c) {
          this.simpleTxData(msg, {}, { code: 400, msg: `Unsupported VPN client type: ${type}` });
          return;
        }
        const vpnClient = new c({profileId});
        (async () => {
          await vpnClient.checkAndSaveProfile(value);
          if (settings)
            await vpnClient.saveSettings(settings);
          await vpnClient.setup();
          const attributes = await vpnClient.getAttributes(true);
          this.simpleTxData(msg, attributes, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, { code: 400, msg: err.message }, callback);
        });
        break;
      }
      case "deleteVpnProfile":
      case "deleteOvpnProfile": {
        const type = value.type || "openvpn";
        const profileId = value.profileId;
        if (!profileId || profileId === "") {
          this.simpleTxData(msg, {}, { code: 400, msg: "'profileId' is not specified" }, callback);
          return;
        }
        const c = VPNClient.getClass(type);
        if (!c) {
          this.simpleTxData(msg, {}, { code: 400, msg: `Unsupported VPN client type: ${type}` });
          return;
        }
        const vpnClient = new c({profileId});
        (async () => {
          const status = await vpnClient.status();
          if (status) {
            this.simpleTxData(msg, {}, { code: 400, msg: `${type} VPN client ${profileId} is still running` }, callback);
          } else {
            await pm2.deleteVpnClientRelatedPolicies(profileId);
            await vpnClient.destroy();
            this.simpleTxData(msg, {}, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "dismissVersionUpdate": {
        (async () => {
          await sysManager.clearVersionUpdate();
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "saveRSAPublicKey": {
        const content = value.pubKey;
        const identity = value.identity;
        (async () => {
          await ssh.saveRSAPublicKey(content, identity);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "migration:export": {
        const partition = value.partition;
        const encryptionIdentity = value.encryptionIdentity;
        (async () => {
          await migration.exportDataPartition(partition, encryptionIdentity);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "migration:import": {
        const partition = value.partition;
        const encryptionIdentity = value.encryptionIdentity;
        (async () => {
          await migration.importDataPartition(partition, encryptionIdentity);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "migration:transfer": {
        const host = value.host;
        const partition = value.partition;
        const transferIdentity = value.transferIdentity;
        (async () => {
          await migration.transferDataPartition(host, partition, transferIdentity);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "migration:transferHiddenFolder": {
        const host = value.host;
        const transferIdentity = value.transferIdentity;
        (async () => {
          await migration.transferHiddenFolder(host, transferIdentity);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }

      case "enableWebToken": {
        (async () => {
          const tokenInfo = await fireWeb.enableWebToken(this.eptcloud);
          if (!tokenInfo.publicKey || !tokenInfo.privateKey) {
            this.simpleTxData(msg, {}, "publickKey and privateKey are required", callback);
            return;
          }
          this.simpleTxData(msg, tokenInfo, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "addPeers": {
        (async () => {
          const peers = value.peers;
          if (_.isEmpty(peers)) {
            this.simpleTxData(msg, {}, { code: 400, msg: `"peers" should not be empty` }, callback);
          } else {
            const results = [];
            const gid = await rclient.hgetAsync("sys:ept", "gid");
            await asyncNative.eachLimit(peers, 5, async (peer) => {
              const {type, name, eid} = peer;
              if (!eid)
                return;
              const success = await this.eptcloud.eptInviteGroup(gid, eid).then(() => true).catch((err) => {
                log.error(`Failed to invite ${eid} to group ${gid}`, err.message);
                return false;
              });
              const result = {eid, success};
              results.push(result);
              if (!success)
                return;
              await this.processAppInfo({eid: eid, deviceName: name || eid});
              switch (type) {
                case "user":
                  await clientMgmt.registerUser({eid});
                  break;
                case "web":
                  await clientMgmt.registerWeb({eid});
                  break;
                default:
                  log.error(`Unrecognized type for eid ${eid}: ${type}`);
              }
              await rclient.sremAsync(Constants.REDIS_KEY_EID_REVOKE_SET, eid);
            });
            await this.eptCloudExtension.updateGroupInfo(gid);
            this.simpleTxData(msg, {results}, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "removeUPnP": {
        (async () => {
          if (!platform.isFireRouterManaged()) {
            this.simpleTxData(msg, null, { code: 405, msg: "Remove UPnP is not supported on this platform" }, callback);
          } else {
            const type = value.type;
            switch (type) {
              case "single": {
                const { externalPort, internalIP, internalPort, protocol } = value;
                if (!externalPort || !internalIP || !internalPort || !protocol) {
                  this.simpleTxData(msg, null, { code: 400, msg: "Missing required parameters: externalPort, internalIP, internalPort, protocol" }, callback);
                } else {
                  await this._removeSingleUPnP(protocol, externalPort, internalIP, internalPort);
                  this.simpleTxData(msg, {}, null, callback);
                }
                break;
              }
              case "network": {
                const uuid = value.uuid;
                const intf = sysManager.getInterfaceViaUUID(uuid);
                if (!intf) {
                  this.simpleTxData(msg, null, { code: 404, msg: `Network with uuid ${uuid} is not found` }, callback);
                } else {
                  await this._removeUPnPByNetwork(intf.name);
                  this.simpleTxData(msg, {}, null, callback);
                }
                break;
              }
              case "all": {
                await this._removeAllUPnP();
                this.simpleTxData(msg, {}, null, callback);
                break;
              }
              default:
                this.simpleTxData(msg, null, { code: 400, msg: `Unknown operation type ${type}` }, callback);
            }
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "host:create": {
        (async () => {
          const host = value.host;
          if (!host || !host.mac) {
            this.simpleTxData(msg, null, { code: 400, msg: "'host' or 'host.mac' is not specified" }, callback);
            return;
          }
          // other attributes are not required, e.g., ip address, interface, stp port, they will be re-discovered later
          const savingKeysMap = {
            mac: "mac",
            macVendor: "macVendor",
            dhcpName: "dhcpName",
            bonjourName: "bonjourName",
            nmapName: "nmapName",
            ssdpName: "ssdpName",
            userLocalDomain: "userLocalDomain",
            localDomain: "localDomain",
            name: "name",
            modelName: "modelName",
            manufacturer: "manufacturer",
            bname: "bname"
          };
          const hostObj = {};
          for (const key of Object.keys(host)) {
            if (Object.keys(savingKeysMap).includes(key)) {
              if (!_.isString(host[key]))
                hostObj[savingKeysMap[key]] = JSON.stringify(host[key]);
              else
                hostObj[savingKeysMap[key]] = host[key];
            }
          }
          // set firstFound time as a activeTS for migration, so non-existing device could expire normal
          hostObj.firstFoundTimestamp = Date.now() / 1000;
          this.messageBus.publish("DiscoveryEvent", "Device:Create", hostObj.mac, hostObj);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "host:delete": {
        (async () => {
          const hostMac = value.mac.toUpperCase();
          log.info('host:delete', hostMac);
          const macExists = await hostTool.macExists(hostMac);
          if (macExists) {

            await pm2.deleteMacRelatedPolicies(hostMac);
            await em.deleteMacRelatedExceptions(hostMac);
            await am2.deleteMacRelatedAlarms(hostMac);
            await dnsmasq.deleteLeaseRecord(hostMac);

            await categoryFlowTool.delAllTypes(hostMac);
            await flowAggrTool.removeAggrFlowsAll(hostMac);
            await flowManager.removeFlowsAll(hostMac);

            let ips = await hostTool.getIPsByMac(hostMac);
            for (const ip of ips) {
              const latestMac = await hostTool.getMacByIP(ip);
              if (latestMac && latestMac === hostMac) {
                // double check to ensure ip address is not taken over by other device

                // simply remove monitor spec directly here instead of adding reference to FlowMonitor.js
                await rclient.unlinkAsync([
                  "monitor:flow:" + hostMac,
                  "monitor:large:" + hostMac,
                ]);
              }
            }
            // Since HostManager.getHosts() is resource heavy, it is not invoked here. It will be invoked once every 5 minutes.
            this.messageBus.publish("DiscoveryEvent", "Device:Delete", hostMac, {});

            this.simpleTxData(msg, {}, null, callback);
          } else {
            this.simpleTxData(msg, null, { code: 404, msg: "device not found" }, callback)
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      // only IPv4 is supported now.
      case "vipProfile:create": {
        (async () => {
          const uid = await vipManager.create(value)
          value.uid = uid
          this.simpleTxData(msg, value, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "vipProfile:delete": {
        (async () => {
          const uid = value.uid
          let configs = await vipManager.load();
          if (!configs.has(uid)) {
            this.simpleTxData(msg, {}, { code: 400, msg: "Vip identity not exists." }, callback);
            return;
          }
          await vipManager.delete(uid);

          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "networkInterface:update": {
        // secondary interface settings includes those in config files and dhcp address pool range
        (async () => {
          const network = msg.data.value.network;
          const intf = msg.data.value.interface;
          const dhcpRange = msg.data.value.dhcpRange;
          const dnsServers = msg.data.value.dnsServers || []; // default value is empty
          const dhcpLeaseTime = msg.data.value.dhcpLeaseTime;
          if (!network || !intf || !intf.ipAddress || !intf.subnetMask) {
            this.simpleTxData(msg, {}, { code: 400, msg: "network, interface.ipAddress/subnetMask should be specified." }, callback);
            return;
          }
          if (dhcpRange && (!dhcpRange.begin || !dhcpRange.end)) {
            this.simpleTxData(msg, {}, { code: 400, msg: "dhcpRange.start/end should be set at the same time." }, callback);
            return;
          }
          const currentConfig = await fc.getConfig(true);
          switch (network) {
            case "secondary": {
              const currentSecondaryInterface = currentConfig.secondaryInterface;
              const updatedConfig = { intf: currentConfig.monitoringInterface2 };
              const ipAddress = intf.ipAddress;
              const subnetMask = intf.subnetMask;
              const ipSubnet = iptool.subnet(ipAddress, subnetMask);
              updatedConfig.ip = ipAddress + "/" + ipSubnet.subnetMaskLength; // ip format is <ip_address>/<subnet_mask_length>
              const mergedSecondaryInterface = Object.assign({}, currentSecondaryInterface, updatedConfig); // if ip2 is not defined, it will be inherited from previous settings
              // redundant entries for backward compatitibility
              mergedSecondaryInterface.ipOnly = ipAddress;
              mergedSecondaryInterface.ipsubnet = ipSubnet.networkAddress + "/" + ipSubnet.subnetMaskLength;
              mergedSecondaryInterface.ipnet = ipAddress.substring(0, ipAddress.lastIndexOf("."));
              mergedSecondaryInterface.ipmask = subnetMask;
              if (mergedSecondaryInterface.ip2) {
                const ipSubnet2 = iptool.cidrSubnet(mergedSecondaryInterface.ip2);
                mergedSecondaryInterface.ip2Only = mergedSecondaryInterface.ip2.substring(0, mergedSecondaryInterface.ip2.lastIndexOf('/')); // e.g., 192.168.168.1
                mergedSecondaryInterface.ipsubnet2 = ipSubnet2.networkAddress + "/" + ipSubnet2.subnetMaskLength; // e.g., 192.168.168.0/24
                mergedSecondaryInterface.ipnet2 = mergedSecondaryInterface.ip2.substring(0, mergedSecondaryInterface.ip2.lastIndexOf(".")); // e.g., 192.168.168
                mergedSecondaryInterface.ipmask2 = ipSubnet2.subnetMask; // e.g., 255.255.255.0
              }
              let mergedUserConfig = { secondaryInterface: mergedSecondaryInterface };
              if (dhcpRange && dhcpLeaseTime) {
                mergedUserConfig.dhcpLeaseTime = Object.assign({}, currentConfig.dhcpLeaseTime, { secondary: dhcpLeaseTime });
              }
              await fc.updateUserConfig(mergedUserConfig);
              const dnsmasqPolicy = { secondaryDnsServers: dnsServers };
              if (dhcpRange)
                dnsmasqPolicy.secondaryDhcpRange = dhcpRange;
              this._dnsmasq("0.0.0.0", dnsmasqPolicy);
              setTimeout(() => {
                modeManager.publishNetworkInterfaceUpdate();
              }, 5000); // update interface in 5 seconds, otherwise FireApi response may not reach client
              this.simpleTxData(msg, {}, null, callback);
              break;
            }
            case "alternative": {
              const currentAlternativeInterface = currentConfig.alternativeInterface || { ip: sysManager.mySubnet(), gateway: sysManager.myDefaultGateway() }; // default value is current ip/subnet/gateway on monitoring interface
              const updatedAltConfig = { gateway: intf.gateway };
              const altIpAddress = intf.ipAddress;
              const altSubnetMask = intf.subnetMask;
              const altIpSubnet = iptool.subnet(altIpAddress, altSubnetMask);
              const mySubnet = sysManager.mySubnet();
              const currIpSubnet = iptool.cidrSubnet(mySubnet);
              const altIp = iptool.subnet(altIpAddress, altSubnetMask);
              if (!currIpSubnet.contains(altIp.networkAddress)
                || currIpSubnet.subnetMaskLength !== altIp.subnetMaskLength
                || !currIpSubnet.contains(intf.gateway)) {
                log.info("Change ip or gateway is not in current subnet, ignore")
                throw new Error("Invalid IP address or gateway");
              }
              updatedAltConfig.ip = altIpAddress + "/" + altIpSubnet.subnetMaskLength; // ip format is <ip_address>/<subnet_mask_length>
              const mergedAlternativeInterface = Object.assign({}, currentAlternativeInterface, updatedAltConfig);
              let mergedUserConfig = { alternativeInterface: mergedAlternativeInterface };
              if (dhcpRange && dhcpLeaseTime) {
                mergedUserConfig.dhcpLeaseTime = Object.assign({}, currentConfig.dhcpLeaseTime, { alternative: dhcpLeaseTime });
              }
              await fc.updateUserConfig(mergedUserConfig);
              const dnsmasqPolicy = { alternativeDnsServers: dnsServers };
              if (dhcpRange)
                dnsmasqPolicy.alternativeDhcpRange = dhcpRange;
              this._dnsmasq("0.0.0.0", dnsmasqPolicy);
              setTimeout(() => {
                modeManager.publishNetworkInterfaceUpdate();
              }, 5000); // update interface in 5 seconds, otherwise FireApi response may not reach client
              this.simpleTxData(msg, {}, null, callback);
              break;
            }
            default:
              log.error("Unknown network type in networkInterface:update, " + network);
              this.simpleTxData(msg, {}, { code: 400, msg: "Unknown network type: " + network }, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "networkInterface:reset": {
        // reset alternative interface to dhcp mode. It merely delete the user static address config is user config file. Need to restart box to take effect.
        (async () => {
          const network = msg.data.value.network;
          switch (network) {
            case "alternative": {
              await fc.removeUserConfig("alternativeInterface");
              break;
            }
          }
          // publish directly to update the "assignment" field in sys:network:info {itf} to expose current state to front end
          modeManager.publishNetworkInterfaceUpdate();

          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "networkInterface:revert": {
        (async () => {
          //remove user customized configuration
          await fc.removeUserNetworkConfig();
          //load policy
          const systemPolicy = await this.hostManager.loadPolicyAsync();
          const dnsmasqConfig = JSON.parse(systemPolicy["dnsmasq"] || "{}");
          log.info("dnsmasq", dnsmasqConfig);
          //delete related customized key
          delete dnsmasqConfig.alternativeDnsServers;
          delete dnsmasqConfig.alternativeDhcpRange;
          delete dnsmasqConfig.secondaryDnsServers;
          delete dnsmasqConfig.secondaryDhcpRange;
          delete dnsmasqConfig.wifiDnsServers;
          delete dnsmasqConfig.wifiDhcpRange;
          await this.hostManager.setPolicyAsync("dnsmasq", dnsmasqConfig);
          setTimeout(() => {
            let modeManager = require('../net2/ModeManager.js');
            modeManager.publishNetworkInterfaceUpdate();
          }, 5000); // update interface in 5 seconds, otherwise FireApi response may not reach client

          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "networkInterface:get": {
        (async () => {
          const network = msg.data.value.network;
          if (!network) {
            this.simpleTxData(msg, {}, { code: 400, msg: "network should be specified." }, callback);
          } else {
            const config = await fc.getConfig(true);
            let dhcpRange = await dnsTool.getDefaultDhcpRange(network);
            switch (network) {
              case "secondary": {
                // convert ip/subnet to ip address and subnet mask
                const secondaryInterface = config.secondaryInterface;
                const secondaryIpSubnet = iptool.cidrSubnet(secondaryInterface.ip);
                this.hostManager.loadPolicy((err, data) => {
                  let secondaryDnsServers = sysManager.myDefaultDns();
                  if (data.dnsmasq) {
                    const dnsmasq = JSON.parse(data.dnsmasq);
                    if (dnsmasq.secondaryDnsServers && dnsmasq.secondaryDnsServers.length !== 0) {
                      secondaryDnsServers = dnsmasq.secondaryDnsServers;
                    }
                    if (dnsmasq.secondaryDhcpRange) {
                      dhcpRange = dnsmasq.secondaryDhcpRange;
                    }
                  }
                  this.simpleTxData(msg,
                    {
                      interface: {
                        ipAddress: secondaryInterface.ip.split('/')[0],
                        subnetMask: secondaryIpSubnet.subnetMask
                      },
                      dhcpRange: dhcpRange,
                      dhcpLeaseTime: (config.dhcpLeaseTime && config.dhcpLeaseTime.secondary) || (config.dhcp && config.dhcp.leaseTime),
                      dnsServers: secondaryDnsServers
                    }, null, callback);
                });
                break;
              }
              case "alternative": {
                // convert ip/subnet to ip address and subnet mask
                const alternativeInterface = config.alternativeInterface || { ip: sysManager.mySubnet(), gateway: sysManager.myDefaultGateway() }; // default value is current ip/subnet/gateway on monitoring interface
                const alternativeIpSubnet = iptool.cidrSubnet(alternativeInterface.ip);
                this.hostManager.loadPolicy((err, data) => {
                  let alternativeDnsServers = sysManager.myDefaultDns();
                  if (data.dnsmasq) {
                    const dnsmasq = JSON.parse(data.dnsmasq);
                    if (dnsmasq.alternativeDnsServers && dnsmasq.alternativeDnsServers.length != 0) {
                      alternativeDnsServers = dnsmasq.alternativeDnsServers;
                    }
                    if (dnsmasq.alternativeDhcpRange) {
                      dhcpRange = dnsmasq.alternativeDhcpRange;
                    }
                  }
                  this.simpleTxData(msg,
                    {
                      interface: {
                        ipAddress: alternativeInterface.ip.split('/')[0],
                        subnetMask: alternativeIpSubnet.subnetMask,
                        gateway: alternativeInterface.gateway
                      },
                      dhcpRange: dhcpRange,
                      dhcpLeaseTime: (config.dhcpLeaseTime && config.dhcpLeaseTime.alternative) || (config.dhcp && config.dhcp.leaseTime),
                      dnsServers: alternativeDnsServers
                    }, null, callback);
                });
                break;
              }
              default:
                log.error("Unknwon network type in networkInterface:update, " + network);
                this.simpleTxData(msg, {}, { code: 400, msg: "Unknown network type: " + network });
            }
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "getConnTestDest": {
        (async () => {
          const dest = await conncheck.getDestToCheck();
          this.simpleTxData(msg, dest, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "startConnTest": {
        (async () => {
          if (!value.src || !value.src.ip) {
            this.simpleTxData(msg, {}, { code: 400, msg: "src.ip should be specified" }, callback);
            return;
          }
          if (!value.dst || !value.dst.ip || !value.dst.port) {
            this.simpleTxData(msg, {}, { code: 400, msg: "dst.ip and dst.port should be specified" }, callback);
            return;
          }
          const pid = await conncheck.startConnCheck(value.src, value.dst, value.duration);
          this.simpleTxData(msg, { pid: pid }, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "getConnTestResult": {
        (async () => {
          if (!value.pid) {
            this.simpleTxData(msg, {}, { code: 400, msg: "pid should be specified" }, callback);
            return;
          }
          const result = await conncheck.getConnCheckResult(value.pid);
          if (!result) {
            this.simpleTxData(msg, {}, { code: 404, msg: "Test result of specified pid is not found" }, callback);
          } else {
            this.simpleTxData(msg, result, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      }
      case "apt-get":
        (async () => {
          let cmd = `${f.getFirewallaHome()}/scripts/apt-get.sh`;
          if (value.execPreUpgrade) cmd = `${cmd} -pre "${value.execPreUpgrade}"`;
          if (value.execPostUpgrade) cmd = `${cmd} -pst "${value.execPostUpgrade}"`;
          if (value.noUpdate) cmd = cmd + ' -nu';
          if (value.noReboot) cmd = cmd + ' -nr';
          if (value.forceReboot) cmd = cmd + ' -fr';

          if (!value.action) throw new Error('Missing parameter "action"')

          cmd = `${cmd} ${value.action}`;

          log.info('Running apt-get', cmd)
          await execAsync(`(${cmd}) 2>&1 | sudo tee -a /var/log/fwapt.log `);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "ble:control":
        (async () => {
          await pclient.publishAsync(Message.MSG_FIRERESET_BLE_CONTROL_CHANNEL, value.state ? 1 : 0)
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      default:
        // unsupported action
        this.simpleTxData(msg, {}, new Error("Unsupported cmd action: " + msg.data.item), callback);
        break;
    }
  }

  async switchBranch(target) {
    if (this.switchingBranch) {
      throw new Error("Can not switch branch at the same time");
    }
    this.switchingBranch = true;
    let targetBranch = null
    let prodBranch = await f.getProdBranch()

    switch (target) {
      case "dev":
        targetBranch = "master";
        break;
      case "alpha":
        targetBranch = "beta_7_0";
        break;
      case "salpha":
        targetBranch = "beta_8_0";
        break;
      case "beta":
        targetBranch = prodBranch.replace("release_", "beta_")
        break;
      case "prod":
        targetBranch = prodBranch
        break;
      default:
        throw new Error("Can not switch to branch", target);
    }
    log.info("Going to switch to branch", targetBranch);
    try {
      await execAsync(`${f.getFirewallaHome()}/scripts/switch_branch.sh ${targetBranch}`)
      if (platform.isFireRouterManaged()) {
        // firerouter switch branch will trigger fireboot and restart firewalla services
        await FireRouter.switchBranch(target);
      } else {
        sysTool.upgradeToLatest()
      }
    } catch (e) { } finally {
      this.switchingBranch = false;
    }
  }

  async simpleTxData(msg, data, err, callback) {
    await this.txData(
      /* gid     */ this.primarygid,
      /* msg     */ msg.data.item,
      /* obj     */ this.getDefaultResponseDataModel(msg, data, err),
      /* type    */ "jsondata",
      /* beepmsg */ "",
      /* whisper */ null,
      /* callback*/ callback,
      /* rawmsg  */ msg
    );
  }

  getDefaultResponseDataModel(msg, data, err) {
    let code = 200;
    let message = "";
    if (err) {
      log.error("Got error before simpleTxData:", err);
      code = 500;
      if (err && err.code) {
        code = err.code;
      }
      message = err + "";
      if (err && err.msg) {
        message = err.msg;
      }
    }

    let datamodel = {
      type: 'jsonmsg',
      mtype: msg.mtype,
      id: uuid.v4(),
      expires: Math.floor(Date.now() / 1000) + 60 * 5,
      replyid: msg.id,
      rkeyts: this.eptcloud && this.eptcloud.getRKeyTimestamp(this.primarygid),
      code: code,
      data: data,
      message: message
    };
    return datamodel;
  }

  invalidateCache(callback) {
    callback = callback || function () {
    }

    rclient.unlink("init.cache", callback);
  }

  loadInitCache(callback) {
    callback = callback || function () { }

    rclient.get("init.cache", callback);
  }

  cacheInitData(json, callback) {
    callback = callback || function () { }

    let jsonString = JSON.stringify(json);
    let expireTime = 60; // cache for 1 min
    rclient.set("init.cache", jsonString, (err) => {
      if (err) {
        log.error("Failed to set init cache: " + err);
        callback(err);
        return;
      }

      rclient.expire("init.cache", expireTime, (err) => {
        if (err) {
          log.error("Failed to set expire time on init cache: " + err);
          callback(err);
          return;
        }

        log.info("init cache is refreshed, auto-expiring in ", expireTime, "seconds");

        callback(null);
      });

    });
  }

  async refreshCache() {
    if (this.hostManager) {
      try {
        const json = await this.hostManager.toJson()
        this.cacheInitData(json);
      } catch (err) {
        log.error("Failed to generate init data", err);
        return;
      }
    }
  }

  msgHandlerAsync(gid, rawmsg, from = 'app') {
    // msgHandlerAsync is direct callback mode
    // will return value directly, not send to cloud
    return new Promise((resolve, reject) => {
      let processed = false; // only callback once
      let ignoreRate = false;
      if (rawmsg && rawmsg.message && rawmsg.message.obj && rawmsg.message.obj.data) {
        ignoreRate = rawmsg.message.obj.data.ignoreRate;
        delete rawmsg.message.obj.data.ignoreRate;
      }
      if (ignoreRate) {
        log.info('ignore rate limit');
        this.msgHandler(gid, rawmsg, (err, response) => {
          if (processed)
            return;
          processed = true;
          if (err) {
            reject(err);
          } else {
            resolve(response);
          }
        })
      } else {
        this.rateLimiter[from].consume('msg_handler').then((rateLimiterRes) => {
          this.msgHandler(gid, rawmsg, (err, response) => {
            if (processed)
              return;
            processed = true;
            if (err) {
              reject(err);
            } else {
              resolve(response);
            }
          })
        }).catch((rateLimiterRes) => {
          const error = {
            "Retry-After": rateLimiterRes.msBeforeNext / 1000,
            "X-RateLimit-Limit": this.rateLimiter[from].points,
            "X-RateLimit-Reset": new Date(Date.now() + rateLimiterRes.msBeforeNext)
          }
          processed = true;
          reject(error);
        })
      }
    })
  }

  msgHandler(gid, rawmsg, callback) {

    if(rawmsg.err === "decrypt_error") {
      this.simpleTxData(msg, null, { code: 412, msg: "decryption error" }, callback);
      return;
    }

    if (rawmsg.mtype === "msg" && rawmsg.message.type === 'jsondata') {
      if (!callback) { // cloud mode
        if ("compressMode" in rawmsg.message) {
          callback = {
            compressMode: rawmsg.message.compressMode
          } // FIXME: A dirty hack to reuse callback to pass options
        }
      }

      let msg = rawmsg.message.obj;
      (async () => {
        const eid = _.get(rawmsg, 'message.appInfo.eid')
        if (eid) {
          const revoked = await rclient.sismemberAsync(Constants.REDIS_KEY_EID_REVOKE_SET, eid);
          if (revoked) {
            this.simpleTxData(msg, null, { code: 401, msg: "Unauthorized eid" }, callback);
            return;
          }
        }
        if (_.get(rawmsg, 'message.obj.data.item') !== 'ping') {
          rawmsg.message && !rawmsg.message.suppressLog && log.info("Received jsondata from app", rawmsg.message);
        }

        msg.appInfo = rawmsg.message.appInfo;
        if (rawmsg.message.obj.type === "jsonmsg") {
          if (rawmsg.message.obj.mtype === "init") {

            if (rawmsg.message.appInfo) {
              this.processAppInfo(rawmsg.message.appInfo)
            }

            log.info("Process Init load event");

            let begin = Date.now();

            let options = {
              forceReload: true,
              appInfo: rawmsg.message.appInfo
            }

            if (rawmsg.message.obj.data &&
              rawmsg.message.obj.data.simulator) {
              // options.simulator = 1
            }
            await sysManager.updateAsync()
            try {
              const json = await this.hostManager.toJson(options)

              if (this.eptcloud) {
                json.rkey = this.eptcloud.getMaskedRKey(gid);
                json.cloudConnected = !this.eptcloud.disconnectCloud
              }

              // skip acl for old app for backward compatibility
              if (rawmsg.message.appInfo && rawmsg.message.appInfo.version && ["1.35", "1.36"].includes(rawmsg.message.appInfo.version)) {
                if (json && json.policy) {
                  delete json.policy.acl;
                }

                if (json && json.hosts) {
                  for (const host of json.hosts) {
                    if (host && host.policy) {
                      delete host.policy.acl;
                    }
                  }
                }
              }

              let datamodel = {
                type: 'jsonmsg',
                mtype: 'init',
                id: uuid.v4(),
                expires: Math.floor(Date.now() / 1000) + 60 * 5,
                replyid: msg.id,
              }
              if (json != null) {

                json.device = this.getDeviceName();

                datamodel.code = 200;
                datamodel.data = json;

                let end = Date.now();
                log.info("Took " + (end - begin) + "ms to load init data");

                this.cacheInitData(json);
                this.simpleTxData(msg, json, null, callback);
              } else {
                log.error("json is null when calling init")
                const errModel = { code: 500, msg: "json is null when calling init" }
                this.simpleTxData(msg, null, errModel, callback)
              }
            } catch (err) {
              log.error("Error calling hostManager.toJson():", err);
              const errModel = { code: 500, msg: "got error when calling hostManager.toJson: " + err }
              this.simpleTxData(msg, null, errModel, callback)
            }

          } else if (rawmsg.message.obj.mtype === "set") {
            // mtype: set
            // target = "ip address" 0.0.0.0 is self
            // data.item = policy
            // data.value = {'block':1},
            //
            this.setHandler(gid, msg, callback);
          } else if (rawmsg.message.obj.mtype === "get") {
            let appInfo = appTool.getAppInfo(rawmsg.message);
            this.getHandler(gid, msg, appInfo, callback);
          } else if (rawmsg.message.obj.mtype === "cmd") {
            if (msg.data.item == 'batchAction') {
              this.batchHandler(gid, rawmsg, callback);
            } else {
              this.cmdHandler(gid, msg, callback);
            }
          }
        }
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback);
      })
    } else {
      this.bot.processMessage({
        text: rawmsg.message.msg,
        from: {
          address: rawmsg.message.from,
          channelId: gid
        }
      }, (err, msg) => {
        if (msg && msg.text) {
          this.tx(gid, msg.text, "message");
        } else {
        }
      });
    }

  }

  /*
  value:[
    strict single api message obj  {
      "mtype": "cmd",
      "data": {
        "value": {
          "featureName": "adblock"
        },
        "item": "enableFeature"
      },
      "type": "jsonmsg",
      "target": "0.0.0.0"
    }
  ]

  */
  batchHandler(gid, rawmsg, callback) {
    (async () => {
      const batchActionObjArr = rawmsg.message.obj.data.value;
      const copyRawmsg = JSON.parse(JSON.stringify(rawmsg));
      const results = [];
      for (const obj of batchActionObjArr) {
        obj.type = "jsonmsg"
        obj.data.ignoreRate = true;
        copyRawmsg.message.obj = obj;
        let result, error;
        try {
          result = await this.msgHandlerAsync(gid, copyRawmsg);
        } catch (err) {
          error = err;
          log.info(`batch handler error`, obj, err);
        }
        results.push({
          msg: obj,
          result: result,
          error: error
        })
      }
      this.simpleTxData(rawmsg.message.obj, results, null, callback);
    })().catch((err) => {
      this.simpleTxData(rawmsg.message.obj, {}, err, callback);
    });
  }

  helpString() {
    return "Bot version " + sysManager.version() + "\n\nCli interface is no longer useful, please type 'system reset' after update to new encipher app on iOS\n";
  }

  setupDialog() {
    this.dialog.matches('^system reset', (session) => {
      this.tx(this.primarygid, "performing reset of everything", "system resetting");
      let task = exec('/home/pi/firewalla/scripts/system-reset-all', (err, out, code) => {
        this.tx(this.primarygid, "Done, will reboot now and the system will reincarnated, this group is no longer useful, you can delete it.", "system resetting");
        exec('sync & /home/pi/firewalla/scripts/fire-reboot-normal', (err, out, code) => {
        });
      });

    });
  }

  scheduleRestartFirerouterUPnP(intfName) {
    if (restartUPnPTask[intfName])
      clearTimeout(restartUPnPTask[intfName]);
    restartUPnPTask[intfName] = setTimeout(() => {
      execAsync(`sudo systemctl restart firerouter_upnpd@${intfName}`).catch((err) => { });
    }, 3000);
  }

  async _removeSingleUPnP(protocol, externalPort, internalIP, internalPort) {
    const intf = sysManager.getInterfaceViaIP(internalIP);
    if (!intf)
      return;
    const intfName = intf.name;
    const chain = `UPNP_${intfName}`;
    const leaseFile = `/var/run/upnp.${intfName}.leases`;
    const lockFile = `/tmp/upnp.${intfName}.lock`;
    const entries = JSON.parse(await rclient.hgetAsync("sys:scan:nat", "upnp") || "[]");
    const newEntries = entries.filter(e => e.public.port != externalPort && e.private.host != internalIP && e.private.port != internalPort && e.protocol != protocol);
    // remove iptables redirect rule
    await execAsync(wrapIptables(`sudo iptables -w -t nat -D ${chain} -p ${protocol} --dport ${externalPort} -j DNAT --to-destination ${internalIP}:${internalPort}`));
    // clean up upnp cache in redis
    await rclient.hsetAsync("sys:scan:nat", "upnp", JSON.stringify(newEntries));
    // remove entry from lease file
    await execAsync(`flock ${lockFile} -c "sudo sed -i '/^${protocol.toUpperCase()}:${externalPort}:${internalIP}:${internalPort}:.*/d' ${leaseFile}"`).catch((err) => {
      log.error(`Failed to remove upnp lease, external port ${externalPort}, internal ${internalIP}:${internalPort}, protocol ${protocol}`, err.message);
    });
    this.scheduleRestartFirerouterUPnP(intfName);
  }

  async _removeUPnPByNetwork(intfName) {
    const chain = `UPNP_${intfName}`;
    const leaseFile = `/var/run/upnp.${intfName}.leases`;
    const lockFile = `/tmp/upnp.${intfName}.lock`;
    const entries = JSON.parse(await rclient.hgetAsync("sys:scan:nat", "upnp") || "[]");
    const newEntries = entries.filter(e => {
      const intf = sysManager.getInterfaceViaIP(e.private.host);
      return intf && intf.name !== intfName;
    });
    // flush iptables UPnP chain
    await execAsync(`sudo iptables -w -t nat -F ${chain}`).catch((err) => { });
    // clean up upnp cache in redis
    await rclient.hsetAsync("sys:scan:nat", "upnp", JSON.stringify(newEntries));
    // remove lease file
    await execAsync(`flock ${lockFile} -c "sudo rm -f ${leaseFile}"`).catch((err) => { });
    this.scheduleRestartFirerouterUPnP(intfName);
  }

  async _removeAllUPnP() {
    const networks = sysManager.getMonitoringInterfaces();
    for (const network of networks) {
      await this._removeUPnPByNetwork(network.name);
    }
  }

  _scheduleRedisBackgroundSave() {
    if (this.bgsaveTask)
      clearTimeout(this.bgsaveTask);

    this.bgsaveTask = setTimeout(async () => {
      try {
        await platform.ledSaving().catch(() => undefined);
        const ts = Math.floor(new Date() / 1000);
        await rclient.bgsaveAsync();
        const maxCount = 15;
        let count = 0;
        while (count < maxCount) {
          count++;
          await delay(1000);
          const syncTS = await rclient.lastsaveAsync();
          if (syncTS >= ts) {
            break;
          }
        }
        await execAsync("sync");
        await platform.ledDoneSaving().catch(() => undefined);
      } catch (err) {
        log.error("Redis background save returns error", err.message);
      }
    }, 5000);
  }
}

process.on('unhandledRejection', (reason, p) => {
  let msg = "Possibly Unhandled Rejection at: Promise " + p + " reason: " + reason;
  log.error(msg, reason.stack);
  if (msg.includes("Redis connection"))
    return;
  bone.logAsync("error", {
    type: 'FIREWALLA.UI.unhandledRejection',
    msg: msg,
    stack: reason.stack,
    err: reason
  });
});

process.on('uncaughtException', (err) => {
  log.info("+-+-+-", err.message, err.stack);
  bone.logAsync("error", {
    type: 'FIREWALLA.UI.exception',
    msg: err.message,
    stack: err.stack,
    err: err
  });
  setTimeout(() => {
    try {
      execSync("touch /home/pi/.firewalla/managed_reboot")
    } catch (e) {
    }
    process.exit(1);
  }, 1000 * 20); // just ensure fire api lives long enough to upgrade itself if available
});

setInterval(() => {
  let memoryUsage = Math.floor(process.memoryUsage().rss / 1000000);
  try {
    if (global.gc) {
      global.gc();
      log.info("GC executed ", memoryUsage, " RSS is now:", Math.floor(process.memoryUsage().rss / 1000000), "MB");
    }
  } catch (e) {
  }
}, 1000 * 60 * 5);

module.exports = netBot;
