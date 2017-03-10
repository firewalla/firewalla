var SysManager = require('../net2/SysManager.js');
var sysManager = new SysManager('info');

var fs = require('fs');
var config = JSON.parse(fs.readFileSync('../net2/config.json', 'utf8'));
var firewalla = require('../net2/Firewalla.js');
firewalla.redisclean(config,10000);
setTimeout(()=> {
   console.log("Redis Clean done in 20 Seconds");
   process.exit(0);
},1000*20);
