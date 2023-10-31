/*    Copyright 2016-2020 Firewalla Inc.
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

const _ = require('lodash');
const log = require('../net2/logger.js')(__filename, 'info');
const util = require('util');

const i18n = require('../util/i18n.js');
const fc = require('../net2/config.js');
const moment = require('moment-timezone');
const sysManager = require('../net2/SysManager.js');
const IdentityManager = require('../net2/IdentityManager.js');
const validator = require('validator');
const Constants = require('../net2/Constants.js');


// Alarm structure
//   type (alarm type, each type has corresponding alarm template, one2one mapping)
//   timestamp (when event occcured)
//   device (each alarm should have a related device)
//   message (a summarized information about what happened, need support localization)
//   payloads (key-value pairs, used to populate message/investigation)
//      payload properties are prefixed in 3 different categories
//      p:  primary     required to rander alarm list
//      e:  extended    required to rander alarm detail
//      r:  ?           required in neither scenarios above

function suffixAutoBlock(alarm, category) {
  if (alarm.result === "block" &&
    alarm.result_method === "auto") {
    return `${category}_AUTOBLOCK`;
  }

  return category;
}

function suffixDirection(alarm, category) {
  if ("p.local_is_client" in alarm) {
    if (alarm["p.local_is_client"] === "1") {
      return `${category}_OUTBOUND`;
    } else {
      return `${category}_INBOUND`;
    }
  }

  return category;
}

function GetOpenPortAlarmCompareValue(alarm) {
  if (alarm.type == 'ALARM_OPENPORT') {
    return alarm['p.device.ip'] + alarm['p.open.protocol'] + alarm['p.open.port'];
  } else if (alarm.type == 'ALARM_UPNP') {
    return alarm['p.device.ip'] + alarm['p.upnp.protocol'] + alarm['p.upnp.private.port'];
  }

  return alarm.type
}

class Alarm {
  constructor(type, timestamp, device, info) {
    this.aid = 0;
    this.type = type;
    this.device = device;
    this.alarmTimestamp = new Date() / 1000;
    this.timestamp = timestamp;

    if (info) {
      Object.assign(this, info);
    }
    //    this.validate(type);

  }
  needPolicyMatch() {
    return false;
  }
  isSecurityAlarm() {
    return false;
  }

  getManagementType() {
    return "";
  }

  getNotifType() {
    return "NOTIF_TITLE_" + this.type;
  }

  getNotificationCategory() {
    return "NOTIF_" + this.getI18NCategory();
  }

  getI18NCategory() {
    return this.type;
  }

  getInfoCategory() {
    return "INFO_" + this.getI18NCategory();
  }

  localizedMessage() {
    return i18n.__(this.getInfoCategory(), this);
  }

  localizedNotification() {
    return i18n.__(this.getNotificationCategory(), this);
  }


  localizedNotificationTitleKey() {
    let key = `notif.title.${this.type}`;
    if (this["p.device.guid"]) {
      const identity = IdentityManager.getIdentityByGUID(this["p.device.guid"]);
      const suffix = identity && identity.getLocalizedNotificationKeySuffix();
      if (suffix)
        key = `${key}${suffix}`;
    }
    return key;
  }

  localizedNotificationTitleArray() {
    return [];
  }

  localizedNotificationContentKey() {
    let key = `notif.content.${this.type}`;
    if (this["p.device.guid"]) {
      const identity = IdentityManager.getIdentityByGUID(this["p.device.guid"]);
      const suffix = identity && identity.getLocalizedNotificationKeySuffix();
      if (suffix)
        key = `${key}${suffix}`;
    }
    return key;
  }

  localizedNotificationContentArray() {
    return [];
  }

  cloudAction() {
    const decision = this["p.cloud.decision"];
    switch (decision) {
      case "block": {
        if (!this["p.action.block"]) {
          return decision;
        } else {
          return null;
        }
      }
      case "ignore": {
        return decision;
      }
      case "alarm": {
        return null;
      }
      default:
        return decision;
    }
  }

  localizedInfo() {
    // if(this.timestamp)
    //   //this.localizedRelativeTime = moment(parseFloat(this.timestamp) * 1000).fromNow();
    //   this.localizedRelativeTime = "%@"; // will be fullfilled @ ios side

    return this.localizedMessage() + this.timestamp ? " %@" : "";
  }

  toString() {
    return util.inspect(this);
  }

  // toJsonObject() {
  //   let obj = {};
  //   for(var p in this) {
  //     obj[p] = this[p];
  //   }
  //   return obj;
  // }

  requiredKeys() {
    return ["p.device.name", "p.device.id", "p.device.mac"];
  }



  // check schema, minimal required key/value pairs in payloads
  validate(type) {

    this.requiredKeys().forEach((v) => {
      if (!this[v]) {
        log.error("Invalid payload for " + this.type + ", missing " + v);
        throw new Error("Invalid alarm object");
      }
    });

    return true;
  }

  keysToCompareForDedup() {
    return [];
  }

  isDup(alarm) {
    let alarm2 = this;
    let keysToCompare = this.keysToCompareForDedup();

    if (alarm.type !== alarm2.type)
      return false;

    for (var i in keysToCompare) {
      let k = keysToCompare[i];
      // using == to compromise numbers comparison
      if (alarm[k] && alarm2[k] && typeof alarm[k] != typeof alarm2[k]) {
        const idsA = _.isString(alarm[k]) ? JSON.parse(alarm[k]) : alarm[k];
        const idsB = _.isString(alarm2[k]) ? JSON.parse(alarm2[k]) : alarm2[k];
        if (!_.isEqual(idsA, idsB)) {
          return false;
        }
      } else if (alarm[k] && alarm2[k] && _.isEqual(alarm[k], alarm2[k])) {

      } else {
        return false;
      }
    }

    return true;
  }

  getExpirationTime() {
    return fc.getTimingConfig("alarm.cooldown") || 15 * 60; // 15 minutes
  }

  isOutbound() {
    if ("p.local_is_client" in this) {
      if (this["p.local_is_client"] === "1") {
        return true;
      } else {
        return false;
      }
    } else {
      return false;
    }
  }

  isInbound() {
    if ("p.local_is_client" in this) {
      if (this["p.local_is_client"] === "1") {
        return false;
      } else {
        return true;
      }
    } else {
      return false;
    }
  }

  isAutoBlock() {
    return this.result === "block" &&
      this.result_method === "auto";
  }

  redisfy() {
    const obj = Object.assign({}, this)
    for (const f in obj) {
      // this deletes '', null, undefined
      if (!obj[f] && obj[f] !== false && obj[f] !== 0) delete obj[f]

      if (obj[f] instanceof Object) obj[f] = JSON.stringify(obj[f])
    }

    return obj
  }
}


class NewDeviceAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_NEW_DEVICE", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ["p.device.mac"];
  }

  localizedNotificationContentArray() {
    return [this["p.device.name"], this["p.device.ip"]];
  }
}

class DeviceBackOnlineAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_DEVICE_BACK_ONLINE", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ["p.device.mac"];
  }

  localizedNotificationContentArray() {
    return [this["p.device.name"], this["p.device.ip"]];
  }
}

class DeviceOfflineAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_DEVICE_OFFLINE", timestamp, device, info);
    if (info && info["p.device.lastSeen"]) {
      this['p.device.lastSeenTimezone'] = moment(info["p.device.lastSeen"] * 1000).tz(sysManager.getTimezone()).format('LT')
    }
  }

  keysToCompareForDedup() {
    return ["p.device.mac"];
  }

  localizedNotificationContentArray() {
    return [this["p.device.name"], this["p.device.ip"], this["p.device.lastSeenTimezone"]];
  }
}

class SpoofingDeviceAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_SPOOFING_DEVICE", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ["p.device.mac", "p.device.name", "p.device.ip", "p.intf.id", "p.tag.ids"];
  }

  localizedNotificationContentArray() {
    return [this["p.device.name"], this["p.device.ip"]];
  }
  isSecurityAlarm(){
    return true;
  }
}

class CustomizedAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_CUSTOMIZED", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ["p.local.uid", "p.remote.uid", "p.pid"];
  }

  requiredKeys() {
    return ["p.device.ip", "p.dest.ip", "p.pid", "p.local.uid", "p.remote.uid"];
  }

  getExpirationTime() {
    return this["p.cooldown"] || 900;
  }

  localizedNotificationContentArray() {
    if (this["p.notif.message"])
      return [this["p.notif.message"]];
    
    if (this["p.local_is_client"] == "1") {
      const message = `${this["p.device.name"] || this["p.device.ip"]} accessed ${this["p.dest.name"] || this["p.dest.ip"]}`;
      return [message];
    } else {
      const message = `${this["p.dest.name"] || this["p.dest.ip"]} accessed ${this["p.device.name"] || this["p.device.ip"]}`;
      return [message];
    }
  }
}

class CustomizedSecurityAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_CUSTOMIZED_SECURITY", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ["p.description"];
  }

  requiredKeys() {
    return ["p.device.ip", "p.dest.ip", "p.description"];
  }

  localizedNotificationContentArray() {
    return [this["p.description"], this["p.device.ip"], this["p.device.name"], this["p.device.port"], this["p.dest.ip"], this["p.dest.name"], this["p.dest.port"], this["p.protocol"], this["p.app.protocol"]];
  }
}

class VPNClientConnectionAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_VPN_CLIENT_CONNECTION", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ["p.dest.ip", "p.vpnType", "p.device.mac"]; // p.deivce.mac is the guid of the VPN client
  }

  requiredKeys() {
    return ["p.dest.ip"];
  }

  getExpirationTime() {
    // for vpn client connection activities, only generate one alarm every 4 hours.
    return fc.getTimingConfig("alarm.vpn_client_connection.cooldown") || 60 * 60 * 4;
  }

  localizedNotificationContentArray() {
    return [this["p.dest.ip"], this["p.device.name"] === Constants.DEFAULT_VPN_PROFILE_CN ? "" : this["p.device.name"]];
  }
}

class VPNRestoreAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_VPN_RESTORE", timestamp, device, info);
    if (info && info["p.vpn.subtype"]) {
      let subtype = (['s2s', 'cs', 'openvpn'].indexOf(info["p.vpn.subtype"]) !== -1) ? info["p.vpn.subtype"] : 'openvpn';
      this['p.vpn.subtypename'] = i18n.__(`VPN_SUBTYPE_${subtype}`);
    }
    if (this.timestamp) {
      this["p.timestampTimezone"] = moment(this.timestamp * 1000).tz(sysManager.getTimezone()).format("LT")
    }
  }

  keysToCompareForDedup() {
    return ["p.vpn.profileid"];
  }

  requiredKeys() {
    return ["p.vpn.profileid"];
  }

  getExpirationTime() {
    return fc.getTimingConfig("alarm.vpn_connect.cooldown") || 60 * 5;
  }

  localizedNotificationContentKey() {
    let key = super.localizedNotificationContentKey();

    key += "." + this["p.vpn.subtype"];

    return key;
  }

  localizedNotificationContentArray() {
    return [this["p.vpn.displayname"], this["p.timestampTimezone"], this["p.vpn.devicecount"]];
  }
}

class VPNDisconnectAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_VPN_DISCONNECT", timestamp, device, info);
    if (info && info["p.vpn.subtype"]) {
      let subtype = (['s2s', 'cs', 'openvpn'].indexOf(info["p.vpn.subtype"]) !== -1) ? info["p.vpn.subtype"] : 'openvpn';
      this['p.vpn.subtypename'] = i18n.__(`VPN_SUBTYPE_${subtype}`);
    }
    if (this.timestamp) {
      this["p.timestampTimezone"] = moment(this.timestamp * 1000).tz(sysManager.getTimezone()).format("LT")
    }
  }

  getI18NCategory() {
    let category = super.getI18NCategory();
    if (this["p.vpn.strictvpn"] == true || this["p.vpn.strictvpn"] == "true") {
      category = category + "_KILLSWITCH";
    }
    return category;
  }

  getNotifType() {
    let notify_type = super.getNotifType();
    if (this["p.vpn.strictvpn"] == true || this["p.vpn.strictvpn"] == "true") {
      notify_type = notify_type + "_KILLSWITCH";
    }
    return notify_type;
  }

  keysToCompareForDedup() {
    return ["p.vpn.profileid"];
  }

  requiredKeys() {
    return ["p.vpn.profileid"];
  }

  getExpirationTime() {
    return fc.getTimingConfig("alarm.vpn_connect.cooldown") || 60 * 5;
  }

  localizedNotificationContentKey() {
    let key = super.localizedNotificationContentKey();

    key += "." + this["p.vpn.subtype"];
    if (this["p.vpn.strictvpn"] == false || this["p.vpn.strictvpn"] == "false") {
      key += ".FALLBACK";
    }

    return key;
  }

  localizedNotificationTitleKey() {
    let key = super.localizedNotificationTitleKey();

    if (this["p.vpn.strictvpn"] == false || this["p.vpn.strictvpn"] == "false") {
      key += ".FALLBACK";
    }

    return key;
  }

  localizedNotificationContentArray() {
    return [this["p.vpn.displayname"], this["p.timestampTimezone"], this["p.vpn.devicecount"]];
  }
}

class VulnerabilityAlarm extends Alarm {
  constructor(timestamp, device, vulnerabilityID, info) {
    super("ALARM_VULNERABILITY", timestamp, device, info);
    this["p.vid"] = vulnerabilityID;
  }

  needPolicyMatch(){
    return true;
  }
  isSecurityAlarm(){
    return true;
  }

  getI18NCategory() {
    return util.format("%s_%s", this.type, this["p.vid"]);
  }

  localizedNotificationContentKey() {
    return `notif.content.${this.type}.${this["p.vid"]}`;
  }

  localizedNotificationContentArray() {
    return [this["p.device.name"], this["p.device.ip"]];
  }

  isDup(alarm) {
    if (!super.isDup(alarm))
      return false;

    if (alarm["p.vid"] === this["p.vid"]) {
      return true;
    }

    return false;
  }
}

class BroNoticeAlarm extends Alarm {
  constructor(timestamp, device, notice, message, info) {
    super("ALARM_BRO_NOTICE", timestamp, device, info);
    this["p.noticeType"] = notice;
    this["p.message"] = message;
  }

  isDup(alarm) {
    let alarm2 = this;
    if (alarm['p.noticeType'] != alarm2['p.noticeType']) {
      return false;
    }
    if (alarm['p.dest.ip'] != alarm2['p.dest.ip'] || alarm['p.device.ip'] != alarm2['p.device.ip']) {
      return false;
    }
    return true;
  }
  getExpirationTime() {
    return fc.getTimingConfig("alarm.sshPwdGuess.cooldown") || 60 * 60
  }

  needPolicyMatch(){
    return true;
  }
  isSecurityAlarm(){
    return true;
  }

  keysToCompareForDedup() {
    return ["p.message", "p.device.name"];
  }

  requiredKeys() {
    return [];
  }

  localizedMessage() {
    return this["p.message"]; // use bro content as basic localized message, usually app side should use it's own messaging template
  }

  getI18NCategory() {
    let category = this.type;

    category = `${category}_${this["p.noticeType"]}`;

    category = suffixAutoBlock(this, category)

    // fallback if localization for this special bro type does not exist
    if (`NOTIF_${category}` === i18n.__(`NOTIF_${category}`)) {
      category = this.type;
    }

    return category;
  }

  localizedNotificationContentKey() {
    if (this["p.noticeType"]) {
      let key = `notif.content.${this.type}.${this["p.noticeType"]}`;
      if (this["p.local_is_client"] != undefined) {
        if (this["p.local_is_client"] != "1") {
          key += ".inbound";
        } else {
          key += ".outbound";
        }
      }
      if (this["p.noticeType"] == "Scan::Port_Scan") {
        if (this["p.dest.name"] != this["p.dest.ip"]) {
          key += ".internal";
        }
      }
      if (this["p.device.guid"]) {
        const identity = IdentityManager.getIdentityByGUID(this["p.device.guid"]);
        const suffix = identity && identity.getLocalizedNotificationKeySuffix();
        if (suffix)
          key = `${key}${suffix}`;
      }
      return key;
    } else {
      return super.localizedNotificationContentKey();
    }
  }

  localizedNotificationContentArray() {
    let deviceName = this["p.device.name"];
    if (this["p.device.guid"]) {
      const identity = IdentityManager.getIdentityByGUID(this["p.device.guid"]);
      if (identity) {
        deviceName = identity.getDeviceNameInNotificationContent(this);
      }
    }
    return [deviceName, this["p.device.ip"], this["p.dest.name"]];
  }
}

class IntelReportAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_INTEL_REPORT", timestamp, device, info);
  }

  needPolicyMatch(){
    return true;
  }

  getI18NCategory() {
    return "ALARM_INTEL_REPORT";

    if (Number(this["p.attempts"]) === 1) {
      return "ALARM_INTEL_REPORT";
    } else {
      return "ALARM_INTEL_REPORT_N";
    }
  }

  requiredKeys() {
    return [];
  }
}

class IntelAlarm extends Alarm {
  constructor(timestamp, device, severity, info) {
    super("ALARM_INTEL", timestamp, device, info);
    this["p.severity"] = severity;
    this["p.dest.readableName"] = this.getReadableDestination();
  }
  needPolicyMatch(){
    return true;
  }
  isSecurityAlarm(){
    return true;
  }

  getI18NCategory() {
    this["p.dest.readableName"] = this.getReadableDestination()

    let category = "ALARM_INTEL";

    if ("p.dest.url" in this) {
      category = "ALARM_URL_INTEL";
    }

    if (this["p.source"] === 'firewalla_intel' && this["p.security.primaryReason"])
      category = 'FW_INTEL_' + category;

    category = suffixDirection(this, category);
    category = suffixAutoBlock(this, category)

    return category;
  }

  getReadableDestination() {
    const name = this["p.dest.name"];
    const port = this["p.dest.port"];
    const url = this["p.dest.url"];

    if (url) {
      return url;
    } else if (name && port) {
      if (port == 80) {
        return `http://${name}`
      } else if (port == 443) {
        return `https://${name}`
      } else {
        return `${name}:${port}`
      }
    } else {
      if (name) {
        return name
      } else {
        return this["p.dest.ip"]
      }
    }
  }

  keysToCompareForDedup() {
    const url = this["p.dest.url"];
    if (url) {
      return ["p.device.mac", "p.dest.name", "p.dest.url", "p.dest.port", "p.intf.id", "p.tag.ids"];
    }
    return ["p.device.mac", "p.dest.name", "p.dest.port", "p.intf.id", "p.tag.ids"];
  }

  localizedNotificationContentKey() {
    let key = `notif.content.${this.type}`;

    if (this.isInbound()) {
      key += ".INBOUND";
    } else if (this.isOutbound()) {
      key += ".OUTBOUND";
    }

    if (this.isAutoBlock()) {
      key += ".AUTOBLOCK";
    }

    if (this["p.device.guid"]) {
      const identity = IdentityManager.getIdentityByGUID(this["p.device.guid"]);
      const suffix = identity && identity.getLocalizedNotificationKeySuffix();
      if (suffix)
        key = `${key}${suffix}`;
    }
    return key;
  }

  localizedNotificationContentArray() {
    // device name
    // dest name
    // dest category
    // device port
    // device url
    let deviceName = this["p.device.name"];
    if (this["p.device.guid"]) {
      const identity = IdentityManager.getIdentityByGUID(this["p.device.guid"]);
      if (identity) {
        deviceName = identity.getDeviceNameInNotificationContent(this);
      }
    }

    return [deviceName,
    this.getReadableDestination(),
    this["p.security.primaryReason"] || "malicious",
    this["p.device.port"],
    this["p.device.url"]];
  }
}

class OutboundAlarm extends Alarm {

  constructor(type, timestamp, device, destinationID, info) {
    super(type, timestamp, device, info);
    // p.dest.id looks like a total redundent field, p.dest.name should be able to repleace it
    // none of the clients seems to be actually using it either, 11-05-20
    this['p.dest.name'] = destinationID;
    this["p.dest.id"] = destinationID;
    if (this.timestamp) {
      this["p.timestampTimezone"] = moment(this.timestamp * 1000).tz(sysManager.getTimezone()).format("LT")
    }
  }

  needPolicyMatch(){
    return true;
  }

  requiredKeys() {
    return super.requiredKeys().concat(['p.dest.name']);
  }

  getDestinationHostname() {
    return this["p.dest.hostname"];
  }

  setDestinationHostname(hostname) {
    this["p.dest.hostname"] = hostname;
  }

  getDestinationName() {
    return this["p.dest.name"];
  }

  setDestinationName(name) {
    this["p.dest.name"] = name;
  }

  setDestinationIPAddress(ip) {
    this["p.dest.ip"] = ip;
  }

  getDestinationIPAddress() {
    return this["p.dest.ip"];
  }


  keysToCompareForDedup() {
    return ["p.device.mac", "p.dest.name", "p.intf.id", "p.tag.ids"];
  }

  isDup(alarm) {
    let alarm2 = this;

    if (alarm.type !== alarm2.type) {
      return false;
    }

    const macKey = "p.device.mac";
    const destDomainKey = "p.dest.domain";
    const destNameKey = "p.dest.name";

    // Mac
    if (!alarm[macKey] ||
      !alarm2[macKey] ||
      alarm[macKey] !== alarm2[macKey]) {
      return false;
    }

    // Interface
    const intfKey = "p.intf.id";
    if (!_.has(alarm, intfKey) || !_.has(alarm2, intfKey) || alarm[intfKey] !== alarm2[intfKey]) {
      return false;
    }

    // now these two alarms have same device MAC

    // Destination
    if (destDomainKey in alarm &&
      destDomainKey in alarm2 &&
      alarm[destDomainKey] === alarm2[destDomainKey]) {
      return true;
    }


    if (!alarm[destNameKey] ||
      !alarm2[destNameKey] ||
      alarm[destNameKey] !== alarm2[destNameKey]) {
      return false;
    }

    return true;
  }
}

class AbnormalBandwidthUsageAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_ABNORMAL_BANDWIDTH_USAGE", timestamp, device, info);
  }
  localizedNotificationContentArray() {
    return [this["p.device.name"],
    this["p.totalUsage.humansize"],
    this["p.duration"],
    this["p.percentage"]
    ];
  }
}

class OverDataPlanUsageAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_OVER_DATA_PLAN_USAGE", timestamp, device, info);
  }
  isDup(alarm) {
    let alarm2 = this;
    if (alarm.type !== alarm2.type) {
      return false;
    }
    if (alarm['p.monthly.endts'] != alarm2['p.monthly.endts'] || alarm['p.alarm.level'] != alarm2['p.alarm.level']) {
      return false;
    }
    return true;
  }
  getExpirationTime() {
    return fc.getTimingConfig("alarm.data_plan_alarm.cooldown") || 60 * 60 * 24 * 30
  }
  requiredKeys() {
    return [];
  }
  localizedNotificationContentArray() {
    return [this["p.percentage"],
    this["p.totalUsage.humansize"],
    this["p.planUsage.humansize"]
    ];
  }
}

class AbnormalUploadAlarm extends OutboundAlarm {
  constructor(timestamp, device, destID, info) {
    super("ALARM_LARGE_UPLOAD", timestamp, device, destID, info);
  }

  getI18NCategory() {
    let category = "ALARM_LARGE_UPLOAD";

    category = suffixDirection(this, category);

    return category
  }

  getNotificationCategory() {
    let category = super.getNotificationCategory()

    if (this["p.dest.name"] === this["p.dest.ip"]) {
      if (this["p.dest.country"]) {
        let country = this["p.dest.country"]
        let locale = i18n.getLocale()
        try {
          let countryCodeFile = `${__dirname}/../extension/countryCodes/${locale}.json`
          let code = require(countryCodeFile)
          this["p.dest.countryLocalized"] = code[country]
          category = category + "_COUNTRY"
        } catch (error) {
          log.error("Failed to parse country code file:", error)
        }
      }
    }

    return category
  }

  getCountryName() {
    if (this["p.dest.country"]) {
      let country = this["p.dest.country"]
      let locale = i18n.getLocale()
      try {
        let countryCodeFile = `${__dirname}/../extension/countryCodes/${locale}.json`
        let code = require(countryCodeFile)
        return code[country];
      } catch (error) {
        log.error("Failed to parse country code file:", error)
      }
    }

    return null;
  }

  getExpirationTime() {
    // for upload activity, only generate one alarm every 4 hours.
    return fc.getTimingConfig("alarm.large_upload.cooldown") || 60 * 60 * 4
  }

  // dedup implemented before generation @ FlowMonitor
  isDup() {
    return false;
  }

  localizedNotificationContentKey() {
    if (this["p.dest.name"] === this["p.dest.ip"] && this["p.dest.country"]) {
      return super.localizedNotificationContentKey() + "_COUNTRY";
    } else {
      return super.localizedNotificationContentKey();
    }
  }

  localizedNotificationContentArray() {
    return [
      this["p.device.name"],
      this["p.transfer.outbound.humansize"],
      this["p.dest.name"],
      this["p.timestampTimezone"],
      this.getCountryName()
    ];
  }

}

class LargeUploadAlarm extends OutboundAlarm {
  constructor(timestamp, device, destID, info) {
    super("ALARM_LARGE_UPLOAD_2", timestamp, device, destID, info);
  }

  getI18NCategory() {
    let category = "ALARM_LARGE_UPLOAD_2";

    category = suffixDirection(this, category);

    return category
  }

  getNotificationCategory() {
    let category = super.getNotificationCategory()

    if (this["p.dest.name"] === this["p.dest.ip"]) {
      if (this["p.dest.country"]) {
        let country = this["p.dest.country"]
        let locale = i18n.getLocale()
        try {
          let countryCodeFile = `${__dirname}/../extension/countryCodes/${locale}.json`
          let code = require(countryCodeFile)
          this["p.dest.countryLocalized"] = code[country]
          category = category + "_COUNTRY"
        } catch (error) {
          log.error("Failed to parse country code file:", error)
        }
      }
    }

    return category
  }

  getCountryName() {
    if (this["p.dest.country"]) {
      let country = this["p.dest.country"]
      let locale = i18n.getLocale()
      try {
        let countryCodeFile = `${__dirname}/../extension/countryCodes/${locale}.json`
        let code = require(countryCodeFile)
        return code[country];
      } catch (error) {
        log.error("Failed to parse country code file:", error)
      }
    }

    return null;
  }

  getExpirationTime() {
    // for upload activity, only generate one alarm every 4 hours.
    return fc.getTimingConfig("alarm.large_upload.cooldown") || 60 * 60 * 4
  }

  // dedup implemented before generation @ FlowMonitor
  isDup() {
    return false;
  }

  localizedNotificationContentKey() {
    if (this["p.dest.name"] === this["p.dest.ip"] && this["p.dest.country"]) {
      return super.localizedNotificationContentKey() + "_COUNTRY";
    } else {
      return super.localizedNotificationContentKey();
    }
  }

  localizedNotificationContentArray() {
    return [
      this["p.device.name"],
      this["p.transfer.outbound.humansize"],
      this["p.dest.name"],
      this["p.timestampTimezone"],
      this.getCountryName()
    ];
  }

}

class VideoAlarm extends OutboundAlarm {
  constructor(timestamp, device, videoID, info) {
    super("ALARM_VIDEO", timestamp, device, videoID, info);
    this["p.showMap"] = false;
  }

  localizedNotificationContentArray() {
    let deviceName = this["p.device.name"];
    if (this["p.device.guid"]) {
      const identity = IdentityManager.getIdentityByGUID(this["p.device.guid"]);
      if (identity) {
        deviceName = identity.getDeviceNameInNotificationContent(this);
      }
    }
    return [deviceName, this["p.dest.name"]];
  }
}

class GameAlarm extends OutboundAlarm {
  constructor(timestamp, device, gameID, info) {
    super("ALARM_GAME", timestamp, device, gameID, info);
    this["p.showMap"] = false;
  }

  localizedNotificationContentArray() {
    let deviceName = this["p.device.name"];
    if (this["p.device.guid"]) {
      const identity = IdentityManager.getIdentityByGUID(this["p.device.guid"]);
      if (identity) {
        deviceName = identity.getDeviceNameInNotificationContent(this);
      }
    }
    return [deviceName, this["p.dest.name"]];
  }
}

class PornAlarm extends OutboundAlarm {
  constructor(timestamp, device, pornID, info) {
    super("ALARM_PORN", timestamp, device, pornID, info);
    this["p.showMap"] = false;
  }

  localizedNotificationContentArray() {
    let deviceName = this["p.device.name"];
    if (this["p.device.guid"]) {
      const identity = IdentityManager.getIdentityByGUID(this["p.device.guid"]);
      if (identity) {
        deviceName = identity.getDeviceNameInNotificationContent(this);
      }
    }
    return [deviceName, this["p.dest.name"]];
  }
}

class VpnAlarm extends OutboundAlarm {
  constructor(timestamp, device, vpnID, info) {
    super("ALARM_VPN", timestamp, device, vpnID, info);
    this["p.showMap"] = false;
  }

  localizedNotificationContentArray() {
    let deviceName = this["p.device.name"];
    if (this["p.device.guid"]) {
      const identity = IdentityManager.getIdentityByGUID(this["p.device.guid"]);
      if (identity) {
        deviceName = identity.getDeviceNameInNotificationContent(this);
      }
    }
    return [deviceName, this["p.dest.name"]];
  }
}

class SubnetAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_SUBNET", timestamp, device, info);
    this["p.showMap"] = false;
  }

  keysToCompareForDedup() {
    return ["p.device.mac", "p.device.ip", "p.subnet.length"];
  }

  getExpirationTime() {
    return fc.getTimingConfig("alarm.subnet.cooldown") || 30 * 24 * 60 * 60;
  }
}

class WeakPasswordAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super('ALARM_WEAK_PASSWORD', timestamp, device, info);
    this['p.showMap'] = false;
  }

  keysToCompareForDedup() {
    return ['p.device.ip', 'p.open.protocol', 'p.open.port', 'p.weakpasswords'];
  }

  requiredKeys() {
    return this.keysToCompareForDedup();
  }

  getExpirationTime() {
    return fc.getTimingConfig('alarm.weak_password.cooldown') || super.getExpirationTime();
  }

  localizedNotificationContentArray() {
    return [this["p.device.name"], this["p.open.protocol"], this["p.open.port"], this["p.open.servicename"], this["p.weakpasswords"]];
  }
}

class OpenPortAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super('ALARM_OPENPORT', timestamp, device, info);
    this['p.showMap'] = false;
  }

  needPolicyMatch(){
    return true;
  }

  keysToCompareForDedup() {
    return ['p.device.ip', 'p.open.protocol', 'p.open.port'];
  }

  requiredKeys() {
    return this.keysToCompareForDedup()
  }

  getExpirationTime() {
    return fc.getTimingConfig('alarm.upnp.cooldown') || super.getExpirationTime();
  }

  localizedNotificationContentArray() {
    return [this["p.device.name"], this["p.open.protocol"], this["p.open.port"], this["p.open.servicename"]];
  }

  isDup(alarm) {
    if (alarm.type === this.type) {
      return super.isDup(alarm);
    }

    if (['ALARM_OPENPORT', 'ALARM_UPNP'].includes(alarm.type)) {
      let compareValue = GetOpenPortAlarmCompareValue(alarm);
      let compareValue2 = GetOpenPortAlarmCompareValue(this);
      return (compareValue == compareValue2);
    }

    return false;
  }
}

class UpnpAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super('ALARM_UPNP', timestamp, device, info);
    this['p.showMap'] = false;
  }

  needPolicyMatch() { return true }

  keysToCompareForDedup() {
    return [
      'p.device.mac',
      'p.upnp.protocol',
      //'p.upnp.public.host', check header of UPNPSensor for details
      //'p.upnp.public.port',
      'p.upnp.private.host',
      'p.upnp.private.port'
    ];
  }

  requiredKeys() {
    return this.keysToCompareForDedup()
  }

  getExpirationTime() {
    return fc.getTimingConfig('alarm.upnp.cooldown') || super.getExpirationTime();
  }

  localizedNotificationContentArray() {
    return [this["p.upnp.protocol"],
    this["p.upnp.private.port"],
    this["p.device.name"]];
  }

  isDup(alarm) {
    if (alarm.type === this.type) {
      return super.isDup(alarm);
    }

    if (['ALARM_OPENPORT', 'ALARM_UPNP'].includes(alarm.type)) {
      let compareValue = GetOpenPortAlarmCompareValue(alarm);
      let compareValue2 = GetOpenPortAlarmCompareValue(this);
      return (compareValue == compareValue2);
    }

    return false;
  }
}
class DualWanAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super('ALARM_DUAL_WAN', timestamp, device, info);
    this['p.showMap'] = false;
  }

  keysToCompareForDedup() {
    return [
    ];
  }

  requiredKeys() {
    return this.keysToCompareForDedup()
  }

  getExpirationTime() {
    return fc.getTimingConfig('alarm.dual_wan.cooldown') || super.getExpirationTime();
  }

  localizedNotificationContentArray() {
    let wan = this["p.active.wans"];
    if (_.isString(wan) && validator.isJSON(wan))
      wan = JSON.parse(this["p.active.wans"]);

    return [
      this["p.iface.name"],
      _.join(wan, ",")
    ];
  }

  localizedNotificationContentKey() {
    let key = super.localizedNotificationContentKey();

    let wan = this["p.active.wans"];
    if (_.isString(wan) && validator.isJSON(wan))
      wan = JSON.parse(this["p.active.wans"]);

    if (this["p.wan.type"] == "single") {
      if (this["p.ready"] == "false") {
        key += ".lost.all";
      } else {
        key += ".remain.switch";
      }
      return key;
    }

    if (wan && wan.length == 0) {
      key += ".lost.all";
      return key;
    }

    if (this["p.ready"] == "false") {
      if (this["p.wan.switched"] == "true") {
        key += ".lost";
      } else {
        key += ".lost.remain";
      }
    } else {
      if (wan && wan.length > 1) {
        key += ".restore.all";
      } else {
        if (this["p.wan.switched"] == "true") {
          key += ".remain.switch";
        } else {
          key += ".remain";
        }
      }
    }

    return key;
  }

  isDup() {
    return false;
  }
}
class ScreenTimeAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super('ALARM_SCREEN_TIME', timestamp, device, info);
    this['p.showMap'] = false;
  }
  keysToCompareForDedup() {
    return ['p.scope','p.threshold','p.timeframe.begin','p.pid','p.type','p.target'];
  }
  requiredKeys(){
    return this.keysToCompareForDedup()
  }
  getExpirationTime() {
    return fc.getTimingConfig('alarm.alarm_screen_time.cooldown') || super.getExpirationTime();
  }
  localizedNotificationContentArray() {
    return [this["p.scope.names"],
    this["p.target"]];
  }
}

class NetworkMonitorRTTAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_NETWORK_MONITOR_RTT", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ['p.monitorType','p.target'];
  }

  requiredKeys(){
    return this.keysToCompareForDedup()
  }

  localizedNotificationContentArray() {
    return [this["p.monitorType"],
    this["p.target"],
    this["p.rtt"],
    this["p.rttLimit"]
    ];
  }
}

class NetworkMonitorLossrateAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_NETWORK_MONITOR_LOSSRATE", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ['p.monitorType','p.target'];
  }

  requiredKeys(){
    return this.keysToCompareForDedup()
  }

  localizedNotificationContentArray() {
    return [this["p.monitorType"],
    this["p.target"],
    this["p.lossrateLimit"],
    this["p.lossrate"]
    ];
  }
}

const classMapping = {
  ALARM_PORN: PornAlarm.prototype,
  ALARM_VIDEO: VideoAlarm.prototype,
  ALARM_GAME: GameAlarm.prototype,
  ALARM_VPN: VpnAlarm.prototype,
  ALARM_LARGE_UPLOAD: AbnormalUploadAlarm.prototype,
  ALARM_LARGE_UPLOAD_2: LargeUploadAlarm.prototype,
  ALARM_ABNORMAL_BANDWIDTH_USAGE: AbnormalBandwidthUsageAlarm.prototype,
  ALARM_OVER_DATA_PLAN_USAGE: OverDataPlanUsageAlarm.prototype,
  ALARM_NEW_DEVICE: NewDeviceAlarm.prototype,
  ALARM_DEVICE_BACK_ONLINE: DeviceBackOnlineAlarm.prototype,
  ALARM_DEVICE_OFFLINE: DeviceOfflineAlarm.prototype,
  ALARM_SPOOFING_DEVICE: SpoofingDeviceAlarm.prototype,
  ALARM_VPN_CLIENT_CONNECTION: VPNClientConnectionAlarm.prototype,
  ALARM_VPN_RESTORE: VPNRestoreAlarm.prototype,
  ALARM_VPN_DISCONNECT: VPNDisconnectAlarm.prototype,
  ALARM_BRO_NOTICE: BroNoticeAlarm.prototype,
  ALARM_INTEL: IntelAlarm.prototype,
  ALARM_VULNERABILITY: VulnerabilityAlarm.prototype,
  ALARM_INTEL_REPORT: IntelReportAlarm.prototype,
  ALARM_SUBNET: SubnetAlarm.prototype,
  ALARM_WEAK_PASSWORD: WeakPasswordAlarm.prototype,
  ALARM_OPENPORT: OpenPortAlarm.prototype,
  ALARM_UPNP: UpnpAlarm.prototype,
  ALARM_DUAL_WAN: DualWanAlarm.prototype,
  ALARM_SCREEN_TIME: ScreenTimeAlarm.prototype,
  ALARM_NETWORK_MONITOR_RTT: NetworkMonitorRTTAlarm.prototype,
  ALARM_NETWORK_MONITOR_LOSSRATE: NetworkMonitorLossrateAlarm.prototype,
  ALARM_CUSTOMIZED: CustomizedAlarm.prototype,
  ALARM_CUSTOMIZED_SECURITY: CustomizedSecurityAlarm.prototype
}

module.exports = {
  Alarm,
  OutboundAlarm,
  VideoAlarm,
  GameAlarm,
  PornAlarm,
  VpnAlarm,
  AbnormalUploadAlarm,
  LargeUploadAlarm,
  AbnormalBandwidthUsageAlarm,
  OverDataPlanUsageAlarm,
  NewDeviceAlarm,
  DeviceBackOnlineAlarm,
  DeviceOfflineAlarm,
  SpoofingDeviceAlarm,
  CustomizedAlarm,
  CustomizedSecurityAlarm,
  VPNClientConnectionAlarm,
  VPNRestoreAlarm,
  VPNDisconnectAlarm,
  BroNoticeAlarm,
  IntelAlarm,
  VulnerabilityAlarm,
  IntelReportAlarm,
  SubnetAlarm,
  WeakPasswordAlarm,
  OpenPortAlarm,
  UpnpAlarm,
  DualWanAlarm,
  ScreenTimeAlarm,
  NetworkMonitorRTTAlarm,
  NetworkMonitorLossrateAlarm,
  mapping: classMapping
}
