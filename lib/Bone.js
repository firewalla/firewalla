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

let firewalla = require('../net2/Firewalla.js');
let log = require("../net2/logger.js")(__filename);

let config = require('../net2/config.js').getConfig();

const rr = require('requestretry')
const request = require('request')
let domainCategory = require('../util/DomainCategory');

let endpoint = config.firewallaBoneServerURL || "https://firewalla.encipher.io/bone/api/v3"
if (firewalla.isProductionOrBeta() == false) {
  endpoint = config.firewallaBoneServerDevURL|| "https://firewalla.encipher.io/bone/api/v0"
}

let lastendpoint = null;
let licenseServer = config.firewallaLicenseServer || "https://firewalla.encipher.io/license/api/v1"
//let endpoint = "http://firewalla-dev.encipher.io:6001/bone/api/v2"

let features = require('../net2/features.js');

let redis = require("redis");
let rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);

let eid = null;
let gid = null;
let gcount = 0;
let token = null;
let jwt = null;
let checkedin = false;
let os = require('os');

let utils = require('../lib/utils.js');

let appConnected = false;

let Promise = require('bluebird');

let sysept = null;

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
      rclient.publish("comm:sys:bone:jwt", jwt);
    }
  });
}

function publishUrl(url) {
  rclient.set("sys:bone:url", url, (err) => {
    if (err == null) {
      rclient.publish("comm:sys:bone:url", url);
    }
  });
}

sclient.subscribe("comm:sys:bone:jwt");
sclient.subscribe("comm:sys:bone:url");

sclient.on("message", (channel, message) => {
  if (channel == "comm:sys:bone:jwt") {
    jwt = message;
  } else if (channel == "comm:sys:bone:url") {
    endpoint = message;
  }
  log.info("Bone:sys:bone:url",channel,endpoint);
});

rclient.get("sys:bone:url", (err, urldata) => {
  if (urldata) {
    lastendpoint = urldata;
  }
  log.info("Firewalla Cloud URL is:", endpoint);
//  log.info("Bone:sys:bone:url:get",urldata,lastendpoint,endpoint);
});

function getToken() {
  if (jwt) {
    return jwt;
  }
  return token;
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

function waitUtilCloudReady(done) {
  if (exports.cloudready()) {
    done();
  } else {
    setTimeout(() => {
      waitUtilCloudReady(done);
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

exports.waitUtilCloudReady = waitUtilCloudReady;

exports.waitUntilCloudReadyAsync = () => {
  return new Promise((resolve) => {
    waitUtilCloudReady(() => {
      resolve();
    })
  })
};

exports.checkinAsync = function(config, license, info) {
  return new Promise((resolve, reject) => {
    exports.checkin(config, license, info, (err, obj) => {
      if (err) {
        reject(err);
      } else {
        resolve(obj);
      }
    })
  });
}

exports.getLicenseAsync = function(luid, mac) {
  return new Promise((resolve, reject) => {
    exports.getLicense(luid, mac, (err, obj) => {
      if (err)
        reject(err);
      else
        resolve(obj);
    })
  });
}

exports.getLicense = function(luid, mac, callback) {
  luid = luid.trim();
  mac = mac.trim();
  let cpuid = utils.getCpuId() || "0";
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
  log.info(options, {});

  rr(options, (err, httpResponse, body) => {
    if (err != null) {
      let stack = new Error().stack;
      log.info("Error while requesting ", err, stack);
      if (callback)
        callback(err, null, null);
      return;
    }
    if (httpResponse == null) {
      let stack = new Error().stack;
      log.info("Error while response ", err, stack);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      log.error("**** Error while response HTTP ", httpResponse.statusCode);
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

exports.checkin = function(config, license, info, callback) {
  log.info("Checking in...",eid,gid);
  log.debug("Bone:CheckingIn...",config,license,JSON.stringify(info));
  let obj = {
    uptime: process.uptime(),
    version: config.version,
    sys: JSON.stringify({
      'sysmem': os.freemem(),
      'detailsysmem': info.memory,
      'loadavg': os.loadavg(),
      'uptime': os.uptime()
    }),
    redis: JSON.stringify({
      'memory': rclient.server_info.used_memory
    }),
    cpuid: utils.getCpuId(),
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
  };

  rr(options, (err, httpResponse, body) => {
    if (err != null) {
      let stack = new Error().stack;
      log.info("Error while requesting ", err, stack);
      if (callback)
        callback(err, null, null);
      return;
    }
    if (httpResponse == null) {
      let stack = new Error().stack;
      log.info("Error while response ", err, stack);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      log.error("**** Error while response HTTP ", httpResponse.statusCode, body);
      if (callback)
        callback(httpResponse.statusCode, null, null);
      return;
    }
    let obj = null;
    if (err === null && body != null) {
      log.info("==== Checkin ===",
        require('util').inspect(body, {
          depth: null
        }),
        body.needUpgrade, {});
      obj = body;

      if (obj && obj.status && obj.status == 302 && obj.config && obj.config.bone && obj.config.bone.server) {
        if (endpoint != obj.config.bone.server) {
          endpoint = obj.config.bone.server;
          log.info("Redirecting to new server", obj.config.bone.server);
          console.log("Redirecting to new server", obj.config.bone.server);
          publishUrl(obj.config.bone.server);
          checkedin = false;
          lastendpoint = endpoint;
          return exports.checkin(config, license, info, callback);
        }
      }
      if (obj.jwt) {
        jwt = obj.jwt;
        publishJwt(jwt);
        publishUrl(endpoint);
      } else {
        rclient.del("sys:bone:jwt", (err, jwtdata) => {
        });
      }
      lastendpoint = endpoint;
      checkedin = true;
    }
    if (callback) {
      callback(err, obj);
    }
  });
}

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

  request(options, (err, httpResponse, body) => {
    if (err != null) {
      let stack = new Error().stack;
      log.info("Error while requesting ", err, stack,JSON.stringify(options));
      if (callback)
        callback(err, null, null);
      return;
    }
    if (httpResponse == null) {
      let stack = new Error().stack;
      log.info("Error while response ", err, stack);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      let stack = new Error().stack;
      log.error("**** Error while response HTTP ", httpResponse.statusCode,stack,JSON.stringify(options));
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

exports.log = function(cmd, obj, callback) {
  log.info("/device/log/" + cmd);
  let options = {
    uri: getEndpoint() + '/device/log/' + cmd,
    family: 4,
    method: 'POST',
    auth: {
      bearer: getToken()
    },
    json: obj
  };

  request(options, (err, httpResponse, body) => {
    if (err != null) {
      let stack = new Error().stack;
      log.info("Error while requesting ", err, stack);
      if (callback)
        callback(err, null, null);
      return;
    }
    if (httpResponse == null) {
      let stack = new Error().stack;
      log.info("Error while response ", err, stack);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      log.error("**** Error while response HTTP ", httpResponse.statusCode);
      if (callback)
        callback(httpResponse.statusCode, null, null);
      return;
    }
    let obj = null;
    if (err === null && body != null) {
      log.info("==== Log ===", body);
      obj = body;
    }
    if (callback) {
      callback(err, obj);
    }
  });
}


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

  request(options, (err, httpResponse, body) => {
    if (err) {
      let stack = new Error().stack;
      log.error("Error while requesting ", err, stack);
      log.info(body, {});
      if (callback)
        callback(err, null, null);
      return;
    }
    if (!httpResponse) {
      let stack = new Error().stack;
      log.error("Error while response ", err, stack);
      log.info(body, {});
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      log.error("**** Error while response HTTP ", httpResponse.statusCode);
      log.info(body, {});
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

exports.intelAsync = Promise.promisify(exports.intel);

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
    json: obj
  };

  request(options, (err, httpResponse, body) => {
    if (err != null) {
      let stack = new Error().stack;
      log.info("Error while requesting ", err, stack);
      if (callback)
        callback(err, null, null);
      return;
    }
    if (httpResponse == null) {
      let stack = new Error().stack;
      log.info("Error while response ", err, stack);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      log.error("**** Error while response HTTP ", httpResponse.statusCode);
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

exports.flowgraphAsync = Promise.promisify(exports.flowgraph)

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

  rr(options, (err, httpResponse, body) => {
    if (err != null) {
      let stack = new Error().stack;
      log.info("Error while requesting ", err, stack);
      if (callback)
        callback(err, null, null);
      return;
    }
    if (httpResponse == null) {
      let stack = new Error().stack;
      log.info("Error while response ", err, stack);
      if (callback)
        callback(500, null, null);
      return;
    }
    if (httpResponse.statusCode < 200 ||
      httpResponse.statusCode > 299) {
      log.error("**** Error while response HTTP ", httpResponse.statusCode);
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

function errorHandling(url, err, httpResponse) {
  if (err || !httpResponse) {
    log.error("Error while requesting", url, "Error:", err, {});
    return err || 500;
  }

  if (httpResponse.statusCode < 200 ||
    httpResponse.statusCode > 299) {
    log.error("Error while requesting", url, "Error:", httpResponse.statusCode, {});
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
  log.info(options.uri, feedback, {});

  request(options, (err, res, body) => {
    if (err) {
      let stack = new Error().stack;
      log.error("Error while requesting ", err, stack);
      log.info(body, {});
      if (callback)
        callback(err, null, null);
      return;
    }
    if (!res) {
      let stack = new Error().stack;
      log.error("Error while response ", err, stack);
      log.info(body, {});
      if (callback)
        callback(500, null, null);
      return;
    }
    if (res.statusCode < 200 ||
      res.statusCode > 299) {
      log.error("**** Error while response HTTP ", res.statusCode);
      log.info(body, {});
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

  log.info("Intel for feedback: '%s' => ", action, intel, {});

  if (!intel) {
    log.warn('Invalid intel: null');
    return;
  }

  let type = intel['if.type'] || intel['type'];
  let target = intel['if.target'] || intel['target'];

  switch (type) {
  case 'dns':
  case 'ip':
  case 'devicePort':
  case 'mac':
      break;
    default:
      log.warn('Invalid exception type: ' + type);
      return;
  }

  if (!target) {
    log.error('Invalid exception target: ' + target);
    return;
  }

  let feedback = {
    feedbacks: [{
      'if.action': action,
      'if.type': type
    }]
  };

  let __submitIntelFeedback = (categories) => {
    log.info("Categories: ", categories, {});

    if (categories) {
      feedback.feedbacks[0]['if.category'] = categories;
    }

    log.info("Submit Feedback:", feedback, {});

    intelFeedback(feedback, (err) => {
      if (err) {
        log.error("Submit intel feedback w/ error: ", err, {});
      } else {
        log.info("Submit intel feedback successfully");
      }
    });
  };

  log.info("Action:", action, "Type:", type, ", Original value:", target, {});

  let _target = null;
  switch (type) {
    case 'dns':
      _target = flowUtil.hashHost(target);
      feedback.feedbacks[0]['if.target'] = _target;
      feedback.feedbacks[0]['if._target'] = target;
      domainCategory.getCategory(target, __submitIntelFeedback);
      break;
    case 'ip':
      _target = flowUtil.hashIp(target);
      feedback.feedbacks[0]['if.target'] = _target;
      feedback.feedbacks[0]['if._target'] = target;
      __submitIntelFeedback(null);
      break;
    default:
  }

};
