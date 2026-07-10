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

'use strict'

let instance = null;
const log = require('../../net2/logger.js')(__filename)

const f = require('../../net2/Firewalla.js')

const fConfig = require('../../net2/config.js').getConfig()

const rclient = require('../../util/redis_manager.js').getRedisClient()

const sysManager = require('../../net2/SysManager')

const rp = require('request-promise')

const exec = require('child-process-promise').exec

const fs = require('fs')
const readFileAsync = fs.promises.readFile
const writeFileAsync = fs.promises.writeFile

// Configurations
const configKey = 'extension.ipv6in4.config'
const tunnelBrokerUpdateURL= 'https://ipv4.tunnelbroker.net/nic/update'
const radvdTemplate = `${__dirname}/radvd.conf.template`
const radvdTempFile = `${f.getUserConfigFolder()}/radvd.conf`
const radvdDestination = "/etc/radvd.conf"

// This extension is used to configure ip6in4 tunnels

class IPV6In4 {
  constructor() {
    if(!instance) {
      this.config = {}
      instance = this      
    }

    return instance
  }

  saveConfig(config) {
    let string = JSON.stringify(config)
    return rclient.setAsync(configKey, string)
  }

  async loadConfig() {
    let json = await rclient.getAsync(configKey)
    if (json) {
      try {
        let config = JSON.parse(json)
        this.config = config
      } catch (err) {
        log.error("Failed to parse config:", json, err);
      }
    }
  }

  // Example:
  //   {
  //   "v4Server": "216.228.221.6",
  //   "v6Client": "2001:477:18:731::2/64",
  //   "v6Local": "2001:477:19:731::1337/64",
  //   "v6Prefix": "2001:477:19:731::/64",
  //   "v6DNS": "2001:477:20:731::2",
  //   "username": "test1",
  //   "password": "pass1",
  //   "tunnelID": "12345",
  //   "updatePublicIP": true
  //   }

  setConfig(config) {
    this.config = config
    return this.saveConfig(this.config)
  }

  hasConfig() {
    return Object.keys(this.config).length !== 0 && this.config.constructor === Object
  }
  
  async updatePublicIP() {
    if(!this.config.username || !this.config.password || !this.config.tunnelID)
      return Promise.reject(new Error("Invalid username/password/tunnelID"))

    log.info("Updating public ip for ipv6in4 tunnel")

    const options = {
      uri: tunnelBrokerUpdateURL,
      followRedirect: false,
      auth: {
        user: this.config.username,
        pass: this.config.password
      },
      qs: {
        hostname: this.config.tunnelID
      }
    }

    log.debug(options)

    const response = await rp.get(options)
    log.debug(response)
  }

  async enableTunnel() {
    log.info("Enabling tunnel...")
    let myip = sysManager.myDefaultWanIp();
    let intf = fConfig.monitoringInterface || "eth0"

    try {
      await exec("sudo ip tunnel del he-ipv6") // drop any existing tunnel
    } catch (err) {
      // do nothing
    }

    if (this.config.v6Client && this.config.v6Local && this.config.v4Server) {
      try {
        await exec(`sudo ip addr del ${this.config.v6Local} dev ${intf}`)
      } catch (err) {
        // do nothing
      }
      await exec(`sudo ip tunnel add he-ipv6 mode sit remote ${this.config.v4Server} local ${myip} ttl 255`)
      await exec(`sudo ip link set he-ipv6 up`)
      await exec(`sudo ip addr add ${this.config.v6Client} dev he-ipv6`)
      await exec(`sudo ip addr add ${this.config.v6Local} dev ${intf}`)
      await exec(`sudo ip route add ::/0 dev he-ipv6`)
    } else {
      return Promise.reject(new Error("Invalid v6Local/v4Server/v6Client"))
    }
  }

  async disableTunnel() {
    log.info("Disabling tunnel...")
    let intf = fConfig.monitoringInterface || "eth0"

    try {
      await exec(`sudo ip addr del ${this.config.v6Local} dev ${intf}`)
    } catch (err) {
      // do nothing
    }

    try {
      await exec("sudo ip tunnel del he-ipv6") // drop any existing tunnel
    } catch (err) {
      // do nothing
    }

  }

  async setupRADVD() {
    log.info("setting up radvd service...")

    if (!this.config.v6Prefix) {
      return Promise.reject(new Error("IPv6 Prefix is required"))
    }

    await exec(`${__dirname}/radvd_install.sh`)

    let data = await readFileAsync(radvdTemplate, { encoding: 'utf8' })
    // replace the placeholders with real values
    data = data.replace("__IPV6_PREFIX__", this.config.v6Prefix)

    let dns = this.config.v6DNS || ""
    data = data.replace("__IPV6_DNS__", dns)

    await writeFileAsync(radvdTempFile, data, { encoding: 'utf8' })

    // node can't write to the destination file directly as it requires 'sudo'
    await exec(`sudo cp ${radvdTempFile} ${radvdDestination}`)
  }

  async start() {
    log.info("Starting ip6in4...")
    await this.loadConfig()
    await this.setupRADVD()
    await exec("sudo systemctl restart radvd")
    await this.enableTunnel()
  }

  async stop() {
    log.info("Stopping ip6in4...")
    try {
      await exec("which radvd && sudo systemctl stop radvd")
      await this.disableTunnel()
    } catch(err) {
      log.error("Failed to stop ip6in4 due to err:", err);
    }
  }
}

module.exports = IPV6In4
