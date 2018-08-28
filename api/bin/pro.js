#!/usr/bin/env node

'use strict'

let http = require('http');
let ip = require("ip");
let log = require('../../net2/logger')(__filename, "info");

let app = require('../app-pro');
let port = process.env.PRO_PORT || '8832';
app.set('port', port);
let proServer = http.createServer(app);
let started = false;
let iface = process.env.NETWORK_INTERFACE || 'eth0'

function startProServer(onlisten) {
    if (!started) {
        proServer.listen(port, ip.address(iface), () => {
            started = true;
            log.info('Pro API listening on ', ip.address(iface), port);
            onlisten(true)
        });
    } else {
        onlisten(false);
    }
}

function stopProServer(onstop) {
    if (started) {
        proServer.close(() => {started = false; onstop(true);});
    } else {
        onstop(false);
    }
}

module.exports = {
    startProServer: startProServer,
    stopProServer: stopProServer
}
