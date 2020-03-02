/*    Copyright 2019 Firewalla Inc
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
'use strict';
const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const ip = require('ip');
class DnsmasqDhcpSensor extends Sensor {
    constructor() {
        super();
    }
    run() {
        sclient.on("message", (channel, message) => {
            if (channel == 'dnsmasq.dhcp.lease') {
                if (message) {
                    try {
                        const host = JSON.parse(message);
                        if (host && host.mac) {
                            this.processHost(host);
                        }
                    } catch (e) {
                        log.warn("Parse dnsmasq.dhcp.lease messge error", e, message)
                    }
                }
            }
        });
        sclient.subscribe("dnsmasq.dhcp.lease");
    }
    processHost(host) {
        const action = host.action;
        if (action == 'del' || !!host.request) return;
        let hostInfo = {
            mac: host.mac,
            from: "dnsmasq.dhcp.lease"
        };
        if (ip.isV4Format(host.ip)) {
            hostInfo.ipv4 = host.ip;
            hostInfo.ipv4Addr = host.ip;
        } else if (ip.isV6Format(host.ip)) {
            hostInfo.ipv6Addr = host.ip
        } else {
            return;
        }
        sem.emitEvent({
            type: "DeviceUpdate",
            message: `Found a device via dnsmasq dhcp lease ${hostInfo.ipv4} ${hostInfo.mac}`,
            host: hostInfo
        });
    }
}

module.exports = DnsmasqDhcpSensor;
