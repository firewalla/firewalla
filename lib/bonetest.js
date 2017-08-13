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
var bone = require("../lib/Bone.js");
let fConfig = require('../net2/config.js').getConfig();
let License = require('../util/license');
let SysManager = require('../net2/SysManager.js');
let sysManager = new SysManager('info');

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

setTimeout(()=>{

     sysManager.getSysInfo((err,_sysinfo) => {
        let license = License.getLicense();
        console.log(license);
        if(err) {
          reject(err);
          return;
        }

        console.log("Checking in Cloud...");

        bone.checkin(fConfig, license, _sysinfo, (err,data) => {
            console.log(data,err);         
        });
      });
},2000);
