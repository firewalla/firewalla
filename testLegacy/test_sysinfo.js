'use strict';

let si = require('../extension/sysinfo/SysInfo.js');

(async() => {
  await si.startUpdating();
  console.log(await si.getSysInfo())
  process.exit(0);
})()
