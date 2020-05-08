'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;
var FlowManager = require('../net2/FlowManager.js')
var sysManager = require('../net2/SysManager.js');
var flowManager = new FlowManager('info');


var redis = require("redis");
var rclient = redis.createClient();

var fs = require('fs');
var config = JSON.parse(fs.readFileSync('../test/config.json', 'utf8'));

sysManager.setConfig(config);

let ip = "10.0.5.111";
let direction = "in"; // Download
let hours = 8;

flowManager.getRecentConnections(ip, direction, 8, (conns) => {
    console.log("No. of conns: " + conns.length);
    flowManager.groupConnectionsBySourceIP(conns, (groupedConns) => {
	console.log("No. of grouped conns: " + groupedConns.length);
	let head10 = _.first(groupedConns, 10);
	for(let i in head10) {
	    let item = head10[i];
	    console.log(flowManager.toStringShort(item));
	}
    });

})

// rclient.zrange([flowKey,from,to], (err,results)=> {
//     let conns = _.map(results, function(result) {
// 	let o = JSON.parse(result);
//         if (o == null) {
//             log.error("Host:Flows:Sorting:Parsing", result[i]);
//             return undefined;
//         } else {
// 	    return o;
// 	}
//     });
//     let conns2 = _.filter(conns, function(conn) { return conn != undefined });
    
//     // Group results together based on destination, transferred size should sum up.
//     let groupedConns = flowManager.groupConnectionsBySourceIP(conns2, conns3 => {
// 	console.log("Grouped Conns Count: " + conns3.length);
// 	for (let i in conns3) {
// 	    let conn = conns3[i]
// 	    console.log(conn);
// 	}
//     });
// });

