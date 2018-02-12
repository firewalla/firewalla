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

var instance = null;

let log = require('./logger.js')(__filename);

var request = require('request');
var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

var redis = require("redis");
var rclient = redis.createClient();
var bone = require("../lib/Bone.js");


module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            instance = this;
        }
        return instance;
    }

    action(action, ip, callback) {
        if (action == "ignore") {
            rclient.hmset("intel:action:"+ip, {'ignore':true}, (err)=> {
                callback(err,null);
            });
        } else if (action == "unignore") {
            rclient.hmset("intel:action:"+ip, {'ignore':false}, (err)=> {
                callback(err,null);
            });
        } else if (action == "block") {
        } else if (action == "unblock") {
        } else if (action == "support") {
        }

      bone.intel(ip, "", action, {});
    }

    cachelookup(ip, origin, callback) {
        rclient.get("cache.intel:" + origin + ":" + ip, (err, result) => {
            callback(err, result);
        });
    }

    cacheAdd(ip, origin, value) {
        if (value == null) {
            value = "none";
        }
        rclient.set("cache.intel:" + origin + ":" + ip, value, (err, result) => {
            rclient.expireat("cache.intel:" + origin + ":" + ip, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 7);
        });
    }

    lookup(ip, callback) {
        if (ip == null || ip == "8.8.8.8" || sysManager.isLocalIP(ip) == true) {
            callback(null, null, null);
            return;
        }

        rclient.hgetall("intel:action:"+ip, (err,data) => {
            if (data) {
                if (data.ignore == true) {
                    log.info("Intel:Lookup:Ignored",ip);
                    callback(null,null,null);
                }
            }
            this.cachelookup(ip, "cymon", (err, result) => {
                if (result != null && result != "none") {
                    let weburl = "https://cymon.io/" + ip;
                    let obj = JSON.parse(result);
                    if (obj == null || obj.count == 0) {
                        callback(null, null, null);
                        return;
                    }
                    this._location(ip,(err,lobj)=>{ 
                        obj.lobj = lobj;
                        log.info("Intel:Location",ip,obj.lobj);
                        this._packageCymon(ip, obj);
                        callback(err, obj, weburl);
                    });
                } else {
                    //            callback(null,null,null);
                    this._lookup(ip, callback);
                }
            });
        });
    }

    _packageCymon(ip, obj) {
        let weburl = "https://cymon.io/" + ip;
        log.info("INFO:------ Intel Information", obj.count);
        let summary = obj.count + " reported this IP.\n";
        let max = 4;
        let severity = 0;
        /*
        for (let i in obj.results) {
           if (max<=0) { break ;}
           summary +="- " +obj.results[i].title+"\n";
           max--;
        }
        */
        let tags = {};
        for (let i in obj.results) {
            let r = obj.results[i];
            if (r.tag) {
                if (tags[r.tag] == null) {
                    tags[r.tag] = {
                        tag: r.tag,
                        count: 1
                    };
                } else {
                    tags[r.tag].count += 1;
                }
            }
        }

        let tagsarray = [];
        for (let i in tags) {
            tagsarray.push(tags[i]);
            if (i.includes("malicious")) {
                severity += tags[i].count * 3;
            } else if (i.includes("malware")) {
                severity += tags[i].count * 3;
            } else if (i == "blacklist") {
                severity += tags[i].count * 3;
            } else {
                severity += 1;
            }
        }

        obj.severityscore = severity;

        tagsarray.sort(function (a, b) {
            return Number(b.count) - Number(a.count);
        })

        obj.summary = summary;
        obj.weburl = weburl;
        obj.tags = tagsarray;

        if (obj.tags != null && obj.tags.length > 0) {
            let reason = "Possible: ";
            let first = true;
            for (let i in obj.tags) {
                if (first) {
                    reason += obj.tags[i].tag;
                    first = false;
                } else {
                    reason += " or " + obj.tags[i].tag;
                }
            }
            obj.reason = reason;
        }
    }

    /* curl ipinfo.io/98.124.243.43/
{
  "ip": "98.124.243.43",
  "hostname": "No Hostname",
  "city": "Kirkland",
  "region": "Washington",
  "country": "US",
  "loc": "47.6727,-122.1873",
  "org": "AS21740 eNom, Incorporated",
  "postal": "98033"
 */
    _location(ip,callback) {
      log.info("Looking up location:",ip);
      this.cachelookup(ip, "ipinfo", (err,data)=>{
        if (data!=null) {
            callback(null, JSON.parse(data));
            return;
        }
        let weburl = "https://ipinfo.io/" + ip;

        var options = {
            uri: weburl,
            method: 'GET',
            family: 4
            // Authorization: 'Token dc30fcd03eddbd95b90bacaea5e5a44b1b60d2f5',
        };

        request(options, (err, httpResponse, body) => {
            if (err != null) {
                let stack = new Error().stack;
                log.info("Error while requesting ", err, stack);
                callback(err, null, null);
                return;
            }
            if (httpResponse == null) {
                let stack = new Error().stack;
                log.info("Error while response ", err, stack);
                callback(500, null, null);
                return;
            }
            if (httpResponse.statusCode < 200 ||
                httpResponse.statusCode > 299) {
                log.error("**** Error while response HTTP ", httpResponse.statusCode);
                callback(httpResponse.statusCode, null, null);
                return;
            }
            if (err === null && body != null) {
                this.cacheAdd(ip, "ipinfo", body);
                let obj = JSON.parse(body);
                if (obj != null) {
                    callback(null,obj);
                } else {
                    callback(null,null);
                }
            }
        });
      });
    }

    _lookup(ip, callback) {
        let weburl = "https://cymon.io/" + ip;
        let url = "https://cymon.io" + "/api/nexus/v1/ip/" + ip + "/events?limit=100";

        var options = {
            uri: url,
            method: 'GET',
            family: 4
            // Authorization: 'Token dc30fcd03eddbd95b90bacaea5e5a44b1b60d2f5',
        };

        request(options, (err, httpResponse, body) => {
            if (err != null) {
                let stack = new Error().stack;
                log.info("Error while requesting ", err, stack);
                callback(err, null, null);
                return;
            }
            if (httpResponse == null) {
                let stack = new Error().stack;
                log.info("Error while response ", err, stack);
                callback(500, null, null);
                return;
            }
            if (httpResponse.statusCode < 200 ||
                httpResponse.statusCode > 299) {
                log.error("**** Error while response HTTP ", httpResponse.statusCode);
                callback(httpResponse.statusCode, null, null);
                return;
            }
            if (err === null && body != null) {
                this.cacheAdd(ip, "cymon", body);
                let obj = JSON.parse(body);
                if (obj != null) {
                    if (obj.count == 0) {
                        log.info("INFO:====== No Intel Information!!", ip);
                        callback(null, null, null);
                    } else {
                        this._location(ip,(err,lobj)=>{ 
                            obj.lobj = lobj;
                            log.info("Intel:Location",ip,obj.lobj);
                            this._packageCymon(ip, obj);
                            callback(err, obj, obj.weburl);
                        });
                    }
                } else {
                    callback(null, null, null);
                }
            }
        });

    }
}
