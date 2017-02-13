var SysManager = require('../net2/SysManager.js');
var sysManager = new SysManager('info');

var fs = require('fs');
var config = JSON.parse(fs.readFileSync('../net2/config.json', 'utf8'));

var Firewalla = require('../net2/Firewalla.js');
var f = new Firewalla("config.json", 'info');
f.redisclean(config);
setTimeout(()=> {
   console.log("Redis Clean done in 10 Seconds");
   process.exit(0);
},1000*20);
