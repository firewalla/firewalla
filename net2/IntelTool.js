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

let log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

let Promise = require('bluebird');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let async2 = require('async');

let bone = require('../lib/Bone.js');

let util = require('util');

let flowUtil = require('../net2/FlowUtil.js');

let firewalla = require('../net2/Firewalla.js');

let instance = null;

class IntelTool {

  constructor() {
    if(!instance) {
      instance = this;
      if(firewalla.isProduction()) {
        this.debugMode = false;
      } else {
        this.debugMode = true;
      }
    }
    return instance;
  }

  getIntelKey(ip) {
    return util.format("intel:ip:%s", ip);
  }


  intelExists(ip) {
    let key = this.getIntelKey(ip);

    return rclient.existsAsync(key)
      .then((exists) => {
        return exists == 1
      })
  }

  appExists(ip) {
    let key = this.getIntelKey(ip);

    return rclient.hgetAsync(key, "app")
      .then((result) => {
        if (result == null) {
          return false;
        } else {
          return true;
        }
      });
  }

  getIntel(ip) {
    let key = this.getIntelKey(ip);

    return rclient.hgetallAsync(key);
  }  

  addIntel(ip, intel, expire) {
    intel = intel || {}
    expire = expire || 7 * 24 * 3600; // one week by default

    let key = this.getIntelKey(ip);

    log.debug("Storing intel for ip", ip);

    intel.updateTime = `${new Date() / 1000}`

    return rclient.hmsetAsync(key, intel)
      .then(() => {
        return rclient.expireAsync(key, expire);
      });
  }

  removeIntel(ip) {
    let key = this.getIntelKey(ip);

    return rclient.delAsync(key);
  }

  checkIntelFromCloud(ipList, domainList, fd, appList, flow) {
    log.debug("Checking intel for",fd, ipList, domainList, {});
    if (fd == null) {
      fd = 'in';
    }

    let flowList = [];
    let _ipList = [];
    let _aList = [];
    let aList = [];
    let _hList = [];
    let hList = [];

    ipList.forEach((ip)=>{
      _ipList = _ipList.concat(flowUtil.hashHost(ip));
    });

    domainList.forEach((d) => {
      let hds = flowUtil.hashHost(d);
      _hList = _hList.concat(hds);

      let ads = flowUtil.hashApp(d);
      _aList = _aList.concat(ads);
    });

    _ipList.push.apply(_ipList, _hList);

    if(this.debugMode) {
      flowList.push({
        iplist:ipList,
        hlist:domainList,
        alist:domainList,
        _iplist:_ipList,
        _hlist:_hList,
        _alist:_aList,
        flow:{fd:fd}});
    } else {
      flowList.push({
        _iplist:_ipList,
        _hlist:_hList,
        _alist:_aList,
        flow:{fd:fd}});
    }

    let data = {flowlist:flowList, hashed:1};

    //    log.info(require('util').inspect(data, {depth: null}));

    return new Promise((resolve, reject) => {
      bone.intel("*","", "check", data, (err, data) => {
        if(err) {
          log.info("IntelCheck Result FAIL:",ipList, data, {});
          reject(err)
        } else {
          log.debug("IntelCheck Result:",ipList, data, {});
          resolve(data);
        }

      });
    });
  }


  getSSLCertKey(ip) {
    return util.format("host:ext.x509:%s", ip);
  }

  getSSLCertificate(ip) {
    let certKey = this.getSSLCertKey(ip);

    return async(() => {
      let sslInfo = await (rclient.hgetallAsync(certKey));
      if(sslInfo) {
        let subject = sslInfo.subject;
        if(subject) {
          let result = this._parseX509Subject(subject);
          if(result) {
            sslInfo.CN = result.CN || ""
            sslInfo.OU = result.OU || ""
            sslInfo.O = result.O || ""
          }
        }

        return sslInfo;
      } else {
        return undefined;
      }

    })();
  }

  _parseX509Subject(subject) {
    let array = subject.split(',');
    let result = {};
    for (let i in array) {
      let obj = array[i].split("=");
      if (obj.length == 2) {
        result[obj[0]] = obj[1];
      }
    }

    return result;
  }

  getDNSKey(ip) {
    return util.format("dns:ip:%s", ip);
  }

  getDNS(ip) {
    let key = this.getDNSKey(ip);

    return rclient.hgetallAsync(key);
  }

  updateIntelKeyInDNS(ip, intel, expireTime) {
    expireTime = expireTime || 24 * 3600; // default one day

    let key = this.getDNSKey(ip);

    return async(() => {
      // only update if dns key exists
      // let keys = await (rclient.keysAsync(key))
      // FIXME: temporalry disabled keys length check, still insert data even dns entry doesn't exist
//      if(keys.length > 0) {
        if (intel && intel.ip) {
            delete intel.ip;
        }
        let intelJSON = JSON.stringify(intel);
        await (rclient.hsetAsync(key, "_intel", intelJSON))
        await (rclient.expireAsync(key, expireTime))
//      }
    })()
  }
}


module.exports = IntelTool;
