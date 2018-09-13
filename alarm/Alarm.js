'use strict';

let log = require('../net2/logger.js')(__filename, 'info');
let jsonfile = require('jsonfile');
let util = require('util');

// FIXME: this profile should be loaded from cloud
let profile = jsonfile.readFileSync(__dirname + "/destinationProfile.json");
let i18n = require('../util/i18n.js');

let uuid = require('uuid');

let extend = require('util')._extend;

// let moment = require('moment');

// Alarm structure
//   type (alarm type, each type has corresponding alarm template, one2one mapping)
//   device (each alarm should have a related device)
//   message (a summarized information about what happened, need support localization)
//   payloads (key-value pairs, used to populate message/investigation)
//   timestamp (when event occcured)

class Alarm {
  constructor(type, timestamp, device, info) {
    this.aid = 0;
    this.type = type;
    this.device = device;
//    this.payloads = payloads;
    this.alarmTimestamp = new Date() / 1000;
    this.timestamp = timestamp;
    this.notifType = `NOTIF_TITLE_${this.type}`; // default security
    if(info)
      extend(this, info);

    // check schema, minimal required key/value pairs in payloads
//    this.validate(type);


    return;
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
    return i18n.__(this.getI18NCategory(), this);
  }

  localizedNotification() {
    return i18n.__(this.getNotificationCategory(), this);
  }

  localizedInfo() {
    if(this.timestamp)
      //this.localizedRelativeTime = moment(parseFloat(this.timestamp) * 1000).fromNow();
      this.localizedRelativeTime = "%@"; // will be fullfilled @ ios side
    
    return i18n.__(this.getInfoCategory(), this);
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

    for(var key in keysToCompare) {
      let k = keysToCompare[key];
      if(alarm[k] && alarm2[k] && alarm[k] === alarm2[k]) {

      } else {
        return false;
      }
    }

    return true;
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

  keysToCompareForDedup() {
    return ["p.device.mac"];
  }
}

class DeviceOfflineAlarm extends Alarm {
  constructor(timestamp, device, info) {
    super("ALARM_DEVICE_OFFLINE", timestamp, device, info);
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

  getI18NCategory() {
    let category = this.type;

    const supportedNoticeTypes = ["Heartbleed::SSL_Heartbeat_Attack"];
    if(supportedNoticeTypes.includes(this["p.noticeType"])) {
      category = `${category}_${this["p.noticeType"]}`;
    }

    if("p.local_is_client" in this) {
      if(this["p.local_is_client"] === "1") {
        category = `${category}_OUTBOUND`;
      } else {
        category = `${category}_INBOUND`;
      }
    }

    if(this.result === "block" &&
    this.result_method === "auto") {
      category = `${category}_AUTOBLOCK`;
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
    
    if(this.result === "block" &&
    this.result_method === "auto") {
      if(this["p.source"] === 'firewalla_intel' && this["p.security.primaryReason"]) {
        if(this["p.local_is_client"] === "1") {
          return "FW_INTEL_AUTO_BLOCK_ALARM_INTEL_FROM_INSIDE";
        } else {
          return "FW_INTEL_AUTO_BLOCK_ALARM_INTEL_FROM_OUTSIDE";
        }
      } else {
        if (this["p.local_is_client"] === "1") {
          return "AUTO_BLOCK_ALARM_INTEL_FROM_INSIDE";
        } else {
          return "AUTO_BLOCK_ALARM_INTEL_FROM_OUTSIDE";
        }
      }
    } else {
      if(this["p.source"] === 'firewalla_intel' && this["p.security.primaryReason"]) {
        if(this["p.local_is_client"] === "1") {
          return "FW_INTEL_ALARM_INTEL_FROM_INSIDE";
        } else {
          return "FW_INTEL_ALARM_INTEL_FROM_OUTSIDE";
        }
      } else {
        if(this["p.local_is_client"] === "1") {
          return "ALARM_INTEL_FROM_INSIDE";
        } else {
          return "ALARM_INTEL_FROM_OUTSIDE";
        }
      }
    }
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
  // p
  //   destinationID
  //   destinationName
  //   destinationHostname

  constructor(type, timestamp, device, destinationID, info) {
    super(type, timestamp ,device, info);
    this["p.dest.id"] = destinationID;
    // if(profile[destinationID]) {
    //   extend(payloads, profile[destinationID]);
    // }
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
    let category = null
    
    if(this["p.local_is_client"] === "1") {
      category = "ALARM_LARGE_UPLOAD_TRIGGERED_FROM_INSIDE";
    } else {
      category = "ALARM_LARGE_UPLOAD_TRIGGERED_FROM_OUTSIDE";
    }

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
          log.error("Failed to parse country code file:", error, {})
        }
      }
    }

    return category
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
  ALARM_INTEL_REPORT: IntelReportAlarm.prototype
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
  mapping: classMapping
}
