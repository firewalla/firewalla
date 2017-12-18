// requirement: 
//    npm install bonjour
// node find_firewalla.js

'use strict'
let bonjour = require('bonjour')();

bonjour.find({type: 'http'}, (service) => {
  // console.log(service);
  if(service.name.startsWith("eph:devhi:netbot") &&
      service.referer && service.referer.address
  ) {
    console.log("Found firewalla device: ", service.referer.address);
      console.log(service)
    setTimeout(() => process.exit(0), 3000);
  }
});
