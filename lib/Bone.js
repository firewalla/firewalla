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
'use strict';

const firewalla = require('../net2/Firewalla.js');
const log = require("../net2/logger.js")(__filename);

const config = require('../net2/config.js').getConfig();

// sometimes timeout could take 2 mins
const rp = require('request-promise').defaults({ timeout: 30000 });
const Constants = require('../net2/Constants.js');

// this will be overwritten by sys:bone:url or sys:bone:url:forced
let endpoint = firewalla.isProductionOrBeta() ?
  config.firewallaBoneServerURL || "https://firewalla.encipher.io/bone/api/v3" :
  config.firewallaBoneServerDevURL || "https://firewalla.encipher.io/bone/api/v0"

// force use nightly for dev
if (firewalla.isDevelopmentVersion()) {
  endpoint = config.firewallaBoneServerNightlyURL || "https://fwdev.encipher.io/bone/api/dv5";
}

const originalEndpoint = endpoint;

const licenseServer = config.firewallaLicenseServer || "https://firewalla.encipher.io/license/api/v1"

const features = require('../net2/features.js');

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const rateLimit = require('../extension/ratelimit/RateLimit.js');

const f = require('../net2/Firewalla.js');

const { rrWithErrHandling } = require('../util/requestWrapper.js')

let eid = null;
let gid = null;
let token = null;
let jwt = null;
let appConnected = false;
let sysept = null;

const util = require('util');
const os = require('os');

const boneAPITimeSeries = require('../util/TimeSeries.js').getBoneAPITimeSeries()
const Trace = require('../util/audit.js');
const _ = require('lodash');

rclient.hgetall("sys:ept", (err, data) => {
  if (data) {
    eid = data.eid;
    gid = data.gid;
    sysept = data;
    log.info("Cloud token is ready:", eid, gid);
  }
});

setInterval(() => {
  checkCloud(() => { });
}, 2000);

function publishJwt(jwt) {
  rclient.set("sys:bone:jwt", jwt, (err) => {
    if (err == null) {
      pclient.publish("comm:sys:bone:jwt", jwt);
    }
  });
}

function publishUrl(url) {
  rclient.set("sys:bone:url", url, (err) => {
    if (err == null) {
      pclient.publish("comm:sys:bone:url", url);
    }
  });
}

async function getBoxName() {
  try {
    const name = await firewalla.getBoxName();
    return name
  } catch (err) {
    log.error('Error getting box name', err)
  }
}

sclient.subscribe("comm:sys:bone:jwt");
sclient.subscribe("comm:sys:bone:url");

sclient.on("message", (channel, message) => {
  if (channel == "comm:sys:bone:jwt") {
    jwt = message;
  } else if (channel == "comm:sys:bone:url") {
    endpoint = message;
    log.info("Bone:sys:bone:url", channel, endpoint);
  }
});

rclient.get("sys:bone:url", (err, urldata) => {
  if (!err && urldata) {
    endpoint = urldata;
  }
  log.forceInfo("Firewalla Cloud URL is:", endpoint);
});

function getToken() {
  if (jwt) {
    return jwt;
  }
  return token;
}

function setToken(token) {
  if (token) {
    jwt = token;
  }
}

exports.getToken = getToken;
exports.setToken = setToken;

exports.setEndpoint = (ep) => {
  endpoint = ep;
}

function getEndpoint() {
  return endpoint;
}

async function checkCloud() {
  const data = await rclient.hgetallAsync("sys:ept")
  if (!data) {
    return null
  }
  eid = data.eid;
  gid = data.gid;
  token = data.token;
  sysept = data;

  let cnt = data.group_member_cnt;
  appConnected = (cnt && cnt > 1);
  const jwtdata = await rclient.getAsync("sys:bone:jwt")
  if (jwtdata) {
    jwt = jwtdata;
  }
  return data
}
exports.checkCloud = checkCloud

exports.isAppConnected = function () {
  return appConnected;
}

exports.cloudready = function () {
  if (token) {
    log.debug('CloudReady: true')
    return true;
  } else {
    checkCloud();
    log.debug('CloudReady: false')
    return false;
  }
}

function waitUntilCloudReady(done) {
  if (exports.cloudready()) {
    done();
  } else {
    setTimeout(() => {
      waitUntilCloudReady(done);
    }, 1000); // 1 second
  }
}

exports.getSysept = function () {
  if (sysept == null) {
    return null;
  }
  let data = JSON.parse(JSON.stringify(sysept));
  delete data.token;
  data.url = endpoint;
  return data;
};

exports.waitUntilCloudReady = waitUntilCloudReady;

exports.waitUntilCloudReadyAsync = util.promisify(waitUntilCloudReady);

exports.getLicenseAsync = async function (luid, mac) {
  luid = luid.trim();
  mac = mac.trim();

  let cpuid = platform.getBoardSerial() || "0";
  let options = {
    uri: licenseServer + '/license/issue/' + luid + "?mac=" + mac + "&serial=" + cpuid,
    family: 4,
    method: 'GET',
    auth: {
      bearer: token
    },
    maxAttempts: 15,  // try more times since getLicense is critical
    retryDelay: 1000,  // (default) wait for 1s before trying again
    json: true,
  };

  boneAPITimeSeries.recordHit('license').exec()

  const response = await rrWithErrHandling(options);

  if (response.body && response.body.license && response.body.status == 200)
    return response.body.license
  else
    throw new Error("Invalid License", response && response.body)
}

exports.getLicense = util.callbackify(exports.getLicenseAsync);

exports.checkinAsync = async function (boxVersion, license, info, useOriginalEndpoint = false) {
  log.info("Checking in...", eid, gid);
  log.debug("Bone:CheckingIn...", boxVersion, license, JSON.stringify(info));
  let obj = {
    uptime: process.uptime(),
    version: boxVersion,
    name: await getBoxName(),
    sys: JSON.stringify({
      'sysmem': os.freemem(),
      'loadavg': os.loadavg(),
      'uptime': os.uptime()
    }),
    redis: JSON.stringify({
      'memory': rclient.server_info.used_memory
    }),
    cpuid: platform.getBoardSerial() || "0",
    mac: info.mac,
    gid: gid,
    sysinfo: JSON.stringify(info),
    ip: info.publicIp,
  }

  const ddns = {};
  // read ddns update object from redis and set the new ddns, token and eid in ddns object accordingly
  const ddnsUpdate = await rclient.hgetallAsync(Constants.REDIS_KEY_DDNS_UPDATE);
  if (!_.isEmpty(ddnsUpdate) && ddnsUpdate.ddns && ddnsUpdate.ddnsToken && ddnsUpdate.fromEid) {
    ddns.ddns = ddnsUpdate.ddns;
    ddns.ddnsToken = ddnsUpdate.ddnsToken;
    ddns.fromEid = ddnsUpdate.fromEid;
  }
  const ddnsPolicy = await rclient.hgetAsync("policy:system", "ddns").then(result => JSON.parse(result) || {}).catch((err) => { return {} });
  const ddnsEnabled = ddnsPolicy.state !== false;
  if (!ddnsEnabled) {
    ddns.ip = "0.0.0.0";
  } else {
    const v4Enabled = ddnsPolicy.v4Enabled !== false;
    // publicIp in sysManager.getSysInfo returns public IPv4 address from the selected outgoing WAN
    if (!v4Enabled) {
      ddns.ip = "0.0.0.0";
    } else {
      if (info.hasOwnProperty("publicIp")) // if public IP cannot bet discovered on the selected WAN, unregister the old one
        ddns.ip = info.publicIp || "0.0.0.0";
      else {
        // publicWanIps in sysManager.getSysInfo returns connected public IPv4 address
        if (info.publicWanIps && info.publicWanIps.length > 0) {
          ddns.ip = info.ip && info.publicWanIps.includes(info.ip) ? info.ip : info.publicWanIps[0] // always register default WAN IP if it is a public IP
        }
      }
    }
    const v6Enabled = ddnsPolicy.v6Enabled !== false;
    if (v6Enabled) {
      // publicIp6s in sysManager.getSysInfo returns public IPv6 addresses from the selected outgoing WAN
      if (_.isArray(info.publicIp6s) && !_.isEmpty(info.publicIp6s)) {
        ddns.ipv6 = info.publicIp6s[0];
      }
    }
  }
  if (!_.isEmpty(ddns))
    obj.ddns = ddns;
  if (license) {
    obj.license = JSON.stringify(license);
  }

  log.info("Check-in URL: " + useOriginalEndpoint ? originalEndpoint : endpoint + '/sys/checkin'); // by using original endpoint for check-in, there is always a chance to fail back to production fishbone via check-in if the box was trapped in blackhole (v2)

  let options = {
    uri: useOriginalEndpoint ? originalEndpoint : endpoint + '/sys/checkin',
    family: 4,
    method: 'POST',
    auth: {
      bearer: token
    },
    json: obj,
    maxAttempts: 5,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
  };

  boneAPITimeSeries.recordHit('checkin').exec()

  const response = await rrWithErrHandling(options)

  const body = response.body
  if (body) {
    log.debug("==== Checkin ===",
      require('util').inspect(body, {
        depth: null
      }),
      body.needUpgrade);

    if (body.status == 302 && body.config && body.config.bone && body.config.bone.server) {
      if (endpoint != body.config.bone.server) {
        endpoint = body.config.bone.server;
        log.info("Redirecting to new server", body.config.bone.server);
        console.log("Redirecting to new server", body.config.bone.server);
        publishUrl(body.config.bone.server);
        return exports.checkinAsync(boxVersion, license, info);
      } else {
        log.warn("Check in: 302 on same endpoint", endpoint)
      }
    }
    if (body.jwt) {
      jwt = body.jwt;
      publishJwt(jwt);
      publishUrl(endpoint);
    } else {
      rclient.del("sys:bone:jwt", () => { });
    }
  }

  return body
}

exports.checkin = util.callbackify(exports.checkinAsync);


/*
 * send in device characteristics and get something back
 *
 * need to implement cache here
 */

exports.deviceAsync = async function (cmd, obj) {
  log.info("sending POST request: /device/" + cmd);
  log.debug(obj)
  let options = {
    uri: getEndpoint() + '/device/' + cmd,
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    maxAttempts: 1,
    json: obj,
  };

  boneAPITimeSeries.recordHit('device').exec()

  const response = await rrWithErrHandling(options)

  log.info("==== Device ===", response.body);
  return response.body;
}

exports.device = util.callbackify(exports.deviceAsync);

exports.logAsync = async function (cmd, obj) {
  try {
    Trace(cmd, obj);
  } catch (e) { }

  if (!exports.cloudready()) {
    log.warn('Cloud not ready, skip');
    return;
  }

  log.debug("/device/log/" + cmd, obj);

  try {
    const options = {
      uri: getEndpoint() + '/device/log/' + cmd,
      family: 4,
      method: 'POST',
      auth: {
        bearer: getToken()
      },
      json: Object.assign({
        version: config.version,
        hash: firewalla.getLatestCommitHash(),
        branch: firewalla.getBranch(),
        model: platform.getName(),
        name: await getBoxName()
      }, obj)
    };

    boneAPITimeSeries.recordHit('log').exec()

    const body = await rp(options);
    if (body) {
      log.info("==== Log ===", body);
    }

    return body
  } catch (err) {
    // prevents triggering bone.log() again on failure
    log.error("Error sending bone log", err.message)
  }
}

exports.log = util.callbackify(exports.logAsync);



// action: block, unblock, check
// check: { threat: 0->100, class: video/porn/... }
//

exports.intelAsync = async function (ip, action, intel) {
  log.debug("/intel/host/" + ip + "/" + action);
  let options = {
    uri: getEndpoint() + '/intel/host/' + ip + '/' + action,
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    json: intel,
    timeout: 10000, // 10 seconds
    maxAttempts: 1,
  };

  boneAPITimeSeries.recordHit('intel').exec()

  const response = await rrWithErrHandling(options, true);

  if (f.isMain() && response && response.headers) {
    rateLimit.recordRate(response.headers);
  }

  return response.body
}

exports.intel = util.callbackify(exports.intelAsync);

// flowgraph
// input computed summary
// output filtered list that expresses the real activity of the user
// obj:
//   [{id:something, graph:{activity,appr}...]
//   return same structure with things that are noise removed
//
// action:
//   clean: older API to clean up the flows
//   summarizeApp: (new api) massage flows
//   summarizeActivity: (new api) massage flows
//

exports.flowgraphAsync = async function (action, obj) {
  let options = {
    uri: getEndpoint() + '/flowgraph/' + action,
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    timeout: 10000, // 10 seconds
    maxAttempts: 1,
    json: obj,
  };

  boneAPITimeSeries.recordHit('flowgraph').exec()

  const response = await rrWithErrHandling(options);
  return response.body
}

exports.flowgraph = util.callbackify(exports.flowgraphAsync);

exports.hashsetAsync = async function (hashsetid) {
  log.info("/hashset/" + hashsetid);
  let options = {
    uri: getEndpoint() + '/intel/hashset/' + hashsetid,
    family: 4,
    method: 'GET',
    auth: {
      bearer: getToken()
    },
    maxAttempts: 5,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
  };

  boneAPITimeSeries.recordHit('hashset').exec()

  const response = await rrWithErrHandling(options);

  return response.body;
}

exports.getServiceConfigAsync = async function () {

  log.info("Loading service config from cloud");
  let url = getEndpoint() + '/service/config';
  let options = {
    uri: url,
    family: 4,
    method: 'GET',
    auth: {
      bearer: getToken()
    },
    maxAttempts: 5,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
    json: true
  };

  boneAPITimeSeries.recordHit('getServiceConfig').exec()

  const response = await rrWithErrHandling(options)

  return response.body
}

exports.getServiceConfig = util.callbackify(exports.getServiceConfigAsync);

const flowUtil = require('../net2/FlowUtil');

const intelFeedback = async function (feedback) {
  let options = {
    uri: getEndpoint() + '/intel/feedback/',
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    json: feedback,
    timeout: 10000, // 10 seconds
    maxAttempts: 5,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
  };
  log.info(options.uri, feedback);

  boneAPITimeSeries.recordHit('intelFeedback').exec()

  try {
    await rrWithErrHandling(options)
  } catch (err) {
    log.error(err)
  }
}

/*
{
  "if.type": "domain",
  "reason": "ALARM_GAME",
  "type": "ALARM_GAME",
  "timestamp": "1500913117.175",
  "p.dest.id": "battle.net",
  "target_name": "battle.net",
  "target_ip": destIP,
}*/
exports.submitIntelFeedback = async function (action, intel) {

  if (!features.isOn("intel:feedback")) {
    log.info("Intel feedback feature is off");
    return;
  }

  log.info("Intel for feedback:", action, "=>", intel);

  if (!intel) {
    log.warn('Invalid intel: null');
    return;
  }

  let type = intel['if.type'] || intel['type'];
  let target = intel['if.target'] || intel['target'];

  if (!['dns', 'ip', 'mac', 'net',
    'category', 'country', 'devicePort',
    'remotePort', 'remoteIpPort', 'remoteNetPort',
    "deviceAppPort", "devicePort", "deviceAllPorts"
  ].includes(type)) {
    log.warn('invalid action type: ' + type);
    return;
  }

  if (!target) {
    log.error('Invalid action target: ' + target);
    return;
  }

  let feedback = {
    feedbacks: [{
      'if.action': action,
      'if.type': type
    }]
  };

  log.info("Action:", action, "Type:", type, ", Original value:", target);

  let _target = null;
  switch (type) {
    case 'dns':
      _target = flowUtil.hashHost(target);
      feedback.feedbacks[0]['if.target'] = _target;
      feedback.feedbacks[0]['if._target'] = target;
      await intelFeedback(feedback)
      break;
    case 'ip':
      _target = flowUtil.hashIp(target);
      feedback.feedbacks[0]['if.target'] = _target;
      feedback.feedbacks[0]['if._target'] = target;
      await intelFeedback(feedback)
      break;
    default:
  }
}

exports.intelAdvice = async (advice) => {
  log.debug("Intel advice:", advice);

  const options = {
    uri: getEndpoint() + '/intel/advice',
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    json: advice,
    timeout: 10000, // 10 seconds
    maxAttempts: 2,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
  };

  boneAPITimeSeries.recordHit('intelAdvice').exec()

  try {
    await rrWithErrHandling(options)
  } catch (err) {
    log.error(err)
  }

}

exports.intelFinger = async (target) => {
  log.info(`/intel/finger/${target}`);
  let options = {
    uri: getEndpoint() + '/intel/finger/' + target,
    family: 4,
    method: 'GET',
    auth: {
      bearer: getToken()
    },
    timeout: 10000, // ms
    maxAttempts: 1,
    json: true,
  };

  const response = await rrWithErrHandling(options)

  return response.body;
}

exports.arbitration = async (alarm) => {
  log.info("Verifying alarm in cloud:", alarm.type, alarm["p.device.ip"], alarm["p.dest.ip"]);

  const options = {
    uri: getEndpoint() + '/finger/arbitration',
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    timeout: 10000, // ms
    maxAttempts: 1,
    json: alarm
  }

  try {
    const response = await rrWithErrHandling(options)

    if (response.statusCode != 200) {
      alarm["p.cloud.error"] = "" + response.statusCode;
      return alarm
    }

    return Object.assign({}, alarm, response.body)

  } catch (err) {
    log.error(`Got error when calling alarm decision: ${err}`);
    alarm["p.cloud.error"] = "unknown";
    return alarm
  }
}

exports.cloudActionCallback = async (payload) => {
  log.info("cloud action feedback:", payload);

  const options = {
    uri: getEndpoint() + '/cloud/actionCallback',
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    timeout: 10000, // ms
    maxAttempts: 1,
    json: payload
  }

  const response = await rrWithErrHandling(options)
  return response.body
}

exports.checkTargetSetMembership = async (payload) => {
  const options = {
    uri: getEndpoint() + '/intel/checkmember',
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    timeout: 10000, // ms
    maxAttempts: 1,
    json: payload
  };

  const response = await rrWithErrHandling(options);
  return response.body;
};
