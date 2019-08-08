'use strict';

const log = require('../net2/logger.js')(__filename, 'info');
const jsonfile = require('jsonfile');
const util = require('util');

const i18n = require('../util/i18n.js');
const fc = require('../net2/config.js');
const moment = require('moment');

// let moment = require('moment');

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
    if(alarm["p.local_is_client"] === "1") {
      return `${category}_OUTBOUND`;
    } else {
      return `${category}_INBOUND`;
    }
  }

  return category;
}

class Alarm {
  constructor(type, timestamp, device, info) {
    this.aid = 0;
    this.type = type;
    this.device = device;
    this.alarmTimestamp = new Date() / 1000;
    this.timestamp = timestamp;

    if (info) Object.assign(this, info);

//    this.validate(type);

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

  cloudAction() {
    const decision = this["p.cloud.decision"];
    switch(decision) {
      case "block": {
        if(!this["p.action.block"]) {
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
    return ["p.device.name", "p.device.id"];
  }



  // check schema, minimal required key/value pairs in payloads
  validate(type) {

    this.requiredKeys().forEach((v) => {
      if(!this[v]) {
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

    if(alarm.type !== alarm2.type)
      return false;

    for(var i in keysToCompare) {
      let k = keysToCompare[i];
      // using == to compromise numbers comparison
      if(alarm[k] && alarm2[k] && alarm[k] == alarm2[k]) {

      } else {
        return false;
      }
    }

    return true;
  }

  getExpirationTime() {
    return fc.getTimingConfig("alarm.cooldown") || 15 * 60; // 15 minutes
  }
};


class NewDeviceAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_NEW_DEVICE", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ["p.device.mac"];
  }
}

class DeviceBackOnlineAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_DEVICE_BACK_ONLINE", timestamp, device, info);
  }

  getManagementType() {
    return "info";
  }

  keysToCompareForDedup() {
    return ["p.device.mac"];
  }
}

class DeviceOfflineAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_DEVICE_OFFLINE", timestamp, device, info);
    if (info && info["p.device.lastSeen"]) {
      this['p.device.lastSeenTimezone'] = moment(info["p.device.lastSeen"]*1000).format('LT')
    }
  }

  getManagementType() {
    return "info";
  }

  keysToCompareForDedup() {
    return ["p.device.mac"];
  }
}

class SpoofingDeviceAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_SPOOFING_DEVICE", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ["p.device.mac", "p.device.name", "p.device.ip"]
  }
}

class VPNClientConnectionAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_VPN_CLIENT_CONNECTION", timestamp, device, info);
  }

  keysToCompareForDedup() {
    return ["p.dest.ip"];
  }

  requiredKeys() {
    return ["p.dest.ip"];
  }

  getExpirationTime() {
    // for vpn client connection activities, only generate one alarm every 4 hours.
    return fc.getTimingConfig("alarm.vpn_client_connection.cooldown") || 60 * 60 * 4;
  }
}

class VulnerabilityAlarm extends Alarm {
  constructor(timestamp, device, vulnerabilityID, info) {
    super("ALARM_VULNERABILITY", timestamp, device, info);
    this["p.vid"] = vulnerabilityID;
  }

  getI18NCategory() {
    return util.format("%s_%s", this.type, this["p.vid"]);
  }

  isDup(alarm) {
    if(!super.isDup(alarm))
      return false;

    if(alarm["p.vid"] === this["p.vid"]) {
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
    if(`NOTIF_${category}` === i18n.__(`NOTIF_${category}`)) {
      category = this.type;
    }
    
    return category;
  }
}

class IntelReportAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_INTEL_REPORT", timestamp, device, info);
  }
  
  getI18NCategory() {
    return "ALARM_INTEL_REPORT";

    if(Number(this["p.attempts"]) === 1) {
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
  }

  getI18NCategory() {
    this["p.dest.readableName"] = this.getReadableDestination()

    let category = "ALARM_INTEL";

    if("p.dest.url" in this) {
      category = "ALARM_URL_INTEL";
    }

    if (this["p.source"] === 'firewalla_intel' && this["p.security.primaryReason"])
      category = 'FW_INTEL_' + category;

    category = suffixDirection(this, category);
    category = suffixAutoBlock(this, category)
   
    return category;
  }
  
  getReadableDestination() {
    const name = this["p.dest.name"]
    const port = this["p.dest.port"]
    
    if( name && port) {
      if(port == 80) {
        return `http://${name}`
      } else if(port == 443) {
        return `https://${name}`
      } else {
        return `${name}:${port}`
      }
    } else {
      if(name) {
        return name
      } else {
        return this["p.dest.id"] 
      }
    }
  }

  keysToCompareForDedup() {
    return ["p.device.mac", "p.dest.name", "p.dest.port"];
  }
}

class OutboundAlarm extends Alarm {

  constructor(type, timestamp, device, destinationID, info) {
    super(type, timestamp ,device, info);
    this["p.dest.id"] = destinationID;
    if (info && info.timestamp) {
      this["p.timestampTimezone"] = moment(info.timestamp*1000).format('LT')
    }
  }

  requiredKeys() {
    return super.requiredKeys().concat(["p.dest.id"]);
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

  getSimpleOutboundTrafficSize() {
    return formatBytes(this["p.transfer.outbound.size"]);
  }

  keysToCompareForDedup() {
    return ["p.device.mac", "p.dest.id"];
  }

  isDup(alarm) {
    let alarm2 = this;
    
    if(alarm.type !== alarm2.type) {
      return false;
    }

    const macKey = "p.device.mac";
    const destDomainKey = "p.dest.domain";
    const destNameKey = "p.dest.id";
    
    // Mac
    if(!alarm[macKey] || 
    !alarm2[macKey] || 
    alarm[macKey] !== alarm2[macKey]) {
      return false;
    }

    // now these two alarms have same device MAC

    // Destination
    if(destDomainKey in alarm && 
      destDomainKey in alarm2 &&
      alarm[destDomainKey] === alarm2[destDomainKey]) {
      return true;
    }


    if(!alarm[destNameKey] || 
    !alarm2[destNameKey] || 
    alarm[destNameKey] !== alarm2[destNameKey]) {
      return false;
    }

    return true;
  }
}


class LargeTransferAlarm extends OutboundAlarm {
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
    
    if(this["p.dest.name"] === this["p.dest.ip"]) {
      if(this["p.dest.country"]) {
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

  getExpirationTime() {
    // for upload activity, only generate one alarm every 4 hours.
    return fc.getTimingConfig("alarm.large_upload.cooldown") || 60 * 60 * 4
  }

  // dedup implemented before generation @ FlowMonitor
  isDup(alarm) {
    return false;
  }
}

class VideoAlarm extends OutboundAlarm {
  constructor(timestamp, device, videoID, info) {
    super("ALARM_VIDEO", timestamp, device, videoID, info);
    this["p.showMap"] = false;
  }
}

class GameAlarm extends OutboundAlarm {
  constructor(timestamp, device, gameID, info) {
    super("ALARM_GAME", timestamp, device, gameID, info);
    this["p.showMap"] = false;
  }
}

class PornAlarm extends OutboundAlarm {
  constructor(timestamp, device, pornID, info) {
    super("ALARM_PORN", timestamp, device, pornID, info);
    this["p.showMap"] = false;
  }
}

class SubnetAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_SUBNET", timestamp, device, info);
    this["p.showMap"] = false;
  }

  getManagementType() {
    return "info";
  }

  keysToCompareForDedup() {
    return ["p.device.mac", "p.device.ip", "p.subnet.length"];
  }

  getExpirationTime() {
    return fc.getTimingConfig("alarm.subnet.cooldown") || 30 * 24 * 60 * 60;
  }
}

class UpnpAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super('ALARM_UPNP', timestamp, device, info);
    this['p.showMap'] = false;
  }

  keysToCompareForDedup() {
    return [
      'p.device.mac',
      'p.upnp.protocol',
      //'p.upnp.public.host', check header of UPNPSensor for details
      'p.upnp.public.port',
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
}

let classMapping = {
  ALARM_PORN: PornAlarm.prototype,
  ALARM_VIDEO: VideoAlarm.prototype,
  ALARM_GAME: GameAlarm.prototype,
  ALARM_LARGE_UPLOAD: LargeTransferAlarm.prototype,
  ALARM_NEW_DEVICE: NewDeviceAlarm.prototype,
  ALARM_DEVICE_BACK_ONLINE: DeviceBackOnlineAlarm.prototype,
  ALARM_DEVICE_OFFLINE: DeviceOfflineAlarm.prototype,
  ALARM_SPOOFING_DEVICE: SpoofingDeviceAlarm.prototype,
  ALARM_VPN_CLIENT_CONNECTION: VPNClientConnectionAlarm.prototype,
  ALARM_BRO_NOTICE: BroNoticeAlarm.prototype,
  ALARM_INTEL: IntelAlarm.prototype,
  ALARM_VULNERABILITY: VulnerabilityAlarm.prototype,
  ALARM_INTEL_REPORT: IntelReportAlarm.prototype,
  ALARM_SUBNET: SubnetAlarm.prototype,
  ALARM_UPNP: UpnpAlarm.prototype
}

module.exports = {
  Alarm: Alarm,
  OutboundAlarm: OutboundAlarm,
  VideoAlarm: VideoAlarm,
  GameAlarm: GameAlarm,
  PornAlarm: PornAlarm,
  LargeTransferAlarm: LargeTransferAlarm,
  NewDeviceAlarm: NewDeviceAlarm,
  DeviceBackOnlineAlarm: DeviceBackOnlineAlarm,
  DeviceOfflineAlarm: DeviceOfflineAlarm,
  SpoofingDeviceAlarm: SpoofingDeviceAlarm,
  VPNClientConnectionAlarm: VPNClientConnectionAlarm,
  BroNoticeAlarm: BroNoticeAlarm,
  IntelAlarm: IntelAlarm,
  VulnerabilityAlarm: VulnerabilityAlarm,
  IntelReportAlarm: IntelReportAlarm,
  SubnetAlarm: SubnetAlarm,
  UpnpAlarm: UpnpAlarm,
  mapping: classMapping
}
