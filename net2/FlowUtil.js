/*    Copyright 2019-2024 Firewalla Inc.
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

'use strict'

const log = require('./logger.js')(__filename);
const urlHash = require('../util/UrlHash.js')

const _ = require('lodash')

// Take host and return hashed
// [[a,a'],[b,b']]
function hashHost(_domain, opts) {
  let results = urlHash.canonicalizeAndHashExpressions(_domain);
  if (results.length) {
    if (opts && opts.keepOriginal) {
      return results.map(x => {
        // remove ending '/' from domain name
        if (x[0].endsWith('/')) {
          x[0] = x[0].slice(0, -1);
        }
        return x;
      });
    } else {
      return results.map(x => x.slice(1, 3));
    }
  } else {
    return null;
  }
}

// return longer domains first, tld latter
function getSubDomains(_domain) {
  const results = urlHash.canonicalize(_domain);

  // remove ending '/' from domain name
  return results.map(x => x.endsWith('/') ? x.slice(0, -1) : x)
}

function hashMac(_mac) {
    if (_mac == null) {
        return null;
    }
    let hash = urlHash.hashBase64(_mac);
    return hash;
}

// IP always will be append '/'
function hashIp(_ip) {
    if (_ip == null) {
        return null;
    }
    let hashes = urlHash.canonicalizeAndHashExpressions(_ip);
    // console.log("Hashes",hashes);
    if (hashes && hashes.length>0) {
        return hashes[0][2];
    } else {
        return null;
    }
}

function hashApp(domain) {
  let hashed = [];
  if (!_.isString(domain)) return hashed

  const d = domain.split(".");
  const l = d.length

  if (l >= 2) {
    hashed.push(urlHash.hashBase64("*." + d[l - 2] + "." + d[l - 1]));
  }
  if (l >= 3) {
    hashed.push(urlHash.hashBase64("*." + d[l - 3] + "." + d[l - 2] + "." + d[l - 1]));
  }
  if (l >= 4) {
    hashed.push(urlHash.hashBase64("*." + d[l - 4] + "." + d[l - 3] + "." + d[l - 2] + "." + d[l - 1]));
  }
  return hashed;
}

function dhnameFlow(_flow) {
    if (_flow.dhname) {
        return _flow.dhname;
    }
    if (_flow.af!=null && Object.keys(_flow.af).length>0) {
        for (let key in _flow.af) {
            return key;
        }
    }
    if (_flow.lh == _flow.sh) {
        return _flow.dh;
    } else{
        return _flow.sh;
    }
}

function hashFlow(_flow, clean) {
    let flow = JSON.parse(JSON.stringify(_flow));
    if (flow!=null && flow.af!=null && Object.keys(flow.af).length>0) {
        let _af = {};
        for (let key in flow.af) {
            let afe = flow.af[key];
            let hashedKey = urlHash.hashBase64(key);
            _af[hashedKey] = afe;
            afe.uri = urlHash.canonicalizeAndHashExpressions(key+afe.uri).map(x => x.slice(1,3) ); // remove original url
            delete afe.host;
        }
        delete flow.af;
        flow._af = _af;
    }

    if (flow.mac) {
        delete flow.mac;
    }


    if (clean) {
        if (flow.shname) {
            delete flow.shname;
        }
        if (flow.dhname) {
            delete flow.shname;
        }
        if (flow.iplist) {
            delete flow.iplist;
        }
        if (flow.lh) {
            flow.lh = hashIp(flow.lh);
        }
        if (flow.sh) {
            flow.sh = hashIp(flow.sh);
        }
        if (flow.dh) {
            flow.dh = hashIp(flow.dh);
        }
    }

    return flow;
    // Hash other things ...
}

// x: not a valid flow, only need to record length
//    not to be presented to user or do security lookup.

function addFlag(flow,flag) {
    if (!flow || !flag) {
        return flow.f;
    }
    if (!checkFlag(flow,flag)) {
        if (!flow.f) {
            flow.f = flag;
        } else {
            flow.f = flow.f + flag;
        }
    }
    return flow.f;
}

function checkFlag(flow,flag) {
    if (!flow.f) {
        return false;
    }
    if (!flag) {
        return true;
    }
    return (flow.f.indexOf(flag) >= 0);
}

// intelFlow => appFlow or categoryFlow

function hashIntelFlow(flow, cache) {
  cache = cache || {}

  if(flow.device) {
    let realMac = flow.device
    let hashedMac = hashMac(realMac)
    cache[hashedMac] = realMac
    flow.device = hashedMac
  }

  return flow
}

function unhashIntelFlow(flow, cache) {
  cache = cache || {}

  if(flow.device && cache[flow.device]) {
    flow.device = cache[flow.device]
  }

  return flow
}

function hashIntelFlows(intelFlows, cache) {
  for(let intel in intelFlows) {
    let flows = intelFlows[intel]
    flows.forEach((flow) => {
      hashIntelFlow(flow, cache)
    })
  }

  return intelFlows
}

function unhashIntelFlows(intelFlows, cache) {
  if(typeof intelFlows != 'object') { // workaround for cloud returns a string
    return {}
  }

  for(let intel in intelFlows) {
    let flows = intelFlows[intel]
    flows.forEach((flow) => {
      unhashIntelFlow(flow, cache)
    })
  }

  return intelFlows
}

let tsMonotonic = Date.now() / 1000
function getUniqueTs(ts) {
  if (ts > tsMonotonic) {
    tsMonotonic = ts
    return ts
  }

  // block flow rate limit is set to 1000/sec so this should be mostly fine
  tsMonotonic = Math.floor(tsMonotonic * 1000 + 1) / 1000;

  // logs only on fractional part equals
  if (tsMonotonic - ts > 1 && (tsMonotonic - ts) % 1 < 0.0001) {
    log.warn(new Error('Unique TS getting choked, ' + ts + ', ' + tsMonotonic))
  }
  return tsMonotonic
}

module.exports = {
  addFlag,
  checkFlag,
  hashFlow,
  hashHost,
  hashMac,
  hashIp,
  hashApp,
  hashIntelFlow,
  unhashIntelFlow,
  hashIntelFlows,
  unhashIntelFlows,
  dhnameFlow,
  getSubDomains,
  getUniqueTs,
};
