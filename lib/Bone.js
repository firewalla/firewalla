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

let endpoint = config.firewallaServerURL || "https://firewalla.encipher.io/bone/api/v2"
//let endpoint = "http://firewalla-dev.encipher.io:6001/bone/api/v2"

let redis = require("redis");
let rclient = redis.createClient();

let eid = null;
let token = null;
let os = require('os');

let utils = require('../lib/utils.js');

let appConnected = false;

rclient.hgetall("sys:ept", (err, data) => {
  if (data) {
    eid = data.eid;
    // TODO: oken = data.token;
    log.info("Cloud token is ready");
  }
});

setInterval(()=>{
    checkCloud(()=>{
    });
},2000);

function checkCloud(callback) {
    rclient.hgetall("sys:ept", (err, data) => {
        if (data) {
          eid = data.eid;
          token = data.token;

	  let cnt = data.group_member_cnt;
	  appConnected = (cnt && cnt > 1);
	  
          callback(data);
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
            log.info("**** Error while response HTTP ", httpResponse.statusCode);
            if (callback)
                callback(httpResponse.statusCode, null, null);
            return;
        }
        let obj = null;
        if (err === null && body != null) {
            log.info("==== Checkin ===", body, body.needUpgrade);
            obj = body;
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
        uri: endpoint + '/device/' + cmd,
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
            log.info("**** Error while response HTTP ", httpResponse.statusCode);
            if (callback)
                callback(httpResponse.statusCode, null, null);
            return;
        }
        let obj = null;
        if (err === null && body != null) {
            log.info("==== Checkin ===", body);
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
        uri: endpoint + '/device/log/' + cmd,
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
            log.info("**** Error while response HTTP ", httpResponse.statusCode);
            if (callback)
                callback(httpResponse.statusCode, null, null);
            return;
        }
        let obj = null;
        if (err === null && body != null) {
            log.info("==== Checkin ===", body);
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
        uri: endpoint + '/intel/host/' + ip + '/' + action,
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
            log.info("**** Error while response HTTP ", httpResponse.statusCode);
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
        uri: endpoint + '/flowgraph/' + action,
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
            log.info("**** Error while response HTTP ", httpResponse.statusCode);
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
        uri: endpoint + '/intel/hashset/' + hashsetid,
        method: 'GET',
        auth: {
            bearer: token
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
            log.info("**** Error while response HTTP ", httpResponse.statusCode);
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
  let url = endpoint + '/service/config';
  let options = {
    uri: url,
    method: 'GET',
    auth: {
      bearer: token
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
