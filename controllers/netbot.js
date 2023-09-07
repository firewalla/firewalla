#!/usr/bin/env node
/*    Copyright 2016-2023 Firewalla Inc.
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
const log = require('../net2/logger.js')(__filename);

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
const flowManager = new FlowManager();
const VpnManager = require("../vpn/VpnManager.js");
const IntelManager = require('../net2/IntelManager.js');
const intelManager = new IntelManager();
const upgradeManager = require('../net2/UpgradeManager.js');
const modeManager = require('../net2/ModeManager.js');
const mode = require('../net2/Mode.js')

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

const DeviceMgmtTool = require('../util/DeviceMgmtTool');

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
const ssh = new SSH();

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
const FRPSUCCESSCODE = 0;
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();
const RateLimiterRedis = require('../vendor_lib/rate-limiter-flexible/RateLimiterRedis.js');
const RateLimiterRes = require('../vendor_lib/rate-limiter-flexible/RateLimiterRes');
const cpuProfile = require('../net2/CpuProfile.js');
const ea = require('../event/EventApi.js');
const wrapIptables = require('../net2/Iptables.js').wrapIptables;

const Message = require('../net2/Message')

const util = require('util')

const restartUPnPTask = {};

class netBot extends ControllerBot {

  /*
   *   {
   *      state: BOOL;  overall notification
   *      ALARM_XXX: standard alarm definition
   *      ALARM_BEHAVIOR: may be mapped to other alarms
   *   }
   */
  async _notify(ip, value) {
    await this.hostManager.setPolicyAsync("notify", value)
    log.info("Notification Set", value, " CurrentPolicy:", JSON.stringify(this.hostManager.policy.notify));
    nm.loadConfig();
  }

  async _sendLog() {
    let password = require('../extension/common/key.js').randomPassword(10)
    let filename = this.primarygid + ".tar.gz.gpg";
    const url = util.promisify(this.eptcloud.getStorage).bind(this.eptcloud)(this.primarygid, 18000000, 0)
    if (url == null || url.url == null) {
      throw "Unable to get storage"
    } else {
      const path = URL.parse(url.url).pathname;
      const homePath = f.getFirewallaHome();
      let cmdline = `${homePath}/scripts/encrypt-upload-s3.sh ${filename} ${password} '${url.url}'`;
      await execAsync(cmdline).catch(err => {
        log.error("sendLog: unable to process encrypt-upload", err.message, err.stdout, err.stderr);	
      })
      return { password: password, filename: path }
    }
  }

  async _portforward(target, msg) {
    log.info("_portforward", msg);
    this.messageBus.publish("FeaturePolicy", "Extension:PortForwarding", null, msg);
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

  async setHandler(gid, msg /*rawmsg.message.obj*/, cloudOptions) {
    // mtype: set
    // target = "ip address" 0.0.0.0 is self
    // data.item = policy
    // data.value = {'block':1},
    //
    //       log.info("Set: ",gid,msg);

    // invalidate cache
    this.invalidateCache();
    if (extMgr.hasSet(msg.data.item)) {
      const result = await extMgr.set(msg.data.item, msg, msg.data.value)
      return result
    }

    let value = msg.data.value;
    switch (msg.data.item) {
      case "policy": {
        // further policy enforcer should be implemented in Host.js or PolicyManager.js
        const processorMap = {
          "notify": this._notify,
          "portforward": this._portforward,
        }
        const target = msg.target

        let monitorable
        if (target === "0.0.0.0") {
          monitorable = this.hostManager
        } else if (target.startsWith("network:")) {
          const uuid = target.substring(8);
          monitorable = this.networkProfileManager.getNetworkProfile(uuid);
        } else if (target.startsWith("tag:")) {
          const tagUid = target.substring(4);
          monitorable = this.tagManager.getTagByUid(tagUid);
        } else if (this.identityManager.isGUID(target)) {
          monitorable = this.identityManager.getIdentityByGUID(target);
        } else if (hostTool.isMacAddress(target)) {
          monitorable = await this.hostManager.getHostAsync(target)
        }
        if (!monitorable) throw new Error(`Unknow target ${target}`)

        await monitorable.loadPolicyAsync();
        for (const o of Object.keys(value)) {
          if (processorMap[o]) {
            await processorMap[o].bind(this)(target, value[o])
            continue
          }

          let policyData = value[o]

          log.verbose(o, target, policyData)

          // following policies only supported at system level
          if (o in ['vpn', 'shadowsocks', 'enhancedSpoof', 'vulScan', 'externalAccess', 'ssh', 'notify', 'upstreamDns']) {
            if (target != '0.0.0.0') continue
          }

          if (o === "tags" && _.isArray(policyData)) {
            policyData = policyData.map(String);
          }

          await monitorable.setPolicyAsync(o, policyData);
        }
        this._scheduleRedisBackgroundSave();
        // can't get result of port forward, return original value for compatibility reasons
        const result = value.portforward ? value : monitorable.policy
        return result
      }
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
          throw new Error("host name required for setting name")
        }

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
          return { localDomain }

        } else {
          ip = msg.target
        }

        let host = await this.hostManager.getHostAsync(ip)

        if (!host) {
          throw new Error("invalid host")
        }

        if (data.value.name == host.o.name) {
          return
        }

        host.o.name = data.value.name
        log.info("Changing names", host.o.name);
        await host.save()
        return
      }
      case "tag": {
        let data = msg.data;
        log.info("Setting tag", msg);

        if (!data.value.name) {
          throw new Error("tag name required for setting name")
        }

        const name = value.name;
        const tag = this.tagManager.getTagByUid(msg.target);

        if (!tag) {
          throw new Error("invalid tag")
        }

        if (name == tag.getTagName()) {
          return
        }

        const result = await this.tagManager.changeTagName(msg.target, name);
        log.info("Changing tag name", name);
        if (!result) {
          throw new Error("Can't use already exsit tag name")
        } else {
          return data.value
        }
      }
      case "hostDomain": {
        let data = msg.data;
        if (hostTool.isMacAddress(msg.target) || msg.target == '0.0.0.0') {
          const macAddress = msg.target
          let { customizeDomainName, suffix, noForward } = data.value;
          if (customizeDomainName && hostTool.isMacAddress(macAddress)) {
            let macObject = {
              mac: macAddress,
              customizeDomainName: customizeDomainName
            }
            await hostTool.updateMACKey(macObject);
          }
          if (suffix && macAddress == '0.0.0.0') {
            await rclient.setAsync(Constants.REDIS_KEY_LOCAL_DOMAIN_SUFFIX, suffix);
          }
          if (_.isBoolean(noForward) && macAddress == '0.0.0.0') {
            await rclient.setAsync(Constants.REDIS_KEY_LOCAL_DOMAIN_NO_FORWARD, noForward);
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
          return { userLocalDomain }
        } else {
          throw new Error("Invalid mac address")
        }
      }
      case "timezone":
        if (!value.timezone)
          throw new Error("Invalid timezone")
        await sysManager.setTimezone(value.timezone);
        return
      case "includeNameInNotification": {
        let flag = "0";

        if (value.includeNameInNotification) {
          flag = "1"
        }

        await rclient.hsetAsync("sys:config", "includeNameInNotification", flag)
        return
      }
      case "forceNotificationLocalization": {
        let flag = "0";

        if (value.forceNotificationLocalization) {
          flag = "1"
        }

        await rclient.hsetAsync("sys:config", "forceNotificationLocalization", flag)
        return
      }
      case "mode": {
        let v4 = value;
        let err = null;
        if (v4.mode) {
          let curMode = await mode.getSetupMode()
          if (v4.mode === curMode) {
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
          sysManager.update();

          this._scheduleRedisBackgroundSave();

          return
        }
        break;
      }
      case "userConfig": {
        const partialConfig = value || {};
        await fc.updateUserConfig(partialConfig);
        return
      }
      case "dataPlan": {
        const { total, date, enable, wanConfs } = value;
        const featureName = 'data_plan';
        if (enable) {
          await fc.enableDynamicFeature(featureName)
          await rclient.setAsync("sys:data:plan", JSON.stringify({ total, date, wanConfs }));
          sem.emitEvent({
            type: "DataPlan:Updated",
            date: date,
            toProcess: "FireMain"
          });
        } else {
          await fc.disableDynamicFeature(featureName);
          await rclient.unlinkAsync("sys:data:plan");
        }
        return
      }
      case "networkConfig": {
        await FireRouter.setConfig(value.config);
        // successfully set config, save config to history
        const latestConfig = await FireRouter.getConfig();
        await FireRouter.saveConfigHistory(latestConfig);
        this._scheduleRedisBackgroundSave();
        return
      }
      case "eptGroupName": {
        const { name } = value;
        const result = await this.eptcloud.rename(this.primarygid, name);
        if (result) {
          this.updatePrimaryDeviceName(name);
          return
        } else {
          throw new Error("rename failed")
        }
      }
      case "intelAdvice": {
        const { target, ip, intel } = value
        intel.localIntel = await intelTool.getIntel(ip)
        await bone.intelAdvice({
          target: target,
          key: ip,
          value: intel,
        });
        return
      }
      case "feedback": {
        if (value.key == 'device.detect') {
          const host = await this.hostManager.getHostAsync(value.target)
          if (!host.o.detect) host.o.detect = {}
          host.o.detect.feedback = Object.assign({}, host.o.detect.feedback, value.value)
          await host.save('detect')
        } else
          await bone.intelAdvice(value);
        return
      }
      case "cpuProfile": {
        const { applyProfileName, profiles } = value;
        if (profiles && profiles.length > 0) {
          await cpuProfile.addProfiles(profiles);
        }
        if (applyProfileName) {
          await cpuProfile.applyProfile(applyProfileName);
        }
        return
      }
      case "autoUpgrade":
        return upgradeManager.setAutoUpgradeState(value)
      default:
        throw new Error("Unsupported set action")
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
            const date = Math.floor(Date.now() / 1000)
            result["msg"] = `${historyMsg}paired at ${date},`;
            await rclient.hsetAsync("sys:ept:members:history", appInfo.eid, JSON.stringify(result));
          }
        }
      } catch (err) {
        log.info("error when record paired device history info", err)
      }
      await rclient.hsetAsync(keyName, appInfo.eid, appInfo.deviceName)

      const keyName2 = "sys:ept:member:lastvisit"
      await rclient.hsetAsync(keyName2, appInfo.eid, Math.floor(Date.now() / 1000))
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

  async getHandler(gid, msg, appInfo, cloudOptions) {

    // backward compatible
    if (typeof appInfo === 'function') {
      cloudOptions = appInfo;
      appInfo = undefined;
    }

    if (appInfo) {
      this.processAppInfo(appInfo)
    }

    if (!msg.data) {
      throw new Error("Malformed request");
    }

    // mtype: get
    // target = ip address
    // data.item = [app, alarms, host]
    if (extMgr.hasGet(msg.data.item)) {
      const result = await extMgr.get(msg.data.item, msg, msg.data.value)
      return result
    }

    const value = msg.data.value;
    const apiVer = msg.data.apiVer;

    switch (msg.data.item) {
      case "host":
      case "tag":
      case "intf":
        if (!msg.target) {
          throw new Error('Invalid target')
        }
        log.info(`Loading ${msg.data.item} info: ${msg.target}`);
        msg.data.begin = msg.data.begin || msg.data.start;
        delete msg.data.start
        return this.flowHandler(msg, msg.data.item)
      case "flows": {
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
        return {
          count: flows.length,
          flows,
          nextTs: flows.length ? flows[flows.length - 1].ts : null
        }
      }
      case "auditLogs": { // arguments are the same as get flows
        const options = await this.checkLogQueryArgs(msg)

        const logs = await auditTool.getAuditLogs(options)
        return {
          count: logs.length,
          logs,
          nextTs: logs.length ? logs[logs.length - 1].ts : null
        }
      }
      case "topFlows": {
        //  count: tox x flows
        //  target: mac address || intf:uuid || tag:tagId
        const value = msg.data.value;
        const count = value && value.count || 50;
        await this.hostManager.loadStats({}, msg.target, count);
        return { flows: flows };
      }

      case "appTimeUsage": {
        const options = await this.checkLogQueryArgs(msg);
        const result = {};
        if (!options.mac)
          options.macs = await flowTool.expendMacs(options);
        await netBotTool.prepareAppTimeUsage(result, options);
        return result;
      }
      case "mypubkey": {
        return { key: this.eptcloud && this.eptcloud.mypubkey() }
      }
      case "vpn":
      case "vpnreset": {
        let regenerate = false
        if (msg.data.item === "vpnreset") {
          regenerate = true;
        }
        const data = await this.hostManager.loadPolicyAsync()
        const vpnConfig = data.vpn || {};
        let externalPort = "1194";
        if (vpnConfig && vpnConfig.externalPort)
          externalPort = vpnConfig.externalPort;
        const protocol = vpnConfig && vpnConfig.protocol;
        const ddnsConfig = data.ddns || {};
        const ddnsEnabled = ddnsConfig.hasOwnProperty("state") ? ddnsConfig.state : true;
        await VpnManager.configureClient("fishboneVPN1", null)

        const { ovpnfile, password, timestamp } = await VpnManager.getOvpnFile("fishboneVPN1", null, regenerate, externalPort, protocol, ddnsEnabled)
        const datamodel = {
          ovpnfile: ovpnfile,
          password: password,
          portmapped: data.vpnPortmapped || false,
          timestamp: timestamp
        };
        const doublenat = await rclient.getAsync("ext.doublenat")
        if (doublenat !== null) {
          datamodel.doublenat = doublenat;
        }
        msg.data.item = "device"
        return datamodel
      }
      case "shadowsocks":
      case "shadowsocksResetConfig": {
        let shadowsocks = require('../extension/shadowsocks/shadowsocks.js');
        let ss = new shadowsocks('info');

        if (msg.data.item === "shadowsocksResetConfig") {
          ss.refreshConfig();
        }

        let config = ss.readConfig();
        return { config: config }
      }
      case "generateRSAPublicKey": {
        const identity = value.identity;
        const regenerate = value.regenerate;
        const prevKey = await ssh.getRSAPublicKey(identity);
        if (prevKey === null || regenerate) {
          await ssh.generateRSAKeyPair(identity);
          const pubKey = await ssh.getRSAPublicKey(identity);
          return { publicKey: pubKey }
        } else
          return { publicKey: prevKey }
      }
      case "sshPrivateKey": {
        const data = await ssh.getPrivateKey()
        return { key: data }
      }
      case "sshRecentPassword":
        return ssh.loadPassword()
      case "sysInfo":
        return SysInfo.getSysInfo()
      case "logFiles":
        return SysInfo.getRecentLogs()
      case "language":
        return { language: sysManager.language }
      case "timezone":
        return { timezone: sysManager.timezone }
      case "alarms": {
        const alarms = await am2.loadActiveAlarmsAsync(value)
        return { alarms: alarms, count: alarms.length }
      }
      case "alarmIDs":
        return am2.loadAlarmIDs();
      case "loadAlarmsWithRange":
        return am2.loadAlarmsWithRange(value);
      case "fetchNewAlarms": {
        const sinceTS = value.sinceTS;
        const timeout = value.timeout || 60;
        const alarms = await am2.fetchNewAlarms(sinceTS, { timeout });
        return { alarms: alarms, count: alarms.length }
      }
      case "alarm":
        return am2.getAlarm(value.alarmID)
      case "alarmDetail": {
        const alarmID = value.alarmID;
        if (alarmID) {
          const basic = await am2.getAlarm(alarmID);
          const detail = (await am2.getAlarmDetail(alarmID)) || {};
          return Object.assign({}, basic, detail)
        } else {
          throw new Error("Missing alarm ID")
        }
      }
      case "selfCheck": {
        const sc = require("../diagnostic/selfcheck.js");
        return sc.check();
      }
      case "blockCheck": {
        const ipOrDomain = value.ipOrDomain;
        const rc = require("../diagnostic/rulecheck.js");
        return rc.checkIpOrDomain(ipOrDomain);
      }
      case "transferTrend": {
        const deviceMac = value.deviceMac;
        const destIP = value.destIP;
        if (destIP && deviceMac) {
          return flowTool.getTransferTrend(deviceMac, destIP);
        } else {
          throw new Error("Missing device MAC or destination IP")
        }
      }
      case "archivedAlarms": {
        const offset = value && value.offset;
        const limit = value && value.limit;

        const archivedAlarms = await am2.loadArchivedAlarms({
          offset: offset,
          limit: limit
        })
        return {
          alarms: archivedAlarms,
          count: archivedAlarms.length
        }
      }
      case "exceptions": {
        const exceptions = await em.loadExceptionsAsync()
        return { exceptions: exceptions, count: exceptions.length }
      }
      case "frpConfig": {
        let _config = frp.getConfig()
        if (_config.started) {
          const obj = await ssh.loadPassword()
          _config.password = obj && obj.password;
        }
        return _config
      }
      case "upstreamDns": {

        const response = await policyManager.getUpstreamDns();
        log.info("upstream dns response", response);
        return response
      }
      case "linkedDomains": {
        const target = value.target;
        const isDomainPattern = value.isDomainPattern || false;
        if (!target) {
          throw { code: 400, msg: "'target' should be specified." }
        } else {
          const domains = await dnsTool.getLinkedDomains(target, isDomainPattern);
          return { domains: domains }
        }
      }
      case "liveCategoryDomains": {
        const category = value.category
        const domains = await categoryUpdater.getDomainsWithExpireTime(category)
        return { domains: domains }
      }
      case "liveCategoryDomainsWithoutExcluded": {
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

        return { domains: outputDomains, includes: includedDomains }
      }
      case "includedDomains": {
        const category = value.category
        const domains = await categoryUpdater.getIncludedDomains(category)
        return { domains }
      }
      case "excludedDomains": {
        const category = value.category
        const domains = await categoryUpdater.getExcludedDomains(category)
        return { domains }
      }
      case "includedElements": {
        const category = value.category;
        const elements = await categoryUpdater.getIncludedElements(category);
        return { elements }
      }
      case "customizedCategories": {
        const categories = await categoryUpdater.getCustomizedCategories();
        return { categories }
      }
      case "whois": {

        const target = value.target;
        let whois = await intelManager.whois(target);
        return { target, whois }
      }
      case "ipinfo": {
        const ip = value.ip;
        const ipinfo = await intelManager.ipinfo(ip);
        return { ip, ipinfo }
      }
      case "proToken":
        return { token: tokenManager.getToken(gid) }
      case "policies": {
        const list = await pm2.loadActivePoliciesAsync()
        let alarmIDs = list.map((p) => p.aid);
        const alarms = await am2.idsToAlarmsAsync(alarmIDs)

        for (let i = 0; i < list.length; i++) {
          if (list[i] && alarms[i]) {
            list[i].alarmMessage = alarms[i].localizedInfo();
            list[i].alarmTimestamp = alarms[i].timestamp;
          }
        }
        return { policies: list }
      }
      case "hosts": {
        let hosts = {};
        await this.hostManager.getHostsAsync()
        await this.hostManager.legacyHostsStats(hosts)
        return hosts
      }
      case "vpnProfile":
      case "ovpnProfile": {
        const type = (value && value.type) || "openvpn";
        const profileId = value.profileId;
        if (!profileId) {
          throw { code: 400, msg: "'profileId' should be specified." }
        }
        const c = VPNClient.getClass(type);
        if (!c) {
          throw { code: 400, msg: `Unsupported VPN client type: ${type}` }
        }
        // backward compatibility in case api call payload does not contain type, directly use singleton in VPNClient.js based on profileId if available
        let vpnClient = VPNClient.getInstance(profileId);
        if (!vpnClient) {
          const exists = await c.profileExists(profileId);
          if (!exists) {
            throw { code: 404, msg: "Specified profileId is not found." }
          }
          vpnClient = new c({ profileId });
        }
        return vpnClient.getAttributes(true);
      }
      case "vpnProfiles":
      case "ovpnProfiles": {
        const types = (value && value.types) || ["openvpn"];
        if (!Array.isArray(types)) {
          throw { code: 400, msg: "'types' should be an array." }
        }
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
        return { profiles }
      }
      case "country:supported": {
        const list = await rclient.smembersAsync('country:list')
        return { supported: list }
      }
      case "publicIp":
        return new Promise((resolve, reject) => {
          traceroute.trace(value.checkHost || "8.8.8.8", (err, hops, destination) => {
            if (err) {
              reject(err)
            } else {
              let secondStepIp = hops[1] ? hops[1].ip : "";
              let isPublic = iptool.isPublic(secondStepIp);
              resolve({ hops: hops, secondStepIp: secondStepIp, isPublic: isPublic, destination: destination })
            }
          })
        })
      case "networkStatus": {
        const ping = await rclient.hgetallAsync("network:status:ping");
        const dig = await rclient.getAsync("network:status:dig");
        const speedtestResult = (await speedtest()) || {};
        const { download, upload, server } = speedtestResult;
        return {
          ping: ping,
          dig: JSON.parse(dig),
          gigabit: Number(await platform.getNetworkSpeed()) >= 1000,
          speedtest: {
            download: download,
            upload: upload,
            server: server
          }
        }
      }
      case "monthlyDataUsage": {
        let target = msg.target;
        if (!target || target == '0.0.0.0') {
          target = null;
        } else {
          target = target.toUpperCase();
        }
        const { download, upload, totalDownload, totalUpload,
          monthlyBeginTs, monthlyEndTs } = await this.hostManager.monthlyDataStats(target);
        return {
          download: download,
          upload: upload,
          totalDownload: totalDownload,
          totalUpload: totalUpload,
          monthlyBeginTs: monthlyBeginTs,
          monthlyEndTs: monthlyEndTs
        }
      }
      case "monthlyDataUsageOnWans": {
        let dataPlan = await rclient.getAsync('sys:data:plan');
        if (dataPlan) {
          dataPlan = JSON.parse(dataPlan);
        } else {
          dataPlan = {}
        }
        const globalDate = dataPlan && dataPlan.date || 1;
        const wanConfs = dataPlan && dataPlan.wanConfs || {};
        const wanIntfs = sysManager.getWanInterfaces();
        const result = {};
        for (const wanIntf of wanIntfs) {
          const date = wanConfs[wanIntf.uuid] && wanConfs[wanIntf.uuid].date || globalDate;
          result[wanIntf.uuid] = _.pick(await this.hostManager.monthlyDataStats(`wan:${wanIntf.uuid}`, date), ["download", "upload", "totalDownload", "totalUpload", "monthlyBeginTs", "monthlyEndTs"]);
        }
        return result
      }
      case "dataPlan": {
        const featureName = 'data_plan';
        let dataPlan = await rclient.getAsync('sys:data:plan');
        const enable = fc.isFeatureOn(featureName)
        if (dataPlan) {
          dataPlan = JSON.parse(dataPlan);
        } else {
          dataPlan = {}
        }
        return { dataPlan: dataPlan, enable: enable }
      }
      case "network:filenames": {
        const filenames = await FireRouter.getFilenames();
        return { filenames: filenames }
      }
      case "networkConfig": {
        return FireRouter.getConfig();
      }
      case "networkConfigHistory": {
        const count = value.count || 10;
        const history = await FireRouter.loadRecentConfigFromHistory(count);
        return { history: history }
      }
      case "networkConfigImpact":
        return FireRouter.checkConfig(value.config);
      case "networkState": {
        const live = value.live || false;
        const allInterfaces = await FireRouter.getInterfaceAll(live);
        if (live) {
          // merge live wan connectivity results into interfaces data
          const wanConnectivity = await FireRouter.getWanConnectivity(live);
          if (wanConnectivity && wanConnectivity.wans) {
            for (const wan of Object.keys(wanConnectivity.wans)) {
              if (allInterfaces[wan])
                allInterfaces[wan].state.wanTestResult = wanConnectivity.wans[wan];
            }
          }
        }
        return allInterfaces;
      }
      case "availableWlans":
        return FireRouter.getAvailableWlans()
      case "wlanChannels":
        return FireRouter.getWlanChannels()
      case "wanConnectivity":
        return FireRouter.getWanConnectivity(value.live);
      case "wanInterfaces":
        return FireRouter.getSystemWANInterfaces();
      case "eptGroup": {
        const result = await this.eptcloud.groupFind(this.primarygid);
        if (!result) throw new Error('Group not found!')

        // write members to sys:ept:members
        await this.eptCloudExtension.recordAllRegisteredClients(this.primarygid)
        const resp = { groupName: result.group.name }
        // read from sys:ept:members
        await this.hostManager.encipherMembersForInit(resp)
        return resp
      }
      case "branchUpdateTime": {
        const branches = (value && value.branches) || ['beta_6_0', 'release_6_0', 'release_7_0'];
        const result = {};
        for (const branch of branches) {
          result[branch] = await sysManager.getBranchUpdateTime(branch);
        }
        return result
      }
      case "userConfig":
        return fc.getUserConfig();
      case "dhcpLease": {
        const intf = value.intf;
        if (!intf)
          throw { code: 400, msg: "'intf' should be specified" }
        const af = value.af || 4;

        try {
          const { code, body } = await FireRouter.getDHCPLease(intf, af);
          if (body.errors && !_.isEmpty(body.errors)) {
            throw { code, msg: body.errors[0] }
          } else {
            if (!body.info)
              throw { code: 500, msg: `Failed to get ${af == 4 ? "DHCP" : "DHCPv6"} lease on ${intf}` }
            else
              return body.info
          }
        } catch (err) {
          log.error(`Error occured while getting dhcpLease`, err.message);
          throw { code: 500, msg: `Failed to get ${af == 4 ? "DHCP" : "DHCPv6"} lease on ${intf}` }
        }
      }
      case "upgradeInfo": {
        const result = {
          firewalla: await upgradeManager.getHashAndVersion(),
        }
        const autoUpgrade = await upgradeManager.getAutoUpgradeState()
        result.firewalla.autoUpgrade = autoUpgrade.firewalla

        if (platform.isFireRouterManaged()) {
          result.firerouter = await upgradeManager.getRouterHash()
          result.firerouter.autoUpgrade = autoUpgrade.firerouter
        }
        return result
      }
      default:
        throw new Error("unsupported action");
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
        jsonobj = tag.toJson();

        options.macs = await this.hostManager.getTagMacs(target);
        target = `${type}:${target}`
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
        throw new Error('Invalid target type: ' + type)
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
      netBotTool.prepareAppTimeUsage(jsonobj, options),

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
  async cmdHandler(gid, msg) {

    // no need log 
    // it will output via: Received jsondata from app

    if (extMgr.hasCmd(msg.data.item)) {
      return extMgr.cmd(msg.data.item, msg, msg.data.value);
    }

    if (msg.data.item === "dhcpCheck") {
      const dhcp = require("../extension/dhcp/dhcp.js");
      await mode.reloadSetupMode();
      const routerIP = sysManager.myDefaultGateway();
      let DHCPDiscover = false;
      if (routerIP) {
        DHCPDiscover = await dhcp.dhcpServerStatus(routerIP);
      }
      return {
        DHCPMode: await mode.isDHCPModeOn(),
        DHCPDiscover: DHCPDiscover
      }
    }
    if (msg.data.item === "reset") {
      log.info("System Reset");
      platform.ledStartResetting();
      log.info("Resetting device...");
      const result = await DeviceMgmtTool.resetDevice(msg.data.value);
      if (result) {
        log.info("Sending reset response back to app before group is deleted...");

        // start async routine so response got send to app immediately
        (async () => {
          log.info("Deleting Group...");
          // only delete group if reset device is really successful
          await DeviceMgmtTool.deleteGroup(this.eptcloud, this.primarygid);
          log.info("Group deleted");
        })().catch(err => {
          log.error("Got error when deleting group, err:", err.message);
        })

        return
      } else {
        throw new Error("reset failed")
      }
    } else if (msg.data.item === "sendlog") {
      log.info("sendLog");
      return this._sendLog();
    } else if (msg.data.item === "resetSSHKey") {
      await util.promisify(ssh.resetRSAPassword)()
      return;
    }

    let value = msg.data.value;
    switch (msg.data.item) {
      case "upgrade":
        // value.force ignores no_auto_upgrade flag
        upgradeManager.checkAndUpgrade(value.force)
        return
      case "shutdown":
        sysTool.shutdownServices()
        return
      case "shutdown:cancel":
        await sysTool.cancelShutdown()
        return
      case "reboot":
        sysTool.rebootSystem()
        return
      case "resetpolicy":
        sysTool.resetPolicy()
        return
      case "stopService":
        await sysTool.stopServices();
        return
      case "startService":
        // no need to await, otherwise fireapi will also be restarted
        sysTool.restartServices();
        sysTool.restartFireKickService();
        return
      case "restartFirereset":
        await execAsync("sudo systemctl restart firereset");
        return
      case "restartFirestatus":
        await execAsync("sudo systemctl restart firestatus");
        return
      case "restartBluetoothRTKService":
        await execAsync("sudo systemctl restart rtk_hciuart");
        return
      case "cleanIntel":
        await sysTool.cleanIntel();
        return
      case "rekey":
        await this.eptcloud.reKeyForAll(gid);
        return
      case "syncLegacyKeyToNewKey":
        await this.eptcloud.syncLegacyKeyToNewKey(gid);
        return
      case "checkIn":
        return new Promise((resolve, reject) => {
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
              let { ddns, publicIp, publicIp6s } = await rclient.hgetallAsync('sys:network:info')
              try {
                ddns = JSON.parse(ddns);
                publicIp = JSON.parse(publicIp);
                publicIp6s = JSON.parse(publicIp6s);
              } catch (err) {
                log.error("Failed to parse strings:", ddns, publicIp, publicIp6s);
              }
              resolve({ ddns, publicIp, publicIp6s })
            });
          });
        })
      case "ddnsUpdate": {
        let ddns = value.ddns;
        const ddnsToken = value.ddnsToken;
        const fromEid = value.fromEid;
        if (!ddns || !ddnsToken || !fromEid)
          throw { code: 400, msg: "'ddns', 'ddnsToken', and 'fromEid' should be specified"}
        else {
          // save the ddns, token and eid into redis and trigger a check-in
          await rclient.hmsetAsync(Constants.REDIS_KEY_DDNS_UPDATE, {ddns, ddnsToken, fromEid});
          sem.sendEventToFireMain({
            type: 'CloudReCheckin',
            message: "",
          });
          return new Promise((resolve, reject) => {
            sem.once("CloudReCheckinComplete", async (event) => {
              let { ddns, ddnsToken, publicIp } = await rclient.hgetallAsync('sys:network:info')
              try {
                ddns = JSON.parse(ddns);
                publicIp = JSON.parse(publicIp);
              } catch (err) {
                log.error("Failed to parse strings:", ddns, publicIp);
              }
              resolve({ ddns, ddnsToken, publicIp });
            });
          })
        }
      }
      case "debugOn":
        await sysManager.debugOn()
        return
      case "debugOff":
        await sysManager.debugOff()
        return
      case "resetSSHPassword":
        return ssh.resetRandomPassword()
      case "ping": {
        let uptime = process.uptime();
        let now = new Date();
        return {
          uptime: uptime,
          timestamp: now
        }
      }
      case "tag:create": {
        if (!value || !value.name)
          throw { code: 400, msg: "'name' is not specified." }
        else {
          const name = value.name;
          const obj = value.obj;
          const tag = await this.tagManager.createTag(name, obj);
          return tag
        }
      }
      case "tag:remove": {
        if (!value || !value.name)
          throw { code: 400, msg: "'name' is not specified" }
        else {
          const name = value.name;
          await this.tagManager.removeTag(name);
          return
        }
      }
      case "alarm:block": {
        const result = await am2.blockFromAlarmAsync(value.alarmID, value)
        const { policy, otherBlockedAlarms, alreadyExists } = result

        // only return other matched alarms matchAll is set, originally for backward compatibility
        // matchAll is not used for blocking check
        if (value.matchAll) {
          return {
            policy: policy,
            otherAlarms: otherBlockedAlarms,
            alreadyExists: alreadyExists === "duplicated",
            updated: alreadyExists === "duplicated_and_updated"
          }
        } else
          return policy
      }
      case "alarm:allow": {
        const { exception, allowedAlarms, alreadyExists } = await am2.allowFromAlarm(value.alarmID, value)
        if (value && value.matchAll) { // only return other matched alarms if this option is on, for better backward compatibility
          return {
            exception: exception,
            otherAlarms: allowedAlarms,
            alreadyExists: alreadyExists
          }
        } else
          return exception
      }
      case "alarm:unblock":
        await am2.unblockFromAlarmAsync(value.alarmID, value)
        return
      case "alarm:unallow":
        await am2.unallowFromAlarmAsync(value.alarmID, value)
        return
      case "alarm:unblock_and_allow":
        await am2.unblockFromAlarmAsync(value.alarmID, value)
        await am2.allowFromAlarm(value.alarmID, value)
        return
      case "alarm:ignore": {
        const ignoreIds = await am2.ignoreAlarm(value.alarmID, value || {})
        return { ignoreIds: ignoreIds }
      }
      case "alarm:ignoreAll":
        await am2.ignoreAllAlarmAsync();
        return
      case "alarm:report":
        await am2.reportBug(value.alarmID, value.feedback)
        return
      case "alarm:delete": {
        const alarmIDs = value.alarmIDs;
        if (alarmIDs && _.isArray(alarmIDs)) {
          for (const alarmID of alarmIDs) {
            alarmID && await am2.removeAlarmAsync(alarmID);
          }
        } else {
          await am2.removeAlarmAsync(value.alarmID);
        }
        return
      }
      case "alarm:deleteActiveAll":
        await am2.deleteActiveAllAsync();
        return
      case "alarm:deleteArchivedAll":
        await am2.deleteArchivedAllAsync();
        return
      case "alarm:archiveByException": {
        const exceptionID = value.exceptionID;
        const result = await am2.archiveAlarmByExceptionAsync(exceptionID);
        return result
      }
      case "policy:create": {
        const policyRaw = new Policy(value)

        const { policy, alreadyExists } = await pm2.checkAndSaveAsync(policyRaw)
        if (alreadyExists == "duplicated") {
          throw { code: 409, msg: "Policy already exists" }
        } else if (alreadyExists == "duplicated_and_updated") {
          const p = JSON.parse(JSON.stringify(policy))
          p.updated = true // a kind hacky, but works
          sem.emitEvent({
            type: "Policy:Updated",
            pid: policy.pid,
            toProcess: "FireMain"
          });
          return p
        } else {
          this._scheduleRedisBackgroundSave();
          return policy
        }
      }
      case "policy:update": {
        const policy = value

        const pid = policy.pid
        const oldPolicy = await pm2.getPolicy(pid)
        const policyObj = new Policy(Object.assign({}, oldPolicy, policy));
        const samePolicies = await pm2.getSamePolicies(policyObj);
        if (_.isArray(samePolicies) && samePolicies.filter(p => p.pid != pid).length > 0) {
          throw { code: 409, msg: "policy already exists" }
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
          return newPolicy
        }
      }
      case "policy:delete": {
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
          return results
        } else {
          let policy = await pm2.getPolicy(value.policyID)
          if (policy) {
            await pm2.disableAndDeletePolicy(value.policyID)
            policy.deleted = true // policy is marked ask deleted
            this._scheduleRedisBackgroundSave();
            return policy
          } else {
            throw new Error("invalid policy");
          }
        }
      }
      case "policy:batch": {
        /*
            actions: {create: [policy instance], delete: [policy instance], update:[policyID]}
            */
        const actions = value.actions;
        if (actions) {
          const result = await pm2.batchPolicy(actions)
          this._scheduleRedisBackgroundSave();
          return result
        } else {
          throw new Error("invalid actions");
        }
      }
      case "policy:enable": {
        const policyID = value.policyID
        if (policyID) {
          let policy = await pm2.getPolicy(value.policyID)
          if (policy) {
            await pm2.enablePolicy(policy)
            return policy
          } else {
            throw new Error("invalid policy");
          }
        } else {
          throw new Error("invalid policy ID");
        }
      }
      case "policy:disable": {
        const policyID = value.policyID
        if (policyID) {
          let policy = await pm2.getPolicy(value.policyID)
          if (policy) {
            await pm2.disablePolicy(policy)
            return policy
          } else {
            throw new Error("invalid policy");
          }
        } else {
          throw new Error("invalid policy ID")
        }
      }
      case "policy:resetStats": {
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
          return results
        } else {
          throw new Error("Invalid request")
        }
      }
      case "policy:search": {
        const resultCheck = await pm2.checkSearchTarget(value.target);
        if (resultCheck.err != null) {
          return resultCheck.err
        }

        let data = await pm2.searchPolicy(resultCheck.waitSearch, resultCheck.isDomain, value.target);
        data.exceptions = await em.searchException(value.target);
        if (resultCheck.isDomain) {
          data.dnsmasqs = await dnsmasq.searchDnsmasq(value.target);
        }
        return data
      }
      case "policy:setDisableAll":
        await pm2.setDisableAll(value.flag, value.expireMinute);
        return
      case "acl:check": {
        const matchedRule = await pm2.checkACL(value.localMac, value.localPort, value.remoteType, value.remoteVal, value.remotePort, value.protocol, value.direction || "outbound");
        return { matchedRule: matchedRule }
      }
      case "wifi:switch": {
        if (!value.ssid || !value.intf) {
          throw { code: 400, msg: "both 'ssid' and 'intf' should be specified" }
        } else {
          const resp = await FireRouter.switchWifi(value.intf, value.ssid, value.params);
          if (resp && _.isArray(resp.errors) && resp.errors.length > 0) {
            throw { code: 400, msg: `Failed to switch wifi on ${value.intf} to ${value.ssid}`, errors: resp.errors }
          } else {
            return
          }
        }
      }
      case "network:txt_file:save": {
        if (!value.filename || !value.content) {
          throw { code: 400, msg: "both 'filename' and 'content' should be specified" }
        } else {
          await FireRouter.saveTextFile(value.filename, value.content);
          return
        }
      }
      case "network:txt_file:load": {
        if (!value.filename) {
          throw { code: 400, msg: "'filename' should be specified" }
        } else {
          const content = await FireRouter.loadTextFile(value.filename);
          return { content: content }
        }
      }
      case "network:file:remove": {
        if (!value.filename) {
          throw { code: 400, msg: "'filename' should be specified" }
        } else {
          await FireRouter.removeFile(value.filename);
          return
        }
      }
      case "intel:finger": {
        const target = value.target;
        if (target) {
          let result;
          try {
            result = await bone.intelFinger(target);
          } catch (err) {
            log.error("Error when intel finger", err);
          }
          if (result && result.whois) {
            return result
          } else {
            throw new Error(`failed to fetch intel for target: ${target}`);
          }
        } else {
          throw new Error(`invalid target: ${target}`);
        }
      }
      case 'customIntel:list':
        return intelTool.listCustomIntel(value.type)
      case 'customIntel:update': {
        const { target, type, del } = value
        const add = !del

        const intel = add ? value.intel : await intelTool.getCustomIntel(type, target)
        if (!intel) throw new Error('Intel not found')

        log.debug(add ? 'add' : 'remove', intel)

        await intelTool.updateCustomIntel(type, target, value.intel, add)

        return
      }
      case "exception:create": {
        const result = await em.createException(value)
        sem.sendEventToAll({
          type: "ExceptionChange",
          message: ""
        });
        return result
      }
      case "exception:update": {
        const result = await em.updateException(value)
        sem.sendEventToAll({
          type: "ExceptionChange",
          message: ""
        });
        return result
      }
      case "exception:delete":
        await em.deleteException(value.exceptionID)
        sem.sendEventToAll({
          type: "ExceptionChange",
          message: ""
        });
        return
      case "reset":
        return
      case "startSupport": {
        const timeout = (value && value.timeout) || null;
        let { config, errMsg } = await frp.remoteSupportStart(timeout);
        if (config.startCode == FRPSUCCESSCODE) {
          const obj = await ssh.resetRandomPassword();
          config.password = obj && obj.password;
          config.passwordTs = obj && obj.timestamp;
          return config
        } else {
          throw errMsg.join(";")
        }
      }
      case "stopSupport":
        await frp.stop()
        await ssh.resetRandomPassword();
        return
      case "setManualSpoof": {
        let mac = value.mac
        let manualSpoof = value.manualSpoof ? "1" : "0"

        if (!mac) {
          throw new Error("invalid request")
        }

        await hostTool.updateMACKey({
          mac: mac,
          manualSpoof: manualSpoof
        })

        if (await mode.isManualSpoofModeOn()) {
          await sm.loadManualSpoof(mac)
        }

        return
      }
      case "manualSpoofUpdate":
        await modeManager.publishManualSpoofUpdate()
        return
      case "isSpoofRunning": {
        let timeout = value.timeout

        let running = false

        if (timeout) {
          let begin = Date.now() / 1000;

          while (Date.now() / 1000 < begin + timeout) {
            const secondsLeft = Math.floor((begin + timeout) - Date.now() / 1000);
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

        return { running }
      }
      case "spoofMe": {
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

          return
        } else {
          throw new Error("Invalid IP Address")
        }

      }
      case "validateSpoof": {
        let ip = value.ip
        let timeout = value.timeout || 60 // by default, wait for 60 seconds

        // add current ip to spoof list
        await sm.directSpoof(ip)

        let begin = Date.now() / 1000;

        let result = false

        while (Date.now() / 1000 < begin + timeout) {
          log.info(`Checking if IP ${ip} is being spoofed, ${-1 * (Date.now() / 1000 - (begin + timeout))} seconds left`)
          result = await sm.isSpoof(ip)
          if (result) {
            break
          }
          await delay(1000)
        }

        return {
          result: result
        }
      }
      case "bootingComplete":
        await f.setBootingComplete()
        this._scheduleRedisBackgroundSave();
        return
      case "resetBootingComplete":
        await f.resetBootingComplete()
        return
      case "joinBeta":
        await this.switchBranch("beta")
        return
      case "leaveBeta":
        await this.switchBranch("prod")
        return
      case "switchBranch":
        await this.switchBranch(value.target)
        return
      case "switchFirmwareBranch":
        await FireRouter.switchBranch(value.target);
        return
      case "enableBinding":
        await sysTool.restartFireKickService()
        return
      case "disableBinding":
        await sysTool.stopFireKickService()
        return
      case "isBindingActive": {
        const active = await sysTool.isFireKickRunning();
        return { active }
      }
      case "enableFeature": {
        const featureName = value.featureName;
        if (featureName) {
          await fc.enableDynamicFeature(featureName)
        }
        return
      }
      case "disableFeature": {
        const featureName = value.featureName;
        if (featureName) {
          await fc.disableDynamicFeature(featureName)
        }
        return
      }
      case "clearFeatureDynamicFlag": {
        const featureName = value.featureName;
        if (featureName) {
          await fc.clearDynamicFeature(featureName)
        }
        return
      }
      case "releaseMonkey": {
        sem.emitEvent({
          type: "ReleaseMonkey",
          message: "Release a monkey to test system",
          toProcess: 'FireMain',
          monkeyType: value && value.monkeyType
        })
        return
      }
      case "reloadCategoryFromBone": {
        const category = value.category
        sem.emitEvent({
          type: "Categorty:ReloadFromBone", // force re-activate category
          category: category,
          toProcess: "FireMain"
        })
        return
      }
      case "deleteCategory": {
        const category = value.category;
        if (category) {
          sem.emitEvent({
            type: "Category:Delete",
            category: category,
            toProcess: "FireMain"
          })
          return
        } else {
          throw { code: 400, msg: `Invalid category: ${category}` }
        }
      }
      case "addIncludeDomain": {
        const category = value.category
        let domain = value.domain
        const regex = /^[-a-zA-Z0-9.*]+?/;
        if (!regex.test(domain)) {
          throw { code: 400, msg: "Invalid domain." }
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
        return
      }
      case "removeIncludeDomain": {
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
        return
      }
      case "addExcludeDomain": {
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
        return
      }
      case "removeExcludeDomain": {
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
        return
      }
      case "updateIncludedElements": {
        const category = value.category;
        const elements = value.elements;
        await categoryUpdater.updateIncludedElements(category, elements);
        const event = {
          type: "UPDATE_CATEGORY_DOMAIN",
          category: category
        };
        sem.sendEventToAll(event);
        return
      }
      case "createOrUpdateCustomizedCategory": {
        const category = value.category;
        const obj = value.obj;
        const c = await categoryUpdater.createOrUpdateCustomizedCategory(category, obj);
        return c
      }
      case "removeCustomizedCategory": {
        const category = value.category;
        await categoryUpdater.removeCustomizedCategory(category);
        return
      }
      case "createOrUpdateRuleGroup": {
        const uuid = value.uuid;
        const obj = value.obj;
        const rg = await pm2.createOrUpdateRuleGroup(uuid, obj);
        return rg
      }
      case "removeRuleGroup": {
        const uuid = value.uuid;
        await pm2.deleteRuleGroupRelatedPolicies(uuid);
        await pm2.removeRuleGroup(uuid);
        return
      }
      case "createOrUpdateVirtWanGroup": {
        if (_.isEmpty(value.name) || _.isEmpty(value.wans) || _.isEmpty(value.type)) {
          throw {code: 400, msg: "'name', 'wans' and 'type' should be specified"}
        }
        await this.virtWanGroupManager.createOrUpdateVirtWanGroup(value);
        return
      }
      case "removeVirtWanGroup": {
        if (_.isEmpty(value.uuid)) {
          throw {code: 400, msg: "'uuid' should be specified"}
        }
        await pm2.deleteVirtWanGroupRelatedPolicies(value.uuid);
        await this.virtWanGroupManager.removeVirtWanGroup(value.uuid);
        return
      }
      case "boneMessage": {
        this.boneMsgHandler(value);
        return
      }
      case "generateProToken": {
        tokenManager.generateToken(gid);
        return
      }
      case "revokeProToken": {
        tokenManager.revokeToken(gid);
        return
      }
      case "vpnProfile:grant": {
        const cn = value.cn;
        const regenerate = value.regenerate || false;
        if (!cn) {
          throw { code: 400, msg: "'cn' is not specified." }
        }
        const matches = cn.match(/^[a-zA-Z0-9]+/g);
        if (cn.length > 32 || matches == null || matches.length != 1 || matches[0] !== cn) {
          throw { code: 400, msg: "'cn' should only contain alphanumeric letters and no longer than 32 characters." }
        }
        const settings = value.settings || {};
        const allowCustomizedProfiles = platform.getAllowCustomizedProfiles() || 1;
        const allSettings = await VpnManager.getAllSettings();
        if (Object.keys(allSettings).filter((name) => {
          return name !== "fishboneVPN1" && name !== cn;
        }).length >= allowCustomizedProfiles) {
          // Only one customized VPN profile is supported currently besides default VPN profile fishboneVPN1
          throw { code: 401, msg: `Only ${allowCustomizedProfiles} customized VPN profile${allowCustomizedProfiles > 1 ? 's are' : ' is'} supported.` }
        } else {
          const systemPolicy = await this.hostManager.loadPolicyAsync();
          const vpnConfig = systemPolicy.vpn || {};
          let externalPort = "1194";
          if (vpnConfig && vpnConfig.externalPort)
            externalPort = vpnConfig.externalPort;
          const protocol = vpnConfig && vpnConfig.protocol;
          const ddnsConfig = systemPolicy.ddns || {};
          const ddnsEnabled = ddnsConfig.hasOwnProperty("state") ? ddnsConfig.state : true;
          await VpnManager.configureClient(cn, settings)
          const { ovpnfile, password, timestamp } = await VpnManager.getOvpnFile(cn, null, regenerate, externalPort, protocol, ddnsEnabled)
          return { ovpnfile, password, settings, timestamp }
        }
      }
      case "vpnProfile:delete": {
        const cn = value.cn;
        if (!cn) {
          throw { code: 400, msg: "'cn' is not specified." }
        }
        await VpnManager.revokeOvpnFile(cn);
        return
      }
      case "vpnProfile:get": {
        const cn = value.cn;
        if (!cn) {
          throw { code: 400, msg: "'cn' is not specified." }
        }
        const settings = await VpnManager.getSettings(cn);
        if (!settings) {
          throw { code: 404, msg: `VPN profile of ${cn} does not exist.` }
        }
        const systemPolicy = await this.hostManager.loadPolicyAsync();
        const vpnConfig = systemPolicy.vpn || {};
        let externalPort = "1194";
        if (vpnConfig && vpnConfig.externalPort)
          externalPort = vpnConfig.externalPort;
        const protocol = vpnConfig && vpnConfig.protocol;
        const ddnsConfig = systemPolicy.ddns || {};
        const ddnsEnabled = ddnsConfig.hasOwnProperty("state") ? ddnsConfig.state : true;
        const { ovpnfile, password, timestamp } = await VpnManager.getOvpnFile(cn, null, false, externalPort, protocol, ddnsEnabled)
        return { ovpnfile, password, settings, timestamp }
      }
      case "vpnProfile:list": {
        const allSettings = await VpnManager.getAllSettings();
        const statistics = await new VpnManager().getStatistics();
        const vpnProfiles = [];
        for (let cn in allSettings) {
          // special handling for common name starting with fishboneVPN1
          const timestamp = await VpnManager.getVpnConfigureTimestamp(cn);
          vpnProfiles.push({ cn: cn, settings: allSettings[cn], connections: statistics && statistics.clients && Array.isArray(statistics.clients) && statistics.clients.filter(c => (cn === "fishboneVPN1" && c.cn.startsWith(cn)) || c.cn === cn) || [], timestamp: timestamp });
        }
        return vpnProfiles
      }
      case "vpnConnection:kill": {
        if (!value.addr) {
          throw { code: 400, msg: "'addr' is not specified." }
        }
        const addrPort = value.addr.split(":");
        if (addrPort.length != 2) {
          throw { code: 400, msg: "'addr' should consist of '<ip address>:<port>" }
        }
        const addr = addrPort[0];
        const port = addrPort[1];
        if (!iptool.isV4Format(addr) || Number.isNaN(port) || !Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) {
          throw { code: 400, msg: "IP address should be IPv4 format and port should be in [0, 65535]" }
        }
        await new VpnManager().killClient(value.addr);
        return
      }
      case "startVpnClient": {
        const type = value.type;
        if (!type) {
          throw { code: 400, msg: "'type' is not specified." }
        }
        const profileId = value.profileId;
        if (!profileId) {
          throw { code: 400, msg: "'profileId' is not specified." }
        }
        const c = VPNClient.getClass(type);
        if (!c) {
          throw { code: 400, msg: `Unsupported VPN client type: ${type}` }
        }
        const vpnClient = new c({profileId});
        await vpnClient.setup()
        const { result, errMsg } = await vpnClient.start().catch(err => {
          log.error(`Failed to start ${type} vpn client for ${profileId}`, err);
          throw { code: 400, msg: _.isObject(err) ? err.message : err }
        })
        if (!result) {
          await vpnClient.stop();
          // HTTP 408 stands for request timeout
          throw { code: 408, msg: !_.isEmpty(errMsg) ? errMsg : `Failed to connect to ${vpnClient.getDisplayName()}, please check the profile settings and try again.` }
        } else {
          return
        }
      }
      case "stopVpnClient": {
        const type = value.type;
        if (!type) {
          throw { code: 400, msg: "'type' is not specified." }
        }
        const profileId = value.profileId;
        if (!profileId) {
          throw { code: 400, msg: "'profileId' is not specified." }
        }
        const c = VPNClient.getClass(type);
        if (!c) {
          throw { code: 400, msg: `Unsupported VPN client type: ${type}` }
        }
        const vpnClient = new c({profileId});
        // error in setup should not interrupt stop vpn client
        await vpnClient.setup().catch((err) => {
          log.error(`Failed to setup ${type} vpn client for ${profileId}`, err);
        });
        const stats = await vpnClient.getStatistics();
        await vpnClient.stop();
        return { stats: stats }
      }
      case "saveVpnProfile":
      case "saveOvpnProfile": {
        let type = value.type || "openvpn";
        const profileId = value.profileId;
        const settings = value.settings || {};
        if (!profileId) {
          throw { code: 400, msg: "'profileId' should be specified" }
        }
        const matches = profileId.match(/^[a-zA-Z0-9_]+/g);
        if (profileId.length > 10 || matches == null || matches.length != 1 || matches[0] !== profileId) {
          throw { code: 400, msg: "'profileId' should only contain alphanumeric letters or underscore and no longer than 10 characters" }
        }
        const c = VPNClient.getClass(type);
        if (!c) {
          throw { code: 400, msg: `Unsupported VPN client type: ${type}` }
        }
        const vpnClient = new c({profileId});
        await vpnClient.checkAndSaveProfile(value);
        if (settings)
          await vpnClient.saveSettings(settings);
        await vpnClient.setup();
        const attributes = await vpnClient.getAttributes(true);
        return attributes
      }
      case "deleteVpnProfile":
      case "deleteOvpnProfile": {
        const type = value.type || "openvpn";
        const profileId = value.profileId;
        if (!profileId || profileId === "") {
          throw { code: 400, msg: "'profileId' is not specified" }
        }
        const c = VPNClient.getClass(type);
        if (!c) {
          throw { code: 400, msg: `Unsupported VPN client type: ${type}` }
        }
        const vpnClient = new c({profileId});
        const status = await vpnClient.status();
        if (status) {
          throw { code: 400, msg: `${type} VPN client ${profileId} is still running` }
        } else {
          await pm2.deleteVpnClientRelatedPolicies(profileId);
          await vpnClient.destroy();
          this._portforward(null, {
            "applyToAll": "*",
            "protocol": "*",
            "wanUUID": `${Constants.ACL_VPN_CLIENT_WAN_PREFIX}${profileId}`,
            "extIP": "*",
            "dport": "*",
            "toMac": "*",
            "toGuid": "*",
            "toPort": "*",
            "state": false
          });
        }
        return
      }
      case "dismissVersionUpdate": {
        await sysManager.clearVersionUpdate();
        return
      }
      case "saveRSAPublicKey": {
        const content = value.pubKey;
        const identity = value.identity;
        await ssh.saveRSAPublicKey(content, identity);
        return
      }
      case "migration:export": {
        const partition = value.partition;
        const encryptionIdentity = value.encryptionIdentity;
        await migration.exportDataPartition(partition, encryptionIdentity);
        return
      }
      case "migration:import": {
        const partition = value.partition;
        const encryptionIdentity = value.encryptionIdentity;
        await migration.importDataPartition(partition, encryptionIdentity);
        return
      }
      case "migration:transfer": {
        const host = value.host;
        const partition = value.partition;
        const transferIdentity = value.transferIdentity;
        await migration.transferDataPartition(host, partition, transferIdentity);
        return
      }
      case "migration:transferHiddenFolder": {
        const host = value.host;
        const transferIdentity = value.transferIdentity;
        await migration.transferHiddenFolder(host, transferIdentity);
        return
      }
      case "enableWebToken": {
        const tokenInfo = await fireWeb.enableWebToken(this.eptcloud);
        if (!tokenInfo.publicKey || !tokenInfo.privateKey) {
          throw "publickKey and privateKey are required"
        }
        return tokenInfo
      }
      case "addPeers": {
        const peers = value.peers;
        if (_.isEmpty(peers)) {
          throw { code: 400, msg: `"peers" should not be empty` }
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
          return {results}
        }
      }
      case "removeUPnP": {
        if (!platform.isFireRouterManaged()) {
          throw { code: 405, msg: "Remove UPnP is not supported on this platform" }
        } else {
          const type = value.type;
          switch (type) {
            case "single": {
              const { externalPort, internalIP, internalPort, protocol } = value;
              if (!externalPort || !internalIP || !internalPort || !protocol) {
                throw { code: 400, msg: "Missing required parameters: externalPort, internalIP, internalPort, protocol" }
              } else {
                await this._removeSingleUPnP(protocol, externalPort, internalIP, internalPort);
              }
              return
            }
            case "network": {
              const uuid = value.uuid;
              const intf = sysManager.getInterfaceViaUUID(uuid);
              if (!intf) {
                throw { code: 404, msg: `Network with uuid ${uuid} is not found` }
              } else {
                await this._removeUPnPByNetwork(intf.name);
              }
              return
            }
            case "all": {
              await this._removeAllUPnP();
              return
            }
            default:
              throw { code: 400, msg: `Unknown operation type ${type}` }
          }
        }
      }
      case "host:create": {
        const host = value.host;
        if (!host || !host.mac) {
          throw { code: 400, msg: "'host' or 'host.mac' is not specified" }
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
          bname: "bname",
          lastActive: "lastActiveTimestamp",
          firstFound: "firstFoundTimestamp",
          detect: 'detect',
        };
        const hostObj = {};
        const keyList = Object.keys(savingKeysMap)
        for (const key of Object.keys(host)) {
          if (keyList.includes(key)) {
            if (!_.isString(host[key]))
              hostObj[savingKeysMap[key]] = JSON.stringify(host[key]);
            else
              hostObj[savingKeysMap[key]] = host[key];
          }
        }
        if (!hostObj.firstFoundTimestamp)
          // set firstFound time as a activeTS for migration, so non-existing device could expire normal
          hostObj.firstFoundTimestamp = Date.now() / 1000;
        this.messageBus.publish("DiscoveryEvent", "Device:Create", hostObj.mac, hostObj);
        return
      }
      case "host:pin": {
        const mac = value.mac.toUpperCase();
        const macExists = await hostTool.macExists(mac);
        if (macExists) {
          // pinned hosts will always be included in init data
          await hostTool.updateKeysInMAC(mac, {pinned: 1});
        } else {
          throw { code: 404, msg: "device not found" }
        }
        return
      }
      case "host:unpin": {
        const mac = value.mac.toUpperCase();
        const macExists = await hostTool.macExists(mac);
        if (macExists) {
          await hostTool.deleteKeysInMAC(mac, ["pinned"]);
        } else {
          throw { code: 404, msg: "device not found" }
        }
        return
      }
      case "host:delete": {
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

        } else {
          throw { code: 404, msg: "device not found" }
        }
        return
      }
      // only IPv4 is supported now.
      case "vipProfile:create": {
        const uid = await vipManager.create(value)
        value.uid = uid
        return value
      }
      case "vipProfile:delete": {
        const uid = value.uid
        let configs = await vipManager.load();
        if (!configs.has(uid)) {
          throw { code: 400, msg: "Vip identity not exists." }
        }
        await vipManager.delete(uid);
        return
      }
      case "networkInterface:update": {
        // secondary interface settings includes those in config files and dhcp address pool range
        const network = msg.data.value.network;
        const intf = msg.data.value.interface;
        const dhcpRange = msg.data.value.dhcpRange;
        const dnsServers = msg.data.value.dnsServers || []; // default value is empty
        const dhcpLeaseTime = msg.data.value.dhcpLeaseTime;
        if (!network || !intf || !intf.ipAddress || !intf.subnetMask) {
          throw { code: 400, msg: "network, interface.ipAddress/subnetMask should be specified." }
        }
        if (dhcpRange && (!dhcpRange.begin || !dhcpRange.end)) {
          throw { code: 400, msg: "dhcpRange.start/end should be set at the same time." }
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
            await this.hostManager.setPolicyAsync("dnsmasq", dnsmasqPolicy);
            setTimeout(() => {
              modeManager.publishNetworkInterfaceUpdate();
            }, 5000); // update interface in 5 seconds, otherwise FireApi response may not reach client
            return
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
            await this.hostManager.setPolicyAsync("dnsmasq", dnsmasqPolicy);
            setTimeout(() => {
              modeManager.publishNetworkInterfaceUpdate();
            }, 5000); // update interface in 5 seconds, otherwise FireApi response may not reach client
            return
          }
          default:
            log.error("Unknown network type in networkInterface:update, " + network);
            throw { code: 400, msg: "Unknown network type: " + network }
        }
      }
      case "networkInterface:reset": {
        // reset alternative interface to dhcp mode. It merely delete the user static address config is user config file. Need to restart box to take effect.
        const network = msg.data.value.network;
        switch (network) {
          case "alternative": {
            await fc.removeUserConfig("alternativeInterface");
            break;
          }
        }
        // publish directly to update the "assignment" field in sys:network:info {itf} to expose current state to front end
        modeManager.publishNetworkInterfaceUpdate();
        return
      }
      case "networkInterface:revert": {
        //remove user customized configuration
        await fc.removeUserNetworkConfig();
        //load policy
        const systemPolicy = await this.hostManager.loadPolicyAsync();
        const dnsmasqConfig = systemPolicy.dnsmasq || {};
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
        return
      }
      case "networkInterface:get": {
        const network = msg.data.value.network;
        if (!network) {
          throw { code: 400, msg: "network should be specified." }
        } else {
          const config = await fc.getConfig(true);
          let dhcpRange = await dnsTool.getDefaultDhcpRange(network);
          switch (network) {
            case "secondary": {
              // convert ip/subnet to ip address and subnet mask
              const secondaryInterface = config.secondaryInterface;
              const secondaryIpSubnet = iptool.cidrSubnet(secondaryInterface.ip);
              const data = await this.hostManager.loadPolicyAsync()
              let secondaryDnsServers = sysManager.myDefaultDns();
              if (data.dnsmasq) {
                const dnsmasq = data.dnsmasq
                if (dnsmasq.secondaryDnsServers && dnsmasq.secondaryDnsServers.length !== 0) {
                  secondaryDnsServers = dnsmasq.secondaryDnsServers;
                }
                if (dnsmasq.secondaryDhcpRange) {
                  dhcpRange = dnsmasq.secondaryDhcpRange;
                }
              }
              return {
                interface: {
                  ipAddress: secondaryInterface.ip.split('/')[0],
                  subnetMask: secondaryIpSubnet.subnetMask
                },
                dhcpRange: dhcpRange,
                dhcpLeaseTime: (config.dhcpLeaseTime && config.dhcpLeaseTime.secondary) || (config.dhcp && config.dhcp.leaseTime),
                dnsServers: secondaryDnsServers
              }
            }
            case "alternative": {
              // convert ip/subnet to ip address and subnet mask
              const alternativeInterface = config.alternativeInterface || { ip: sysManager.mySubnet(), gateway: sysManager.myDefaultGateway() }; // default value is current ip/subnet/gateway on monitoring interface
              const alternativeIpSubnet = iptool.cidrSubnet(alternativeInterface.ip);
              const data = await this.hostManager.loadPolicyAsync()
              let alternativeDnsServers = sysManager.myDefaultDns();
              if (data.dnsmasq) {
                const dnsmasq = data.dnsmasq;
                if (dnsmasq.alternativeDnsServers && dnsmasq.alternativeDnsServers.length != 0) {
                  alternativeDnsServers = dnsmasq.alternativeDnsServers;
                }
                if (dnsmasq.alternativeDhcpRange) {
                  dhcpRange = dnsmasq.alternativeDhcpRange;
                }
              }
              return {
                interface: {
                  ipAddress: alternativeInterface.ip.split('/')[0],
                  subnetMask: alternativeIpSubnet.subnetMask,
                  gateway: alternativeInterface.gateway
                },
                dhcpRange: dhcpRange,
                dhcpLeaseTime: (config.dhcpLeaseTime && config.dhcpLeaseTime.alternative) || (config.dhcp && config.dhcp.leaseTime),
                dnsServers: alternativeDnsServers
              }
            }
            default:
              log.error("Unknwon network type in networkInterface:update, " + network);
              throw { code: 400, msg: "Unknown network type: " + network }
          }
        }
      }
      case "getConnTestDest":
        return conncheck.getDestToCheck();
      case "startConnTest": {
        if (!value.src || !value.src.ip) {
          throw { code: 400, msg: "src.ip should be specified" }
        }
        if (!value.dst || !value.dst.ip || !value.dst.port) {
          throw { code: 400, msg: "dst.ip and dst.port should be specified" }
        }
        const pid = await conncheck.startConnCheck(value.src, value.dst, value.duration);
        return { pid: pid }
      }
      case "getConnTestResult": {
        if (!value.pid) {
          throw { code: 400, msg: "pid should be specified" }
        }
        const result = await conncheck.getConnCheckResult(value.pid);
        if (!result) {
          throw { code: 404, msg: "Test result of specified pid is not found" }
        }
        return result
      }
      case "apt-get": {
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
        return
      }
      case "ble:control":
        await pclient.publishAsync(Message.MSG_FIRERESET_BLE_CONTROL_CHANNEL, value.state ? 1 : 0)
        return
      case "renewDHCPLease": {
        const intf = value.intf;
        const af = value.af || 4;
        if (!intf)
          throw { code: 400, msg: "'intf' should be specified"}
        else {
          const {code, body} = await FireRouter.renewDHCPLease(intf, af);
          if (body.errors && !_.isEmpty(body.errors)) {
            throw { code, msg: body.errors[0] }
          } else {
            if (!body.info)
              throw { code: 500, msg: `Failed to renew ${af == 4 ? "DHCP" : "DHCPv6"} lease on ${intf}` }
            else
              return body.info
          }
        }
      }
      default:
        // unsupported action
        throw new Error("Unsupported cmd action: " + msg.data.item)
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
        throw new Error("Can not switch to branch: " + target);
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

  async simpleTxData(msg, data = {}, err, cloudOptions) {
    return this.txData(
      /* gid     */ this.primarygid,
      /* msg     */ msg.data.item,
      /* obj     */ this.getDefaultResponseDataModel(msg, data, err),
      /* type    */ "jsondata",
      /* beepmsg */ "",
      /* whisper */ null,
      /* callback*/ cloudOptions,
      /* rawmsg  */ msg
    );
  }

  getDefaultResponseDataModel(msg, data, err) {
    let code = 200;
    let message = "";
    if (err) {
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

  async msgHandlerAsync(gid, rawmsg, from = 'app') {
    // msgHandlerAsync is direct callback mode
    // will return value directly, not send to cloud
    let ignoreRate = false;
    if (rawmsg && rawmsg.message && rawmsg.message.obj && rawmsg.message.obj.data) {
      ignoreRate = rawmsg.message.obj.data.ignoreRate;
      delete rawmsg.message.obj.data.ignoreRate;
    }
    if (ignoreRate) {
      log.info('ignore rate limit');
      const response = await this.msgHandler(gid, rawmsg)
      log.debug('msgHandler returned', response)
      return response
    } else {
      try {
        await this.rateLimiter[from].consume('msg_handler')
        const response = await this.msgHandler(gid, rawmsg)
        log.debug('msgHandler returned', response)
        return response
      } catch (err) {
        log.error(err)
        if (err instanceof RateLimiterRes) {
          throw {
            "Retry-After": err.msBeforeNext / 1000,
            "X-RateLimit-Limit": this.rateLimiter[from].points,
            "X-RateLimit-Reset": new Date(Date.now() + err.msBeforeNext)
          }
        } else
        throw err
      }
    }
  }

  async msgHandler(gid, rawmsg, cloudOptions) {
    log.debug(gid, rawmsg, cloudOptions)

    if(rawmsg.err === "decrypt_error") {
      return this.simpleTxData(rawmsg, null, { code: 412, msg: "decryption error" }, cloudOptions);
    }

    if (rawmsg.mtype === "msg" && rawmsg.message.type === 'jsondata') {
      let msg = rawmsg.message.obj;
      try {
        const eid = _.get(rawmsg, 'message.appInfo.eid')
        if (eid) {
          const revoked = await rclient.sismemberAsync(Constants.REDIS_KEY_EID_REVOKE_SET, eid);
          if (revoked) {
            return this.simpleTxData(msg, null, { code: 401, msg: "Unauthorized eid" }, cloudOptions);
          }
        }
        if (_.get(rawmsg, 'message.obj.data.item') !== 'ping') {
          rawmsg.message && !rawmsg.message.suppressLog && log.info("Received jsondata from app", rawmsg.message);
        }

        msg.appInfo = rawmsg.message.appInfo;
        if (rawmsg.message.obj.type === "jsonmsg") {
          switch(rawmsg.message.obj.mtype) {
            case "init": {
              if (rawmsg.message.appInfo) {
                this.processAppInfo(rawmsg.message.appInfo)
              }

              log.info("Process Init load event");

              let begin = Date.now();

              let options = {
                forceReload: true,
                includePinnedHosts: true,
                includePrivateMac: true,
                includeInactiveHosts: false,
                appInfo: rawmsg.message.appInfo
              }

              if (rawmsg.message.obj.data &&
                rawmsg.message.obj.data.simulator) {
                // options.simulator = 1
              }
              if (rawmsg.message.obj.data && rawmsg.message.obj.data.includeInactiveHosts)
              options.includeInactiveHosts = true;
              if (rawmsg.message.obj.data && rawmsg.message.obj.data.hasOwnProperty("includePrivateMac"))
              options.includePrivateMac = rawmsg.message.obj.data.includePrivateMac;

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
                  return this.simpleTxData(msg, json, null, cloudOptions);
                } else {
                  log.error("json is null when calling init")
                  const errModel = { code: 500, msg: "json is null when calling init" }
                  return this.simpleTxData(msg, null, errModel, cloudOptions)
                }
              } catch (err) {
                log.error("Error calling hostManager.toJson():", err);
                const errModel = { code: 500, msg: "got error when calling hostManager.toJson: " + err }
                return this.simpleTxData(msg, null, errModel, cloudOptions)
              }

            }
            case "set": {
              // mtype: set
              // target = "ip address" 0.0.0.0 is self
              // data.item = policy
              // data.value = {'block':1},
              //
              const result = await this.setHandler(gid, msg);
              return this.simpleTxData(msg, result, null, cloudOptions);
            }
            case "get": {
              let appInfo = appTool.getAppInfo(rawmsg.message);
              const result = await this.getHandler(gid, msg, appInfo);
              return this.simpleTxData(msg, result, null, cloudOptions);
            }
            case "cmd": {
              if (msg.data.item == 'batchAction') {
                const result = await this.batchHandler(gid, rawmsg);
                return this.simpleTxData(msg, result, null, cloudOptions);
              } else {
                const result = await this.cmdHandler(gid, msg);
                return this.simpleTxData(msg, result, null, cloudOptions);
              }
            }
            default: {
              const err = { code: 400, msg: "Unsupported operation " + rawmsg.message.obj.mtype }
              return this.simpleTxData(msg, {}, err, cloudOptions)
            }
          }
        }
      } catch(err) {
        log.error('Error process message', err)
        return this.simpleTxData(msg, {}, err, cloudOptions);
      }
    } else {
      const msg = await util.promisify(this.bot.processMessage).bind(this.bot)({
        text: rawmsg.message.msg,
        from: {
          address: rawmsg.message.from,
          channelId: gid
        }
      }).catch(()=>{})
      if (msg && msg.text) {
        return this.tx(gid, msg.text, "message");
      }
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
  async batchHandler(gid, rawmsg) {
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
    return results
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
        const ts = Math.floor(Date.now() / 1000);
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
      } catch (err) {
        log.error("Redis background save returns error", err.message);
      }
      await platform.ledDoneSaving().catch(() => undefined);
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
