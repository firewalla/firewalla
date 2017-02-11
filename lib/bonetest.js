'use strict'
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
var bone = require("../lib/Bone.js");
/*
setTimeout(() => {
    bone.log("error", {
        msg: "test"
    });
}, 3000);
*/
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
