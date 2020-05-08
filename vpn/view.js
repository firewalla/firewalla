'use strict';

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