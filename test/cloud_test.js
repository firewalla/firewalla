'use strict'
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

if(typeof global.it === 'function') {
  return;
}

var bone = require("../lib/Bone.js");
let fConfig = require('../net2/config.js').getConfig();
let License = require('../util/license');
let sysManager = require('../net2/SysManager.js');
let sampledata = require("../tests/sample_data_intel.js");


/*
setTimeout(() => {
    bone.log("error", {
        msg: "test"
    });
}, 3000);
*/
/*
setTimeout(() => {
//    bone.device("identify", {});
    //bone.intel("*", "check", {iplist:[ 'www.slackbitch.com', '103.224.182.253' ]});
    bone.hashset("ad_cn",(err,data)=>{
//	console.log(typeof(data));
      let d = JSON.parse(data)
      for(let e in d) {
        console.log(d[e]);
      }
    });
}, 5000);
*/

let json5 = { "amazon": [{ "ts": 1511239185.653653, "duration": 60.269816, "download": 5828, "upload": 2032, "device": "C4:6E:1F:B8:2F:CF" }], "wechat": [{ "ts": 1511238181.565235, "duration": 13.044583000000003, "download": 19450, "upload": 26790, "device": "C4:6E:1F:B8:2F:CF" }], "apple": [{ "ts": 1511240375.368552, "duration": 182.700539, "download": 40009, "upload": 10517, "device": "1C:B7:2C:CB:49:D8" }, { "ts": 1511240375.368552, "duration": 182.700539, "download": 24639, "upload": 4924, "device": "1C:B7:2C:CB:49:D8" }, { "ts": 1511240216.621522, "duration": 939.97332, "download": 11895, "upload": 4883, "device": "1C:B7:2C:CB:49:D8" }, { "ts": 1511239616.040772, "duration": 282.819671, "download": 771274, "upload": 1477803, "device": "1C:B7:2C:CB:49:D8" }, { "ts": 1511239058.672544, "duration": 31.134557, "download": 9415, "upload": 6999, "device": "C4:6E:1F:B8:2F:CF" }, { "ts": 1511239015.325777, "duration": 224.835413, "download": 1393362, "upload": 219943, "device": "1C:B7:2C:CB:49:D8" }, { "ts": 1511238815.83526, "duration": 30.936797, "download": 41231, "upload": 9627, "device": "1C:B7:2C:CB:49:D8" }, { "ts": 1511238387.901921, "duration": 44.703212, "download": 340, "upload": 154, "device": "C8:69:CD:09:95:4C" }, { "ts": 1511238145.391342, "duration": 136.75805, "download": 538424, "upload": 120961, "device": "1C:B7:2C:CB:49:D8" }, { "ts": 1511238145.391342, "duration": 182.357306, "download": 546097, "upload": 123758, "device": "1C:B7:2C:CB:49:D8" }, { "ts": 1511238143.915056, "duration": 289.982515, "download": 19801, "upload": 34933, "device": "C4:6E:1F:B8:2F:CF" }, { "ts": 1511238117.779618, "duration": 331.434874, "download": 1276446, "upload": 126146, "device": "C4:6E:1F:B8:2F:CF" }, { "ts": 1511237776.917097, "duration": 31.289184, "download": 7518, "upload": 186, "device": "1C:B7:2C:CB:49:D8" }, { "ts": 1511237767.700196, "duration": 354.497202, "download": 1273980, "upload": 128467, "device": "C4:6E:1F:B8:2F:CF" }, { "ts": 1511237323.671664, "duration": 436.157393, "download": 25788, "upload": 7891, "device": "C4:6E:1F:B8:2F:CF" }, { "ts": 1511236867.122898, "duration": 66.659174, "download": 149060, "upload": 36843, "device": "1C:B7:2C:CB:49:D8" }], "pinterest": [], "twitter": [], "youtube": [{ "ts": 1511239838.565904, "duration": 122.958273, "download": 0, "upload": 2021, "device": "00:0C:29:67:89:F0" }, { "ts": 1511239662.88185, "duration": 75.740424, "download": 63, "upload": 0, "device": "C4:6E:1F:B8:2F:CF" }, { "ts": 1511237005.39362, "duration": 5.961487, "download": 13315, "upload": 6506, "device": "78:4F:43:97:C0:0C" }], "linkedin": [], "netflix": [], "facebook": [{ "ts": 1511237602.239275, "duration": 33.111298, "download": 5015, "upload": 904, "device": "C4:6E:1F:B8:2F:CF" }], "yahoo": [], "snapchat": [], "instagram": [] }

let flowUtil = require("../net2/FlowUtil.js");

setTimeout(()=>{

     sysManager.getSysInfo((err,_sysinfo) => {
        let license = License.getLicense();
        console.log(license);
        if(err) {
          reject(err);
          return;
        }

        console.log("Checking in Cloud...");

        bone.checkin(fConfig.version, license, _sysinfo, (err,data) => {
            console.log(data,err);
            let mac = "9C:AD:EF:01:02:03";
            let rawData = {
                ou: mac.slice(0,13), // use 0,13 for better OU compatibility
                uuid: flowUtil.hashMac(mac)
            };
    bone.log("error", {
        msg: "Bone Log Test"
    }, (err,data)=> {
              //  bone.getLicense("81244056-90b9-43f3-a5ae-8681bde09e58","thisismac",(err,data)=>{
              //      console.log(err,data);
              //  });
                 console.log(" ===== TEST INTEL ===");

                 let sdata = {flowlist:sampledata.netflix, hashed:1};

                 bone.intel("*","check",sdata, (err, data) => {
                     console.log("================= JERRY ++",err,data);
                     console.log(data);
                  
                 });
/*
                 bone.flowgraph("summarizeApp", json5,(err,data)=>{
                     console.log(data);
                 });
*/

            });


        });
      });
},2000);
