/*    Copyright 2020-2021 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename, 'info');
const { Sensor } = require('./Sensor.js');
const ipset = require('../net2/Ipset.js');
const routing = require('../extension/routing/routing')
const platform = require('../platform/PlatformLoader.js').getPlatform();
const sysManager = require('../net2/SysManager')

const fsp = require('fs').promises;
const { execFile } = require('child-process-promise');
const _ = require('lodash')

// /proc/net/route stores Destination/Mask as 32-bit hex in the platform's native
// byte order; reverse the byte pairs to get the usual dotted-decimal form
function procRouteHexToIp(hex) {
  const bytes = [];
  for (let i = 0; i < 8; i += 2) bytes.unshift(parseInt(hex.substr(i, 2), 16));
  return bytes.join('.');
}
function procRouteMaskToPrefixLen(hex) {
  const bytes = [];
  for (let i = 0; i < 8; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  return bytes.reduce((bits, b) => bits + b.toString(2).split('1').length - 1, 0);
}

const { IPSET_DOCKER_WAN_ROUTABLE, IPSET_DOCKER_LAN_ROUTABLE, IPSET_MONITORED_NET } = ipset.CONSTANTS


// check ipset and add corrsponding route if network exists in docker
class DockerSensor extends Sensor {

  constructor(config) {
    super(config)
    this.wanRoutable = []
    this.lanRoutable = []
  }

  async listNetworks() {
    const listOutput = await execFile('sudo', ['docker', 'network', 'ls', '--format', '{{.Name}}'])
    const names = listOutput.stdout.split('\n').map(s => s.trim()).filter(Boolean)
    if (!names.length) return []

    const inspectOutput = await execFile('sudo', ['docker', 'network', 'inspect', ...names])
    return JSON.parse(inspectOutput.stdout)
  }

  async getRouteLines() {
    const content = await fsp.readFile('/proc/net/route', { encoding: 'utf8' })
    return content.split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(cols => cols.length >= 8)
  }

  async getInterface(network, routeLines) {
    const lines = routeLines || await this.getRouteLines()
    const row = lines.find(cols => `${procRouteHexToIp(cols[1])}/${procRouteMaskToPrefixLen(cols[7])}` === network)
    return row ? row[0] : null
  }

  async addRoute() {
    const active = await execFile('sudo', ['systemctl', '-q', 'is-active', 'docker']).then(() => true).catch((err) => false);
    if (!active) {
      log.info(`Docker service is not enabled yet`);
      return;
    }
    try {
      const dockerNetworks = await this.listNetworks()
      const userLanNetworks = await ipset.list(IPSET_DOCKER_LAN_ROUTABLE)
      const userWanNetworks = await ipset.list(IPSET_DOCKER_WAN_ROUTABLE)
      const routeLines = await this.getRouteLines()

      for (const network of dockerNetworks) {
        try {
          const subnet = _.get(network, 'IPAM.Config[0].Subnet', null)
          if (!subnet) continue

          const intf = await this.getInterface(subnet, routeLines)

          if (userLanNetworks.includes(subnet)) {
            await routing.addRouteToTable(subnet, undefined, intf, 'lan_routable')
            await routing.createPolicyRoutingRule('all', intf, 'lan_routable', 5003)
          }
          if (userWanNetworks.includes(subnet)) {
            await routing.addRouteToTable(subnet, undefined, intf, 'wan_routable', 1024)
          }
        } catch(err) {
          log.error('Error adding route', network, err)
        }
      }
    } catch(err) {
      log.error('Error obtaining network meta', err.message)
    }
  }

  async run() {
    if (!platform.isDockerSupported())
      return;

    try {
      await sysManager.waitTillIptablesReady()
      await ipset.create(IPSET_DOCKER_WAN_ROUTABLE, 'hash:net')
      await ipset.create(IPSET_DOCKER_LAN_ROUTABLE, 'hash:net')
      await ipset.add(IPSET_MONITORED_NET, IPSET_DOCKER_LAN_ROUTABLE)

      await this.addRoute()
      setInterval(this.addRoute.bind(this), 120 * 1000)
    } catch(err) {
      log.error("Failed to initialize DockerSensor", err)
    }
  }
}

module.exports = DockerSensor;
