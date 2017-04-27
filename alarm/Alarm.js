'use strict';

let log = require('../net2/logger.js')(__filename, 'info');
let jsonfile = require('jsonfile');
let util = require('util');

// FIXME: this profile should be loaded from cloud
let profile = jsonfile.readFileSync(__dirname + "/destinationProfile.json");
let i18n = require('i18n');

var uuid = require('uuid');

// Alarm structure
//   type (alarm type, each type has corresponding alarm template, one2one mapping)
//   device (each alarm should have a related device)
//   message (a summarized information about what happened, need support localization)
//   payloads (key-value pairs, used to populate message/investigation)
//   timestamp (when event occcured)

class Alarm {
  constructor(type, timestamp, device, payloads) {
    this.aid = 0;
    this.type = type;
    this.device = device;
    this.payloads = payloads;
    this.alarmTimestamp = new Date() / 1000;
    this.timestamp = timestamp;

    // check schema, minimal required key/value pairs in payloads
    this.validate(type, payloads);

    return;
  }

  localizedMessage() {
    return i18n.__(this.type, this.payloads);
  }

  toString() {
    return util.inspect(this);
  }

  requiredKeys() {
    return [];
  }

  // check schema, minimal required key/value pairs in payloads
  validate(type, payloads) {
    
    this.requiredKeys().forEach((v) => {
      if(!payloads[v]) {
        log.error("Invalid payload for " + this.type + ": " + util.inspect(payloads) + ", missing " + v);
        throw new Error("Invalid alarm payload");
      }
    });

    return true;
  }
};

var extend = require('util')._extend

class OutboundAlarm extends Alarm {
  // payloads
  //   destinationID
  //   destinationName
  //   destinationHostname
  
  constructor(type, timestamp, device, destinationID, payloads) {
    payloads.destinationID = destinationID;
    if(profile[destinationID]) {
      extend(payloads, profile[destinationID]);
    }
    super(type, timestamp ,device, payloads);
  }

  requiredKeys() {
    return super.requiredKeys().concat(["destinationID"]);
  }

  getDestinationHostname() {
    return this.payloads.destinationHostname;
  }

  setDestinationHostname(hostname) {
    this.payloads.destinationHostname = hostname;
  }

  getDestinationName() {
    return this.payloads.destinationName;
  }

  setDestinationName(name) {
    this.payloads.destinationName = name;
  }

  setDestinationIPAddress(ip) {
    this.payloads.destinationIPAddress = ip;
  }

  getDestinationIPAddress() {
    return this.payloads.destinationIPAddress;
  }
}

class VideoAlarm extends OutboundAlarm {
  constructor(timestamp, device, videoID, payloads) {
    super("ALARM_VIDEO", timestamp, device, videoID, payloads);
  }

  requiredKeys() {
    return super.requiredKeys().concat(["device_name"]);
  }
}

class GameAlarm extends OutboundAlarm {
  constructor(timestamp, device, gameID, payloads) {
    super("ALARM_GAME", timestamp, device, gameID, payloads);
  }
}

class PornAlarm extends OutboundAlarm {
  constructor(timestamp, device, pornID, payloads) {
    super("ALARM_PORN", timestamp, device, pornID, payloads);
  }
}

module.exports = {
  Alarm: Alarm,
  OutboundAlarm: OutboundAlarm,
  VideoAlarm: VideoAlarm,
  GameAlarm: GameAlarm,
  PornAlarm: PornAlarm
}
