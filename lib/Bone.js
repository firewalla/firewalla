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

let log = require("../net2/logger.js")(__filename);

let config = require('../net2/config.js').getConfig();

let request = require('request');

let endpoint = config.firewallaBoneServerURL || "https://firewalla.encipher.io/bone/api/v3"
let lastendpoint = null;
let licenseServer = config.firewallaLicenseServer || "https://firewalla.encipher.io/license/api/v1"
//let endpoint = "http://firewalla-dev.encipher.io:6001/bone/api/v2"

let redis = require("redis");
let rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);

let eid = null;
let token = null;
let jwt = null;
let checkedin = false;
let os = require('os');

let utils = require('../lib/utils.js');

let appConnected = false;

let Promise = require('bluebird');

rclient.hgetall("sys:ept", (err, data) => {
  if (data) {
    eid = data.eid;
    log.info("Cloud token is ready");
  }
});

setInterval(()=>{
    checkCloud(()=>{
    });
},2000);

function publishJwt(jwt) {
   rclient.set("sys:bone:jwt",jwt,(err)=> {
       if (err == null) {
           rclient.publish("comm:sys:bone:jwt", jwt);
       }
   });
}

function publishUrl(url) {
   rclient.set("sys:bone:url",url,(err)=> {
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
    } else if (channel == "com:sys:bone:url") {
        endpoint = message;
    }
});
rclient.get("sys:bone:url",(err,urldata)=>{
    if (urldata) {
         lastendpoint = urldata;
    } 
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
          token = data.token;

	  let cnt = data.group_member_cnt;
	  appConnected = (cnt && cnt > 1);
          rclient.get("sys:bone:jwt",(err,jwtdata)=>{
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
        checkCloud((token)=>{
        });
        return false;
    }
}

function waitUtilCloudReady(done) {
  if(exports.cloudready()) {
    done();
  } else {
    setTimeout(() => {
        waitUtilCloudReady(done);
    }, 1000); // 1 second
  }
}

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
      if(err) {
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
      if(err)
        reject(err);
      else
        resolve(obj);
    })
  });
}

exports.getLicense = function (luid,mac,callback) {
    let options = {
        uri: licenseServer+ '/license/issue/' + luid+"?mac=" + mac,
        method: 'GET',
        auth: {
            bearer: token
        }
    };
    log.info(options, {});

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

exports.checkin = function (config,license,info, callback) {
    log.info("Checkin");
    let obj = {
        uptime: process.uptime(),
        version: config.version,
        sys: JSON.stringify({
            'sysmem': os.freemem(),
            'detailsysmem':info.memory,
            'loadavg': os.loadavg(),
            'uptime': os.uptime()
        }),
        redis: JSON.stringify({
            'memory': rclient.server_info.used_memory
        }),
        cpuid: utils.getCpuId(),
        mac: info.mac,
        ip: info.publicIp,
    }
    if (license) {
        obj.license = JSON.stringify(license);
    }
    let options = {
        uri: endpoint + '/sys/checkin',
        method: 'POST',
        auth: {
            bearer: token
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
            log.info("==== Checkin ===",
              require('util').inspect(body, {depth: null}),
              body.needUpgrade,
              {});
            obj = body;

            if (obj && obj.status && obj.status==302 && obj.config && obj.config.bone && obj.config.bone.server) {
                if (endpoint != obj.config.bone.server) {
                    endpoint = obj.config.bone.server;
                    log.info("Redirecting to new server", obj.config.bone.server);
                    console.log("Redirecting to new server", obj.config.bone.server);
                    publishUrl(obj.config.bone.server);
                    checkedin = false;
                    lastendpoint = endpoint;
                    return exports.checkin(config,license,info,callback);  
                } 
            }
            if (obj.jwt) {
                jwt = obj.jwt;
                publishJwt(jwt);
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

exports.device = function (cmd, obj, callback) {
    //log.info("/device/" + cmd, obj);
  log.info("sending POST request: /device/" + cmd);
    let options = {
        uri: getEndpoint()+ '/device/' + cmd,
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
            log.info("==== Device ===", body);
            obj = body;
        }
        if (callback) {
            callback(err, obj);
        }
    });
}

exports.log = function (cmd, obj, callback) {
    log.info("/device/log/" + cmd);
    let options = {
        uri: getEndpoint()+ '/device/log/' + cmd,
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

exports.intel = function (ip, action, obj, callback) {
    log.info("/intel/host/" + ip + "/" + action);
    let options = {
        uri: getEndpoint()+ '/intel/host/' + ip + '/' + action,
        method: 'POST',
        auth: {
            bearer: getToken()
        },
        json: obj,
        timeout: 10000 // 10 seconds
    };

    request(options, (err, httpResponse, body) => {
        if (err != null) {
            let stack = new Error().stack;
            log.error("Error while requesting ", err, stack);
          console.log(body);
            if (callback)
                callback(err, null, null);
            return;
        }
        if (httpResponse == null) {
            let stack = new Error().stack;
            log.error("Error while response ", err, stack);
          console.log(body);
            if (callback)
                callback(500, null, null);
            return;
        }
        if (httpResponse.statusCode < 200 ||
            httpResponse.statusCode > 299) {
            log.error("**** Error while response HTTP ", httpResponse.statusCode);
            console.log(body);
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

// flowgraph
// input computed summary
// output filtered list that expresses the real activity of the user
// obj:
//   [{id:something, graph:{activity,appr}...]
//   return same structure with things that are noise removed

exports.flowgraph = function (action, obj, callback) {
    log.info("/flowgraph/" + action);
    let options = {
        uri: getEndpoint()+ '/flowgraph/' + action,
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

exports.hashset = function(hashsetid, callback) {
    log.info("/hashset/" + hashsetid);
    let options = {
        uri: getEndpoint()+ '/intel/hashset/' + hashsetid,
        method: 'GET',
        auth: {
            bearer: getToken()
        }
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
  callback = callback || function () {};

  log.info("Loading service config from cloud");
  let url = getEndpoint()+ '/service/config';
  let options = {
    uri: url,
    method: 'GET',
    auth: {
      bearer: getToken()
    }
  };

  request(options, (err, httpResponse, body) => {
    let errResult = errorHandling(url, err, httpResponse);

    if(errResult) {
      callback(errResult);
      return;
    }

    if(body) {
      let obj = null;
      try {
        obj = JSON.parse(body);
      } catch(err) {
        callback(err);
        return;
      }
      callback(null, obj);
    }
  });
};
