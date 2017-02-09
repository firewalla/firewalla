/*    Copyright 2016 Rottiesoft LLC 
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

var request = require('request');

var endpoint = "https://firewalla.encipher.io/bone/api/v2"
//var endpoint = "http://firewalla-dev.encipher.io:6001/bone/api/v2"

var redis = require("redis");
var rclient = redis.createClient();

var eid = null;
var token = null;
var os = require('os');

var utils = require('../lib/utils.js');

rclient.hgetall("sys:ept", (err, data) => {
    if (data) {
        eid = data.eid;
        token = data.token;
        console.log("Got Tokens Bone", eid, token);
        //     exports.checkin({version:2},null);
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
            callback(data);
        } else {
            callback(null);
        }
    });
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

exports.checkin = function (config,license,info, callback) {
    console.log("Checkin");
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
    var options = {
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
            console.log("Error while requesting ", err, stack);
            if (callback)
                callback(err, null, null);
            return;
        }
        if (httpResponse == null) {
            let stack = new Error().stack;
            console.log("Error while response ", err, stack);
            if (callback)
                callback(500, null, null);
            return;
        }
        if (httpResponse.statusCode < 200 ||
            httpResponse.statusCode > 299) {
            console.log("**** Error while response HTTP ", httpResponse.statusCode);
            if (callback)
                callback(httpResponse.statusCode, null, null);
            return;
        }
        let obj = null;
        if (err === null && body != null) {
            console.log("==== Checkin ===", body, body.needUpgrade);
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
    //console.log("/device/" + cmd, obj);
  console.log("sending POST request: /device/" + cmd);
    var options = {
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
            console.log("Error while requesting ", err, stack);
            if (callback)
                callback(err, null, null);
            return;
        }
        if (httpResponse == null) {
            let stack = new Error().stack;
            console.log("Error while response ", err, stack);
            if (callback)
                callback(500, null, null);
            return;
        }
        if (httpResponse.statusCode < 200 ||
            httpResponse.statusCode > 299) {
            console.log("**** Error while response HTTP ", httpResponse.statusCode);
            if (callback)
                callback(httpResponse.statusCode, null, null);
            return;
        }
        let obj = null;
        if (err === null && body != null) {
            console.log("==== Checkin ===", body);
            obj = body;
        }
        if (callback) {
            callback(err, obj);
        }
    });
}

exports.log = function (cmd, obj, callback) {
    console.log("/device/log/" + cmd);
    var options = {
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
            console.log("Error while requesting ", err, stack);
            if (callback)
                callback(err, null, null);
            return;
        }
        if (httpResponse == null) {
            let stack = new Error().stack;
            console.log("Error while response ", err, stack);
            if (callback)
                callback(500, null, null);
            return;
        }
        if (httpResponse.statusCode < 200 ||
            httpResponse.statusCode > 299) {
            console.log("**** Error while response HTTP ", httpResponse.statusCode);
            if (callback)
                callback(httpResponse.statusCode, null, null);
            return;
        }
        let obj = null;
        if (err === null && body != null) {
            console.log("==== Checkin ===", body);
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
    console.log("/intel/host/" + ip + "/" + action);
    var options = {
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
            console.log("Error while requesting ", err, stack);
            if (callback)
                callback(err, null, null);
            return;
        }
        if (httpResponse == null) {
            let stack = new Error().stack;
            console.log("Error while response ", err, stack);
            if (callback)
                callback(500, null, null);
            return;
        }
        if (httpResponse.statusCode < 200 ||
            httpResponse.statusCode > 299) {
            console.log("**** Error while response HTTP ", httpResponse.statusCode);
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
    console.log("/flowgraph/" + action);
    var options = {
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
            console.log("Error while requesting ", err, stack);
            if (callback)
                callback(err, null, null);
            return;
        }
        if (httpResponse == null) {
            let stack = new Error().stack;
            console.log("Error while response ", err, stack);
            if (callback)
                callback(500, null, null);
            return;
        }
        if (httpResponse.statusCode < 200 ||
            httpResponse.statusCode > 299) {
            console.log("**** Error while response HTTP ", httpResponse.statusCode);
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
    console.log("/hashset/" + hashsetid);
    var options = {
        uri: endpoint + '/intel/hashset/' + hashsetid,
        method: 'GET',
        auth: {
            bearer: token
        }
    };

    request(options, (err, httpResponse, body) => {
        if (err != null) {
            let stack = new Error().stack;
            console.log("Error while requesting ", err, stack);
            if (callback)
                callback(err, null, null);
            return;
        }
        if (httpResponse == null) {
            let stack = new Error().stack;
            console.log("Error while response ", err, stack);
            if (callback)
                callback(500, null, null);
            return;
        }
        if (httpResponse.statusCode < 200 ||
            httpResponse.statusCode > 299) {
            console.log("**** Error while response HTTP ", httpResponse.statusCode);
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

