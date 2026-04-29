'use strict'

const sysManager = require('../net2/SysManager.js');

(async () => {
  try {
    await sysManager.waitTillInitialized()
    const inter = sysManager.getDefaultWanInterface()
    console.log("Get Default WanInterface name: ", inter.name);
  } catch(err) {
    console.log("Failed to get Default WanInterface name:", err.statusCode);
  }
  process.exit(0);
})();
