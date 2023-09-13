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

const { exec } = require('child-process-promise');
const _ = require('lodash')

const { IPSET_DOCKER_WAN_ROUTABLE, IPSET_DOCKER_LAN_ROUTABLE, IPSET_MONITORED_NET } = ipset.CONSTANTS


// check ipset and add corrsponding route if network exists in docker
class DockerSensor extends Sensor {

  constructor(config) {
    super(config)
    this.wanRoutable = []
    this.lanRoutable = []
  }

  async listNetworks() {
    const listOutput = await exec('sudo docker network list')
    const lines = listOutput.stdout
      .split('\n')
      .slice(1, -1)
      .map(s => s.split(/\s+/)) // NETWORK ID, NAME, DRIVER, SCOPE
      // .filter(n => n[2] == 'bridge') // only taking care of bridge network for now

    const networks = []
    for (const line of lines) {
      const inspect = await exec(`sudo docker network inspect ${line[1]}`)
      const network = JSON.parse(inspect.stdout)
      networks.push(network[0])
    }

    return networks
  }

  async getInterface(network) {
    const routes = await exec(`ip route`)
    const route = routes.stdout.split('\n').slice(0, -1).find(l => l.startsWith(network))
    if (!route) return null

    return route.match(/dev ([^ ]+) /)[1]
  }

  async addRoute() {
    const active = await exec(`sudo systemctl -q is-active docker`).then(() => true).catch((err) => false);
    if (!active) {
      log.info(`Docker service is not enabled yet`);
      return;
    }
    try {
      const dockerNetworks = await this.listNetworks()
      const userLanNetworks = await ipset.list(IPSET_DOCKER_LAN_ROUTABLE)
      const userWanNetworks = await ipset.list(IPSET_DOCKER_WAN_ROUTABLE)

      for (const network of dockerNetworks) {
        try {
          const subnet = _.get(network, 'IPAM.Config[0].Subnet', null)
          if (!subnet) continue

          const intf = await this.getInterface(subnet)

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
      log.error('Error obtaining network meta', err)
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
