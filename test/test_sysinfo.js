'use strict';
let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect;

let si = require('../extension/sysinfo/SysInfo.js');

si.startUpdating();
//si.getRealMemoryUsage();

si.getRecentLogs((err, results) => {
  console.log(results);
});

setTimeout(() => {
  console.log(si.getSysInfo());
  process.exit(0);
}, 3000);
