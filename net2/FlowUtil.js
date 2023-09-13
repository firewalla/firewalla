/*    Copyright 2019-2023 Firewalla Inc.
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

/*
[{"iplist":["imap.gmail.com","2607:f8b0:400e:c02::6c"],"_iplist":[[["v8+uoQ==","v8+uoU6tp+G9yBazQa54GpZ17m4FaiTHPgetvjPqFgg="],["YUhHHg==","YUhHHolh1gWizFkn/7n2xXLRKt/yx+HqlL2VHgHmsiE="]],[["/Dzjwg==","/DzjwmTcCYam2jkfB/KVCqrq3r+4wNL0ADtItIFhzA0="]]],"_alist":[["ob0wP2IrbSl/n+54E14YpDTKBZ1csnd9qeJ/fOzBOlo=","eHOL8nmOQNf+oLzLS7SPsyWUeCo5prpe7MC0Q2S8H1E="]],"flow":{"ts":1481892760.964665,"sh":"2601:646:9100:74e0:f43b:7b05:e66c:fe69","_ts":1481892768,"dh":"2607:f8b0:400e:c02::6c","ob":0,"rb":68844,"ct":6,"fd":"in","lh":"2601:646:9100:74e0:f43b:7b05:e66c:fe69","du":5.080037,"pf":{"tcp.993":{"ob":0,"rb":68844,"ct":6}},"af":{},"flows":[[1481892761,1481892762,0,5086],[1481886462,1481886462,0,5090],[1481877162,1481877163,0,10934],[1481870789,1481870789,0,4996],[1481871399,1481871400,0,5000],[1481865055,1481865057,0,37738]]}}]

[ {
    "_iplist": [[domain1],[domain2],[ip hash]
    "_aiplist":[[*.app.com],[*.blah.app.com]]
    "_dh"
    "_sh"

*/




/*
var testurl = "{\"ts\":1481605986.064498,\"sh\":\"192.168.2.186\",\"_ts\":1481606086,\"dh\":\"54.183.55.161\",\"ob\":406,\"rb\":10260,\"ct\":1,\"fd\":\"in\",\"lh\":\"192.168.2.186\",\"du\":89.065284,\"bl\":0,\"pf\":{\"tcp.80\":{\"ob\":406,\"rb\":10260,\"ct\":1}},\"af\":{\"o.rottiesoft.com\":{\"uri\":\"/r/57e563c2c26ec33b00d29f59?&categories=news&categories=technology&categories=business&categories=health&categories=family&categories=deals&categories=local news: bay area&timestamp=1481604653.873280\",\"rqbl\":0,\"rsbl\":32275}},\"flows\":[[1481605987,1481606076,406,10260]]}";


var testurl2 = "{\"ts\":1481597913.210322,\"_ts\":1481597923,\"__ts\":1481597913.210322,\"sh\":\"192.168.2.186\",\"dh\":\"23.197.50.40\",\"ob\":868,\"rb\":0,\"ct\":1,\"fd\":\"in\",\"lh\":\"192.168.2.186\",\"du\":0.048468,\"bl\":900,\"pf\":{\"tcp.80\":{\"ob\":868,\"rb\":0,\"ct\":1}},\"af\":{\"b.scorecardresearch.com\":{\"uri\":\"/p2?c1=19&ns_ap_an=Speedtest&ns_ap_pn=ios&c12=5A4BF4AD9D7DD963777601AD9251F4E9-cs62&name=RotationEnabledTabBarController&ns_ak=none&ns_ap_ec=1&ns_ap_ev=start&ns_ap_device=iPhone9,3&ns_ap_id=1481597913154&ns_ap_csf=1&ns_ap_bi=com.ookla.speedtest&ns_ap_pfm=ios&ns_ap_pfv=10.1.1&ns_ap_ver=3.8.0.56&ns_ap_sv=2.1409.23&ns_type=view&ns_radio=wifi&ns_nc=1&ns_ap_gs=1475190370216&ns_ap_jb=0&ns_ap_res=375x667&ns_ap_install=1478125185875&ns_ap_lastrun=1481589664668&ns_ap_cs=68&ns_ap_runs=68&ns_ap_usage=13&ns_ap_fg=1&ns_ap_ft=45002&ns_ap_dft=45002&ns_ap_bt=0&ns_ap_dbt=0&ns_ap_dit=8203479&ns_ap_as=1&ns_ap_das=45002&ns_ap_it=8203479&ns_ap_lang=en-US&ns_ts=1481597913155\",\"rqbl\":0,\"rsbl\":0}},\"flows\":[[1481597914,1481597914,868,0]]}";

console.log(JSON.stringify(hashFlow(JSON.parse(testurl))));
console.log(JSON.stringify(hashFlow(JSON.parse(testurl2))));
*/

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
};
