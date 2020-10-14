'use strict';

const sysManager = require('../net2/SysManager.js');

sysManager.waitTillInitialized().then(() => {
  const UPNP = require('../extension/upnp/upnp.js');
  const upnp = new UPNP();
  
  setInterval(() => {
    upnp.getExternalIP().then((ip) => {
      console.log(ip);
    }).catch((err) => {});
    upnp.getPortMappingsUPNP().then((results) => {
      console.log(results);
    })
  }, 5000);
});