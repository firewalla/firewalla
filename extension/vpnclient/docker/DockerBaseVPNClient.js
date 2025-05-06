/*    Copyright 2016-2025 Firewalla Inc.
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

const log = require('../../../net2/logger.js')(__filename);
const fs = require('fs');
const f = require('../../../net2/Firewalla.js');
const VPNClient = require('../VPNClient.js');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const {Address4, Address6} = require('ip-address');
const {BigInteger} = require('jsbn');
const sysManager = require('../../../net2/SysManager.js');
const YAML = require('../../../vendor_lib/yaml');
const iptables = require('../../../net2/Iptables.js');
const wrapIptables = iptables.wrapIptables;
const routing = require('../../routing/routing.js');
const scheduler = require('../../../util/scheduler.js');
const _ = require('lodash');
const ipUtil = require('../../../util/IPUtil.js');

class DockerBaseVPNClient extends VPNClient {

  _getSubnetFilePath() {
    return `${f.getHiddenFolder()}/run/docker_vpn_client/${this.constructor.getProtocol()}/${this.profileId}.subnet`;
  }

  _getV6SubnetFilePath() {
    return `${f.getHiddenFolder()}/run/docker_vpn_client/${this.constructor.getProtocol()}/${this.profileId}.subnet6`;
  }

  async _getRemoteIP() {
    const subnet = await this._getSubnet();
    if (subnet) {
      return Address4.fromBigInteger(new Address4(subnet).bigInteger().add(new BigInteger("2"))).correctForm(); // IPv4 address of gateway in container always uses second address in subnet
    }
    return null;
  }

  async _getRemoteIP6() {
    const subnet = await this._getSubnet6();
    if (subnet) {
      return Address6.fromBigInteger(new Address6(subnet).bigInteger().add(new BigInteger("2"))).correctForm(); // IPv6 address of gateway in container always uses second address in subnet
    }
    return null;
  }

  async _getSubnet() {
    return await fs.readFileAsync(this._getSubnetFilePath(), {encoding: "utf8"}).then(content => content.trim()).catch((err) => null);
  }

  async _getSubnet6() {
    return await fs.readFileAsync(this._getV6SubnetFilePath(), {encoding: "utf8"}).then(content => content.trim()).catch((err) => null);
  }

  async _getOrGenerateSubnet() {
    let subnet = await this._getSubnet();
    if (!subnet) {
      subnet = this._generateRandomNetwork(); // this returns a /30 subnet
      await fs.writeFileAsync(this._getSubnetFilePath(), subnet, {encoding: "utf8"}).catch((err) => {});
    }
    return subnet;
  }

  async _getOrGenerateV6Subnet() {
    let subnet = await this._getSubnet6();
    if(!subnet) {
      subnet = this._generateRandomV6Network(); // this returns a /64 subnet
      await fs.writeFileAsync(this._getV6SubnetFilePath(), subnet, {encoding: "utf8"}).catch((err) => {});
    }
    return subnet;
  }

  async destroy() {
    await super.destroy();
    await fs.unlinkAsync(this._getSubnetFilePath()).catch((err) => {});
    await exec(`rm -rf ${this._getDockerConfigDirectory()}`).catch((err) => {
      log.error(`Failed to remove config directory ${this._getDockerConfigDirectory()}`, err.message);
    });
    await exec(`sudo rm -f ${this._getSyslogFilePath()}`).catch((err) => {});
    // use sudo to remove directory as some files/directories may be created by root in mapped volume
    await exec(`sudo rm -rf ${this._getWorkingDirectory()}`).catch((err) => {
      log.error(`Failed to remove working directory ${this._getWorkingDirectory()}`, err.message);
    });
  }

  async getVpnIP4s() {
    const subnet = await this._getSubnet();
    if (subnet)
      return Address4.fromBigInteger(new Address4(subnet).bigInteger().add(new BigInteger("1"))).correctForm(); // bridge ipv4 address always uses first address in subnet
  }

  _generateRandomNetwork() {
    const ipRangeRandomMap = {
      "10.0.0.0/8": 22,
      "172.16.0.0/12": 18,
      "192.168.0.0/16": 14
    };
    let index = 0;
    while (true) {
      index = index % 3;
      const startAddress = Object.keys(ipRangeRandomMap)[index]
      const randomBits = ipRangeRandomMap[startAddress];
      const randomOffsets = Math.floor(Math.random() * Math.pow(2, randomBits)) * 4; // align with 2-bit, i.e., /30
      const subnet = Address4.fromBigInteger(new Address4(startAddress).bigInteger().add(new BigInteger(randomOffsets.toString()))).correctForm();
      if (!sysManager.inMySubnets4(subnet))
        return subnet + "/30";
      else
        index++;
    }
  }

  _generateRandomV6Network() {
    // private cidr: fc00::/7
    // firewalla use prefix for vpn: fc20:6d31:random:1::/64
    let index = 0;
    while (true) {
      if (index > 100) {
        log.error("Failed to generate random network");
        return null;
      }

      const randomBits = 16;
      const randomAddr = Math.floor(Math.random() * Math.pow(2, randomBits));
      const randomAddrHex = randomAddr.toString(16);
      const subnet = `fc20:6d31:${randomAddrHex}:1::/64`;
      if (!sysManager.inMySubnet6(subnet))
        return subnet;
      else
        index++;
    }
  }

  async _createNetwork() {
    // sudo docker network create -o "com.docker.network.bridge.name"="vpn_sslx" --subnet 10.53.204.108/30 vpn_sslx
    try {
      log.verbose(`Creating network ${this._getDockerNetworkName()} for vpn ${this.profileId} ...`);
      const subnet = await this._getOrGenerateSubnet();
      const ipv6 = this.isIPv6Enabled();

      if (ipv6) {
        const subnet6 = await this._getOrGenerateV6Subnet();
        if (subnet6) {
          const cmd = `sudo bash -c "docker network inspect ${this._getDockerNetworkName()} || docker network create -o com.docker.network.bridge.name=${this.getInterfaceName()} --subnet ${subnet} --ipv6 --subnet ${subnet6} ${this._getDockerNetworkName()}" &>/dev/null`;
          await exec(cmd);
          return;
        }
      }

      // fallback to ipv4 only, if ipv6 is not enabled or not able to generate usable ipv6 subnet
      const cmd = `sudo bash -c "docker network inspect ${this._getDockerNetworkName()} || docker network create -o com.docker.network.bridge.name=${this.getInterfaceName()} --subnet ${subnet} ${this._getDockerNetworkName()}" &>/dev/null`;
      await exec(cmd);
    } catch(err) {
      log.error(`Got error when creating network ${this._getDockerNetworkName()} for ${this.profileId}, err:`, err.message);
    }
  }

  async _removeNetwork() {
    try {
      const cmd = `sudo docker network rm ${this._getDockerNetworkName()}`;
      await exec(cmd);
    } catch(err) {
      log.error(`Got error when rm network ${this._getDockerNetworkName()} for ${this.profileId}, err:`, err.message);
    }
  }

  getContainerName() {
    return this.getInterfaceName();
  }

  _getDockerNetworkName() {
    return `n_${this.getInterfaceName()}`;
  }

  async _updateComposeYAML() {
    const composeFilePath = this._getWorkingDirectory() + "/docker-compose.yaml";
    const config = await fs.readFileAsync(composeFilePath, {encoding: "utf8"}).then(content => YAML.parse(content)).catch((err) => {
      log.error(`Failed to read docker-compose.yaml from ${composeFilePath}`, err.message);
      return;
    });

    // update network config
    if (!config) {
      log.error("docker compose template file not found")
      return;
    }

    config.networks = {};
    config.networks[this._getDockerNetworkName()] = {external: true};

    const serviceNames = Object.keys(config.services);
    if(!_.isEmpty(serviceNames) && serviceNames.length === 1) {
      const serviceName = serviceNames[0];
      const service = config.services[serviceName];
      service.networks = {};
      service.networks[this._getDockerNetworkName()] = {
        "ipv4_address": await this._getRemoteIP()
      }

      service["container_name"] = this.getContainerName();

      if (this.isIPv6Enabled()) {
        service["sysctls"] = {
          "net.ipv6.conf.all.disable_ipv6": 0,
          "net.ipv6.conf.all.forwarding": 1
        };
      }

      // set host subnets in environmental variables
      let hostSubnets4 = [];
      let hostSubnets6 = [];
      for (const i of sysManager.getMonitoringInterfaces().filter(i => i.type === "lan")) {
        if (_.isArray(i.ip4_subnets)) {
          const subnets4 = i.ip4_subnets.map(s => {
            const addr = new Address4(s);
            return `${addr.startAddress().correctForm()}/${addr.subnetMask}`;
          });
          hostSubnets4 = hostSubnets4.concat(subnets4);
        }
        if (_.isArray(i.ip6_subnets)) {
          const subnets6 = i.ip6_subnets.map(s => {
            const addr = new Address6(s);
            return `${addr.startAddress().correctForm()}/${addr.subnetMask}`;
          });
          hostSubnets6 = hostSubnets6.concat(subnets6.filter(ip6 => ipUtil.isPublic(ip6)));
        }
      }
      if (service.hasOwnProperty("environment") && (_.isObject(service["environment"]) || _.isArray(service["environment"]))) {
        const env = service["environment"];
        if (_.isObject(service["environment"])) {
          if (!_.isEmpty(hostSubnets4))
            env["HOST_SUBNETS4"] = hostSubnets4.join(",");
          if (!_.isEmpty(hostSubnets6))
            env["HOST_SUBNETS6"] = hostSubnets6.join(",");
        } else {
          if (!_.isEmpty(hostSubnets4))
            env.push(`HOST_SUBNETS4=${hostSubnets4.join(",")}`);
          if (!_.isEmpty(hostSubnets6))
            env.push(`HOST_SUBNETS6=${hostSubnets6.join(",")}`);
        }
      } else {
        const env = {}
        if (!_.isEmpty(hostSubnets4))
          env["HOST_SUBNETS4"] = hostSubnets4.join(",");
        if (!_.isEmpty(hostSubnets6))
          env["HOST_SUBNETS6"] = hostSubnets6.join(",");
        if (!_.isEmpty(env))
          service["environment"] = env;
      }
      // use dedicated tag for syslog so as to redirect to dedicated log file
      service["logging"] = {
        driver: "syslog",
        options: {
          tag: `docker_vpn_${this.profileId}`
        }
      }

      // do not automatically restart container
      // set restart to "no" will cause docker compose yml parsing error
      //     "restart contains an invalid type, it should be a string"
      if(service["restart"]) delete service["restart"];

      await fs.writeFileAsync(composeFilePath, YAML.stringify(config), {encoding: "utf8"});

    } else {
      log.error("docker compose should only contain one service")
    }
  }

  _getSyslogFilePath() {
    return `/var/log/docker_vpn_${this.profileId}.log`;
  }

  async _createRsyslogConf() {
    const content = `
if $programname == 'bash' and $msg contains 'vpn_' then {
  stop
}
if $programname == 'docker_vpn_${this.profileId}' then {
  ${this._getSyslogFilePath()}
  stop
}`;
    const tempConfPath = `${this._getDockerConfigDirectory()}/40-docker_vpn_${this.profileId}.conf`;
    await fs.writeFileAsync(tempConfPath, content, {encoding: "utf8"});
    await exec(`sudo cp ${tempConfPath} /etc/rsyslog.d/`).catch((err) => {});
    await fs.unlinkAsync(tempConfPath).catch((err) => {});
    await sysManager.restartRsyslog().catch((err) => {});
  }

  async _removeRsyslogConf() {
    await exec(`sudo rm /etc/rsyslog.d/40-docker_vpn_${this.profileId}.conf`).catch((err) => {});
    await sysManager.restartRsyslog().catch((err) => {});
  }

  async _testAndStartDocker() {
    const active = await exec(`sudo systemctl -q is-active docker`).then(() => true).catch((err) => false);
    if (!active) {
      // starting docker service will load br_netfilter, it may cause problem with QoS enabled which uses act_mirred.ko to redirect packets to ifb
      // fixed act_mirred.ko is only available on dev branch now
      const brNetfilterLoaded = await exec(`lsmod | grep -w br_netfilter`).then(() => true).catch((err) => false);
      await exec(`sudo systemctl start docker`).catch((err) => {});
      if (!brNetfilterLoaded)
        await exec(`sudo rmmod br_netfilter`).catch((err) => {});
    }
  }

  async _start() {
    await this._testAndStartDocker();
    await exec(`mkdir -p ${this._getDockerConfigDirectory()}`);
    await this.__prepareAssets();
    await exec(`mkdir -p ${this._getWorkingDirectory()}`);
    await exec(`cp -f -a ${this._getDockerConfigDirectory()}/. ${this._getWorkingDirectory()}`);
    await this._createNetwork();
    await this._updateComposeYAML();
    await this._createRsyslogConf();
    await exec(`sudo systemctl start docker-compose@${this.profileId}`);
    const remoteIP = await this._getRemoteIP();
    const remoteIP6 = await this._getRemoteIP6();
    if (remoteIP)
      await exec(wrapIptables(`sudo iptables -w -t nat -A FW_POSTROUTING -s ${remoteIP} -j MASQUERADE`));
    if (remoteIP6)
      await exec(wrapIptables(`sudo ip6tables -w -t nat -A FW_POSTROUTING -s ${remoteIP6} -j MASQUERADE`));
    let t = 0;
    while (t < 30) {
      const carrier = await fs.readFileAsync(`/sys/class/net/${this.getInterfaceName()}/carrier`, {encoding: "utf8"}).then(content => content.trim()).catch((err) => null);
      if (carrier === "1") {
        const remoteIP = await this._getRemoteIP();
        const remoteIP6 = await this._getRemoteIP6();
        if (remoteIP) {
          // add the container IP to wan_routable so that packets from wan interfaces can be routed to the container
          await routing.addRouteToTable(remoteIP, null, this.getInterfaceName(), "wan_routable", 1024, 4);
        }
        if (remoteIP6) {
          await routing.addRouteToTable(remoteIP6, null, this.getInterfaceName(), "wan_routable", 1024, 6);
        }
        break;
      }
      t++;
      await scheduler.delay(1000);
    }
  }

  async _stop() {
    await this._testAndStartDocker();
    const remoteIP = await this._getRemoteIP();
    const remoteIP6 = await this._getRemoteIP6();
    if (remoteIP)
      await exec(wrapIptables(`sudo iptables -w -t nat -D FW_POSTROUTING -s ${remoteIP} -j MASQUERADE`)).catch((err) => {});
    if (remoteIP6)
      await exec(wrapIptables(`sudo ip6tables -w -t nat -D FW_POSTROUTING -s ${remoteIP6} -j MASQUERADE`)).catch((err) => {});
    await exec(`sudo systemctl stop docker-compose@${this.profileId}`);
    await this._removeNetwork();
    await this._removeRsyslogConf();
  }

  async getRoutedSubnets() {
    const subnets = await super.getRoutedSubnets() || [];
    // no need to add the whole subnet to the routed subnets, only need to route the container's IP address
    const remoteIP = await this._getRemoteIP();
    if (remoteIP)
      subnets.push(remoteIP);
    const remoteIP6 = await this._getRemoteIP6();
    if (remoteIP6)
      subnets.push(remoteIP6);
    const results = _.uniq(subnets);
    return results;
  }

  _getWorkingDirectory() {
    return `${f.getHiddenFolder()}/run/docker/${this.profileId}`;
  }

  _getDockerConfigDirectory() {
    return `${f.getHiddenFolder()}/run/docker_vpn_client/${this.constructor.getProtocol()}/${this.profileId}`;
  }

  async _isLinkUp() {
    const active = await exec(`sudo systemctl -q is-active docker`).then(() => true).catch((err) => false);
    if (!active)
      return false;
    const serviceUp = await exec(`sudo docker container ls -f "name=${this.getInterfaceName()}" --format "{{.Status}}"`).then(result => result.stdout.trim().startsWith("Up ")).catch((err) => {
      log.error(`Failed to run docker container ls on ${this.profileId}`, err.message);
      return false;
    });
    if (serviceUp)
      return this.__isLinkUpInsideContainer().catch(() => false);
    else
      return false;
  }

  async getAttributes(includeContent = false) {
    const attributes = await super.getAttributes(includeContent);
    attributes.dnsPort = this.getDNSPort();
    return attributes;
  }

  // this needs to be implemented by child class
  async __isLinkUpInsideContainer() {
    return true;
  }

  // docker-based vpn client need to implement this function to fetch files and put them to config directory, e.g., docker-compose.yaml, corresponding files/directories to be mapped as volumes,
  // they will be put in the same directory so relative path can still be used in docker-compose
  async __prepareAssets() {

  }

  // this needs to be implemented by child class
  async _getDNSServers() {
    
  }

  // this needs to be implemented by child class
  static getProtocol() {
    
  }

  // only usable when this docker is configured to be DNS upstream server
  getDNSPort() {
    return 53;
  }

  // this is the effective interface that should be used for statistics collection
  // this is the actual VPN interface that's created by VPN interface
  getEffectiveInterface() {
    return "eth0";
  }

  async _getInterfaceStatistics(container, intf, item) {
    try {
      const cmd = `sudo docker exec ${container} cat /sys/class/net/${intf}/statistics/${item}`;
      const output = await exec(cmd);
      const stdout = output.stdout;
      return Number(stdout.trim());
    } catch(err) {
      log.error("Got error when getting statistics on", container, intf, item, "err:", err);
      return 0;
    }
  }

  async getStatistics() {
    const status = await this.status();
    if (!status)
      return {};

    const intf = this.getEffectiveInterface();
    const container = this.getContainerName();
    const rxBytes = await this._getInterfaceStatistics(container, intf, "rx_bytes");
    const txBytes = await this._getInterfaceStatistics(container, intf, "tx_bytes");
    return {bytesIn: rxBytes, bytesOut: txBytes};
  }

  async _prepareDockerCompose(obj) {
    log.verbose("Preparing docker compose file...");
    let content = null;
    if (!_.isEmpty(obj)) {
      content = YAML.stringify(obj);
    } else {
      const src = `${__dirname}/${this.constructor.getProtocol()}/docker-compose.template.yaml`;
      content = await fs.readFileAsync(src, {encoding: 'utf8'});
    }
    const dst = `${this._getDockerConfigDirectory()}/docker-compose.yaml`;
    log.verbose("Writing config file", dst);
    await fs.writeFileAsync(dst, content);
  }

  async getLatestSessionLog() {
    const logPath = `/var/log/docker_vpn_${this.profileId}.log`;
    const content = await exec(`sudo tail -n 200 ${logPath}`).then(result => result.stdout.trim()).catch((err) => null);
    return content;
  }
}

module.exports = DockerBaseVPNClient;
