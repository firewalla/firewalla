#!/usr/bin/env node

import { start } from 'repl';

'use strict'

let http = require('http');
let ip = require("ip");

let app = require('../app-pro');
let port = normalizePort(process.env.PRO_PORT || '8835');
app.set('port', port);
let proServer = http.createServer(app);
let started = false;

function startProServer(onlisten) {
    if (!started) {
        proServer.listen(port, ip.address(), () => {started = true; onlisten(true)});
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
