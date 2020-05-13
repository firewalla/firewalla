#!/usr/bin/env node

/*    Copyright 2018-2019 Firewalla INC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */



'use strict'

let http = require('http');
let ip = require("ip");
let os = require('os');
let ifaces = os.networkInterfaces();
let log = require('../../net2/logger')(__filename, "info");

let app = require('../app-pro');
let port = process.env.PRO_PORT || '8832';
app.set('port', port);
let started = false;
let servers = [];

function startProServer(onlisten, onerror) {
    if (!started) {
        Promise.all(Object.keys(ifaces).map(
            (iface) => {
                return new Promise(function(resolve, reject) {
                    let server = http.createServer(app);
                    servers.push(server);
                    server.listen(port, ip.address(iface), resolve);
                })
            }
        ))
        .then(() => {started = true; onlisten(true);})
        .catch(onerror);
    } else {
        onlisten(false);
    }
}

function stopProServer(onstop, onerror) {
    if (started) {
        Promise.all(servers.map(
            (server) => {
                return new Promise(function(resolve, reject) {
                    server.close(resolve);
                })
            }
        ))
        .then(() => {started = false; onstop(true);})
        .catch(onerror);
    } else {
        onstop(false);
    }
}

module.exports = {
    startProServer: startProServer,
    stopProServer: stopProServer
}
