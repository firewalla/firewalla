'use strict';

let log = require('../net2/logger.js')(__filename, 'info');
let jsonfile = require('jsonfile');
let util = require('util');

// FIXME: this profile should be loaded from cloud
let profile = jsonfile.readFileSync(__dirname + "/destinationProfile.json");
let i18n = require('../util/i18n.js');

var uuid = require('uuid');

var extend = require('util')._extend



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
    if(info)
      extend(this, info);

    // check schema, minimal required key/value pairs in payloads
//    this.validate(type);
    

    return;
  }

  getI18NCategory() {
    return this.type;
  }
  
  localizedMessage() {
    return i18n.__(this.getI18NCategory(), this.toJsonObject());
  }

  toString() {
    return util.inspect(this);
  }

  toJsonObject() {
    let obj = {};
    for(var p in this) {
      obj[p] = this[p];
    }
    return obj;
  }

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
};


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
}

class LargeTransferAlarm extends OutboundAlarm {
  constructor(timestamp, device, destID, info) {
    super("ALARM_LARGE_UPLOAD", timestamp, device, destID, info);
  }

  getI18NCategory() {
    if(this["p.local_is_client"] === 1) {
      return "ALARM_LARGE_UPLOAD_TRIGGERED_FROM_INSIDE";
    } else {
      return "ALARM_LARGE_UPLOAD_TRIGGERED_FROM_OUTSIDE";
    }
  }
}

class VideoAlarm extends OutboundAlarm {
  constructor(timestamp, device, videoID, info) {
    super("ALARM_VIDEO", timestamp, device, videoID, info);
  }
}

class GameAlarm extends OutboundAlarm {
  constructor(timestamp, device, gameID, info) {
    super("ALARM_GAME", timestamp, device, gameID, info);
  }
}

class PornAlarm extends OutboundAlarm {
  constructor(timestamp, device, pornID, info) {
    super("ALARM_PORN", timestamp, device, pornID, info);
  }
}

let classMapping = {
  ALARM_PORN: PornAlarm.prototype,
  ALARM_VIDEO: VideoAlarm.prototype,
  ALARM_GAME: GameAlarm.prototype,
  ALARM_LARGE_UPLOAD: LargeTransferAlarm.prototype
}

module.exports = {
  Alarm: Alarm,
  OutboundAlarm: OutboundAlarm,
  VideoAlarm: VideoAlarm,
  GameAlarm: GameAlarm,
  PornAlarm: PornAlarm,
  LargeTransferAlarm: LargeTransferAlarm,
  mapping: classMapping
}
