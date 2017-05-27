'use strict'

let DhcpDump = require("./dhcpdump.js");

let dhcpDump = new DhcpDump();
dhcpDump.start(false,()=>{});
