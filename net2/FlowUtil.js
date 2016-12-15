'use strict'

const urlHash = require('../util/UrlHash.js')
/*
module.exports = {
    canonicalizeAndHashExpressions: canonicalizeAndHash,
    hashBase64: hashBase64
};*/

function hashFlow(_flow) {
    let flow = JSON.parse(JSON.stringify(_flow));
    if (flow!=null && flow.af!=null && Object.keys(flow.af).length>0) {
        let _af = {};
        for (let key in flow.af) {
            let afe = flow.af[key]; 
            let hashedKey = urlHash.hashBase64(key);
            _af[hashedKey] = afe;
            afe.uri = urlHash.canonicalizeAndHashExpressions(key+afe.uri);
        }
        delete flow.af;
        flow._af = _af;
    }

    if (flow.mac) {
        delete flow.mac;
    }
    if (flow.shname) {
        delete flow.shname;
    }

    return flow;
    // Hash other things ...
}


/*
var testurl = "{\"ts\":1481605986.064498,\"sh\":\"192.168.2.186\",\"_ts\":1481606086,\"dh\":\"54.183.55.161\",\"ob\":406,\"rb\":10260,\"ct\":1,\"fd\":\"in\",\"lh\":\"192.168.2.186\",\"du\":89.065284,\"bl\":0,\"pf\":{\"tcp.80\":{\"ob\":406,\"rb\":10260,\"ct\":1}},\"af\":{\"o.rottiesoft.com\":{\"uri\":\"/r/57e563c2c26ec33b00d29f59?&categories=news&categories=technology&categories=business&categories=health&categories=family&categories=deals&categories=local news: bay area&timestamp=1481604653.873280\",\"rqbl\":0,\"rsbl\":32275}},\"flows\":[[1481605987,1481606076,406,10260]]}";


var testurl2 = "{\"ts\":1481597913.210322,\"_ts\":1481597923,\"__ts\":1481597913.210322,\"sh\":\"192.168.2.186\",\"dh\":\"23.197.50.40\",\"ob\":868,\"rb\":0,\"ct\":1,\"fd\":\"in\",\"lh\":\"192.168.2.186\",\"du\":0.048468,\"bl\":900,\"pf\":{\"tcp.80\":{\"ob\":868,\"rb\":0,\"ct\":1}},\"af\":{\"b.scorecardresearch.com\":{\"uri\":\"/p2?c1=19&ns_ap_an=Speedtest&ns_ap_pn=ios&c12=5A4BF4AD9D7DD963777601AD9251F4E9-cs62&name=RotationEnabledTabBarController&ns_ak=none&ns_ap_ec=1&ns_ap_ev=start&ns_ap_device=iPhone9,3&ns_ap_id=1481597913154&ns_ap_csf=1&ns_ap_bi=com.ookla.speedtest&ns_ap_pfm=ios&ns_ap_pfv=10.1.1&ns_ap_ver=3.8.0.56&ns_ap_sv=2.1409.23&ns_type=view&ns_radio=wifi&ns_nc=1&ns_ap_gs=1475190370216&ns_ap_jb=0&ns_ap_res=375x667&ns_ap_install=1478125185875&ns_ap_lastrun=1481589664668&ns_ap_cs=68&ns_ap_runs=68&ns_ap_usage=13&ns_ap_fg=1&ns_ap_ft=45002&ns_ap_dft=45002&ns_ap_bt=0&ns_ap_dbt=0&ns_ap_dit=8203479&ns_ap_as=1&ns_ap_das=45002&ns_ap_it=8203479&ns_ap_lang=en-US&ns_ts=1481597913155\",\"rqbl\":0,\"rsbl\":0}},\"flows\":[[1481597914,1481597914,868,0]]}";

console.log(JSON.stringify(hashFlow(JSON.parse(testurl))));
console.log(JSON.stringify(hashFlow(JSON.parse(testurl2))));
*/


module.exports = {
  hashFlow: hashFlow
};
