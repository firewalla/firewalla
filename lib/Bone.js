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

const firewalla = require('../net2/Firewalla.js');
const log = require("../net2/logger.js")(__filename);

let config = require('../net2/config.js').getConfig();

const rp = require('request-promise');
const rr = require('requestretry')
const request = require('request')
// let domainCategory = require('../util/DomainCategory');

let endpoint = config.firewallaBoneServerURL || "https://firewalla.encipher.io/bone/api/v3"
if (firewalla.isProductionOrBeta() == false) {
  endpoint = config.firewallaBoneServerDevURL|| "https://firewalla.encipher.io/bone/api/v0"
}

let lastendpoint = null;
let licenseServer = config.firewallaLicenseServer || "https://firewalla.encipher.io/license/api/v1"
//let endpoint = "http://firewalla-dev.encipher.io:6001/bone/api/v2"

let features = require('../net2/features.js');

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const rateLimit = require('../extension/ratelimit/RateLimit.js');

const f = require('../net2/Firewalla.js');

let eid = null;
let gid = null;
let gcount = 0;
let token = null;
let jwt = null;
let checkedin = false;
let os = require('os');

let utils = require('../lib/utils.js');

let appConnected = false;

const util = require('util');

let sysept = null;

const boneAPITimeSeries = require('../util/TimeSeries.js').getBoneAPITimeSeries()

rclient.hgetall("sys:ept", (err, data) => {
  if (data) {
    eid = data.eid;
    gid = data.gid; 
    sysept = data;
    log.info("Cloud token is ready:",eid,gid);
  }
});

setInterval(() => {
  checkCloud(() => {});
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
    const name = await rclient.getAsync('groupName');
    return name
  } catch(err) {
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
    log.info("Bone:sys:bone:url",channel,endpoint);
  }
});

rclient.get("sys:bone:url", (err, urldata) => {
  if (urldata) {
    lastendpoint = urldata;
  }
  log.forceInfo("Firewalla Cloud URL is:", endpoint);
//  log.info("Bone:sys:bone:url:get",urldata,lastendpoint,endpoint);
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

function fallback() {
  return; // TODO, not fully support yet
  
  lastendpoint = endpoint;
  endpoint = config.firewallaBoneFallbackServerURL || "https://firewalla.encipher.io/bone/api/v3";
  log.warn(`Cloud url falls back to ${endpoint}`);
}

exports.getToken = getToken;
exports.setToken = setToken;

exports.setEndpoint = (ep) => {
  lastendpoint = ep;
  endpoint = ep;
}

function getEndpoint() {
  if (checkedin == false) {
    if (lastendpoint) {
      return lastendpoint;
    }
  }
  return endpoint;
}

function checkCloud(callback) {
  rclient.hgetall("sys:ept", (err, data) => {
    if (data) {
      eid = data.eid;
      gid = data.gid;
      token = data.token;
      sysept = data;

      let cnt = data.group_member_cnt;
      appConnected = (cnt && cnt > 1);
      rclient.get("sys:bone:jwt", (err, jwtdata) => {
        if (jwtdata) {
          jwt = jwtdata;
        }
        callback(data);
      });
    } else {
      callback(null);
    }
  });
}

exports.isAppConnected = function() {
  return appConnected;
}

exports.cloudready = function() {
  if (token) {
    return true;
  } else {
    checkCloud((token) => {});
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

exports.getSysept = function() {
   if (sysept==null) {
      return null;
   }
   let data = JSON.parse(JSON.stringify(sysept));
   delete data.token;
   data.url = endpoint;
   return data;
};

exports.waitUntilCloudReady = waitUntilCloudReady;

exports.waitUntilCloudReadyAsync = util.promisify(waitUntilCloudReady);

exports.getLicense = function(luid, mac, callback) {
  luid = luid.trim();
  mac = mac.trim();
  
  let cpuid = platform.getBoardSerial() || "0";
  let options = {
    uri: licenseServer + '/license/issue/' + luid + "?mac=" + mac+"&serial="+cpuid,
    family: 4,
    method: 'GET',
    auth: {
      bearer: token
    },
    maxAttempts: 15,  // try more times since getLicense is critical
    retryDelay: 1000,  // (default) wait for 1s before trying again
  };

  boneAPITimeSeries.recordHit('license').exec()

  rr(options, (err, httpResponse, body) => {
    if (err != null) {
      let stack = new Error().stack;
      log.info("Error while requesting getLicense", err, stack);
      if (callback)
        callback(err, null, null);
      return;
    }
    if (httpResponse == null) {
      let stack = new Error().stack;
      log.info("Error while response getLicense", err, stack);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      log.error("**** Error while response HTTP getLicense", httpResponse.statusCode);
      if (callback)
        callback(httpResponse.statusCode, null, null);
      return;
    }
    let obj = null;
    if (err === null && body != null) {
      let jsonObj = null;
      try {
        jsonObj = JSON.parse(body);
      } catch(err) {
        callback(new Error("Invalid License"), null);
        return;
      }

      if(jsonObj.status === "200" && jsonObj.license) {
        obj = jsonObj.license;
      }
    }
    if (callback) {
      callback(err, obj);
    }
  });
}

exports.getLicenseAsync = util.promisify(exports.getLicense);

exports.checkinAsync = async function(config, license, info) {
  log.info("Checking in...",eid,gid);
  log.debug("Bone:CheckingIn...",config,license,JSON.stringify(info));
  let obj = {
    uptime: process.uptime(),
    version: config.version,
    name: await getBoxName(),
    sys: JSON.stringify({
      'sysmem': os.freemem(),
      'detailsysmem': info.memory,
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
  if (license) {
    obj.license = JSON.stringify(license);
  }

  log.info("Check-in URL: " + endpoint + '/sys/checkin');

  let options = {
    uri: endpoint + '/sys/checkin',
    family: 4,
    method: 'POST',
    auth: {
      bearer: token
    },
    json: obj,
    maxAttempts: 5,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
    fullResponse: false
  };

  boneAPITimeSeries.recordHit('checkin').exec()

  const body = await rr(options)

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
        checkedin = false;
        lastendpoint = endpoint;
        return exports.checkinAsync(config, license, info);
      }
    }
    if (body.jwt) {
      jwt = body.jwt;
      publishJwt(jwt);
      publishUrl(endpoint);
    } else {
      rclient.del("sys:bone:jwt", (err, jwtdata) => {
      });
    }
    lastendpoint = endpoint;
    checkedin = true;
  }

  return body
}

exports.checkin = util.callbackify(exports.checkinAsync);


/*
 * send in device characteristics and get something back
 *
 * need to implement cache here
 */

exports.device = function(cmd, obj, callback) {
  //log.info("/device/" + cmd, obj);
  log.info("sending POST request: /device/" + cmd);
  let options = {
    uri: getEndpoint() + '/device/' + cmd,
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    json: obj
  };

  boneAPITimeSeries.recordHit('device').exec()

  request(options, (err, httpResponse, body) => {
    if (err != null) {
      let stack = new Error().stack;
      log.info("Error while requesting device", err, stack,JSON.stringify(options));
      if (callback)
        callback(err, null, null);
      return;
    }
    if (httpResponse == null) {
      let stack = new Error().stack;
      log.info("Error while response device", err, stack);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      let stack = new Error().stack;
      log.error("**** Error while response HTTP device", httpResponse.statusCode,stack,JSON.stringify(options));
      if (callback)
        callback(httpResponse.statusCode, null, null);
      return;
    }
    let obj = null;
    if (err === null && body != null) {
      log.info("==== Device ===", body);
      obj = body;
    }
    if (callback) {
      callback(err, obj);
    }
  });
}

exports.logAsync = async function(cmd, obj) {
  log.info("/device/log/" + cmd, obj);
  
  let options = {
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
      name: await getBoxName()
    }, obj)
  };

  boneAPITimeSeries.recordHit('log').exec()

  const body = await rp(options);
  if (body) {
    log.info("==== Log ===", body);
  }

  return body
}

exports.log = util.callbackify(exports.logAsync);



// action: block, unblock, check
// check: { threat: 0->100, class: video/porn/... }
//

exports.intel = function(ip, type, action, intel, callback) {
  log.debug("/intel/host/" + ip + "/" + action);
  let options = {
    uri: getEndpoint() + '/intel/host/' + ip + '/' + action,
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    json: intel,
    timeout: 10000 // 10 seconds
  };

  boneAPITimeSeries.recordHit('intel').exec()

  request(options, (err, httpResponse, body) => {
    if(f.isMain() && httpResponse && httpResponse.headers) {
      rateLimit.recordRate(httpResponse.headers);
    }

    if (err) {
      log.error("Error while requesting intel:", body, err, err.stack);
      fallback();
      if (callback)
        callback(err, null, null);
      return;
    }
    if (!httpResponse) {
      let stack = new Error().stack;
      log.error("Error while response intel:", err, err.stack);
      log.info(body);
      fallback();
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      log.error("**** Error while response HTTP intel:", httpResponse.statusCode, body);
      fallback();
      if (callback)
        callback(httpResponse.statusCode, null, null);
      return;
    }
    let obj = null;
    if (!err && body) {
      obj = body;
    }
    if (callback) {
      callback(err, obj);
    }
  });
}

exports.intelAsync = util.promisify(exports.intel);

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

exports.flowgraph = function(action, obj, callback) {
  let options = {
    uri: getEndpoint() + '/flowgraph/' + action,
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    timeout: 10000, // 10 seconds
    json: obj
  };

  boneAPITimeSeries.recordHit('flowgraph').exec()

  request(options, (err, httpResponse, body) => {
    if (err != null) {
      let stack = new Error().stack;
      log.info("Error while requesting flowgraph", err, stack);
      if (callback)
        callback(err, null, null);
      return;
    }
    if (httpResponse == null) {
      let stack = new Error().stack;
      log.info("Error while response flowgraph", err, stack);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      log.error("**** Error while response HTTP flowgraph", httpResponse.statusCode);
      if (callback)
        callback(httpResponse.statusCode, null, null);
      return;
    }
    let obj = null;
    if (err === null && body != null) {
      obj = body;
    }
    if (callback) {
      callback(err, obj);
    }
  });
}

exports.flowgraphAsync = util.promisify(exports.flowgraph)

exports.hashset = function(hashsetid, callback) {
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

  rr(options, (err, httpResponse, body) => {
    if (err != null) {
      let stack = new Error().stack;
      log.info("Error while requesting hashset", err, stack);
      if (callback)
        callback(err, null, null);
      return;
    }
    if (httpResponse == null) {
      let stack = new Error().stack;
      log.info("Error while response hashset", err, stack);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      log.error("**** Error while response HTTP hashset", httpResponse.statusCode);
      if (callback)
        callback(httpResponse.statusCode, null, null);
      return;
    }
    let obj = null;
    if (err === null && body != null) {
      obj = body;
    }
    if (callback) {
      callback(err, obj);
    }
  });
}

exports.hashsetAsync = util.promisify(exports.hashset)

function errorHandling(url, err, httpResponse) {
  if (err || !httpResponse) {
    log.error("Error while requesting", url, "Error:", err);
    return err || 500;
  }

  if (httpResponse.statusCode < 200 ||
    httpResponse.statusCode > 299) {
    log.error("Error while requesting", url, "Error:", httpResponse.statusCode);
    return httpResponse.statusCode;
  }

  return null;
}

exports.getServiceConfig = function(callback) {
  callback = callback || function() {};

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
  };

  boneAPITimeSeries.recordHit('getServiceConfig').exec()

  rr(options, (err, httpResponse, body) => {
    let errResult = errorHandling(url, err, httpResponse);

    if (errResult) {
      callback(errResult);
      return;
    }

    if (body) {
      let obj = null;
      try {
        obj = JSON.parse(body);
      } catch (err) {
        callback(err);
        return;
      }
      callback(null, obj);
    }
  });
};


const flowUtil = require('../net2/FlowUtil');

let intelFeedback = function(feedback, callback) {
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

  request(options, (err, res, body) => {
    if (err) {
      let stack = new Error().stack;
      log.error("Error while requesting intelFeedback", err, stack);
      log.info(body);
      if (callback)
        callback(err, null, null);
      return;
    }
    if (!res) {
      let stack = new Error().stack;
      log.error("Error while response intelFeedback", err, stack);
      log.info(body);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (res.statusCode < 200 ||
      res.statusCode > 299) {
      log.error("**** Error while response HTTP intelFeedback", res.statusCode);
      log.info(body);
      if (callback)
        callback(res.statusCode, null, null);
      return;
    }
    let obj = null;
    if (!err && body) {
      obj = body;
    }
    if (callback) {
      callback(err, obj);
    }
  });
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
exports.submitIntelFeedback = function (action, intel, data_type) {

  data_type = data_type || "alarm" // by default use alarm

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
    'remotePort', 'remoteIpPort', 'remoteNetPort'
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

  let __submitIntelFeedback = (categories) => {
    log.info("Categories: ", categories);

    if (categories) {
      feedback.feedbacks[0]['if.category'] = categories;
    }

    log.info("Submit Feedback:", feedback);

    intelFeedback(feedback, (err) => {
      if (err) {
        log.error("Submit intel feedback w/ error: ", err);
      } else {
        log.info("Submit intel feedback successfully");
      }
    });
  };

  log.info("Action:", action, "Type:", type, ", Original value:", target);

  let _target = null;
  switch (type) {
    case 'dns':
      _target = flowUtil.hashHost(target);
      feedback.feedbacks[0]['if.target'] = _target;
      feedback.feedbacks[0]['if._target'] = target;
      __submitIntelFeedback(null);
      break;
    case 'ip':
      _target = flowUtil.hashIp(target);
      feedback.feedbacks[0]['if.target'] = _target;
      feedback.feedbacks[0]['if._target'] = target;
      __submitIntelFeedback(null);
      break;
    default:
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
  };

  let body, result;
  try {
    body = await rp(options);
  } catch (err) {
    log.error("Error while requesting intel finger", options.uri, err.code, err.message, err.stack);
    return;
  }

  try {
    log.info("finger body:", body);
    result = JSON.parse(body);
  } catch (err) {
    log.error("Error when parsing body to json:", body);
  }
  return result;
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
    json: alarm
  }

  return rp(options).then((body) => {
    return Object.assign({}, alarm, body); // merge two together
  }).catch((err) => {
    log.error(`Got error when calling alarm decision: ${err}`);
    if(err.statusCode) {
      alarm["p.cloud.error"] = "" + err.statusCode;
    } else {
      alarm["p.cloud.error"] = "unknown"; 
    }
    
    return alarm;
  });
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
    json: payload
  }

  return rp(options).catch((err) => {
    log.error(`Got error when calling cloud action decison: ${err}`);
    return null;
  });
}
