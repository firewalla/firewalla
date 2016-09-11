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

var instance = null;
var log = null;
var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

var redis = require("redis");
var rclient = redis.createClient();

var later = require('later');


// appr:signature {version:<timestamp>}
//
// appr:map:domain: [apps]
// {
//   domain: ...  ||
//   user_agent: ... 
//   app: [['name',certainty] ]
// } 
// 
// appr:name:"app": { ... app info }
// {
//    name: " ",
// }
//


module.exports = class {
    constructor(path, loglevel) {
        if (instance == null) {
            log = require("./logger.js")("app manager", loglevel);
            rclient.keys("appr:*", (err, keys) => {
                let multiarray = [];
                for (let i in keys) {
                    multiarray.push(['del', keys[i]]);
                }
                rclient.multi(multiarray).exec((err, replies) => {
                    log.debug("Wipped all app signatures");
                    this.rebuild(path);
                });
            });

            instance = this;
        }
        return instance;
    }

    rebuild(path) {
        let fs = require('fs');
        let signatureFile = fs.readFileSync(path); // zzzz....
        let signatures = JSON.parse(signatureFile);

        for (let i in signatures.apps) {
            //       log.debug("adding app signature", signatures.apps[i],{});
            rclient.hmset('appr:app:' + signatures.apps[i].name.toLowerCase(), signatures.apps[i]);
        }

        for (let i in signatures.signatures) {
            let key = null;
            let s = signatures.signatures[i];
            if (s.domain) {
                for (let d in s.domain) {
                    //              log.debug("adding domain signature", s.domain[d],JSON.stringify(s.app));
                    rclient.set('appr:map:domain:' + s.domain[d].toLowerCase(), JSON.stringify(s.app));
                }
            }
            if (s.ua) {
                for (let d in s.ua) {
                    rclient.set('appr:map:ua:' + s.ua[d].toLowerCase(), JSON.stringify(s.app));
                }
            }
        }
    }

    query(domain, ua, callback) {
        if (domain == null) {
            callback(null,null);
            return;
        }
        let multiarray = [];
        if (domain) {
            multiarray.push(["get", "appr:map:domain:" + domain]);
            let d = domain.split(".");
            if (d.length >= 2) {
                multiarray.push(["get", "appr:map:domain:*." + d[d.length - 2] + "." + d[d.length - 1]]);
            }
            if (d.length >= 3) {
                multiarray.push(["get", "appr:map:domain:*." + d[d.length - 3] + "." + d[d.length - 2] + "." + d[d.length - 1]]);
            }
            if (d.length >= 4) {
                multiarray.push(["get", "appr:map:domain:*." + d[d.length - 4] + "." + d[d.length - 3] + "." + d[d.length - 2] + "." + d[d.length - 1]]);
            }
        }
        if (ua) {
            multiarray.push(["get", "appr:map:ua:" + ua]);
        }
        if (domain) {
            rclient.multi(multiarray).exec((err, results) => {
                if (err) {
                    callback(err, null);
                } else {
                    //log.debug("found searching multi", multiarray,results);
                    let appresult = {};
                    for (let r in results) {
                        let result = results[r];
                        let apps = JSON.parse(result);
                        for (let i in apps) {
                            let app = appresult[apps[i][0]];
                            if (app == null) {
                                appresult[apps[i][0]] = Number(apps[i][1]);
                            } else {
                                appresult[apps[i][0]] += apps[i][1];
                            }
                        }
                    }
                    //log.debug("Tabulated results", appresult);        
                    callback(null, appresult);
                }
            });
        }
    }

    identify(conn) {

    }
}
