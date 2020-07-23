/*    Copyright 2016 Firewalla LLC
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

const log = require("../../net2/logger")('diag');

const express = require('express');
const path = require('path');

const port = 8835

const Promise = require('bluebird')

const exec = require('child-process-promise').exec
const fs = require('fs')
Promise.promisifyAll(fs)
const http = require('http');

const Config = require('../../net2/config.js');
const sysManager = require('../../net2/SysManager.js');
const Message = require('../../net2/Message.js');

const jsonfile = require('jsonfile');
const writeFileAsync = Promise.promisify(jsonfile.writeFile);

const { wrapIptables } = require('../../net2/Iptables.js')

const sem = require('../../sensor/SensorEventManager.js').getInstance();

const platformLoader = require('../../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const Mode = require('../../net2/Mode.js');

const VIEW_PATH = 'view';
const STATIC_PATH = 'static';

const errorCodes = {
  "firekick": 101,
  "firemain": 102,
  "fireapi": 103,
  "firemon": 104,
  "memory": 201,
  "database": 301,
  "databaseConnectivity": 302,
  "gid": 401,
  "ip": 501
}

class App {
  constructor() {
    this.servers = [];
    this.app = express();

    this.app.engine('mustache', require('mustache-express')());
    this.app.set('view engine', 'mustache');

    this.app.set('views', path.join(__dirname, VIEW_PATH));
    //this.app.disable('view cache'); //for debug only

    this.routes();

    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      if (this._started)
        this.scheduleRebindServerInstances();
    });

    sem.on("DiagRedirectionRenew", (event) => {
      if (this._started) {
        log.info("Renew port redirection")
        this.iptablesRedirection();
      }
    });
  }

  getSystemTime() {
    return new Date() / 1000
  }

  async getSystemServices() {
    const fireKickCmd = "systemctl is-active firekick"
    const fireMainCmd = "systemctl is-active firemain"
    const fireApiCmd = "systemctl is-active fireapi"
    const fireMonCmd = "systemctl is-active firemon"

    try {
      await exec(fireKickCmd)
    } catch (err) {
      log.error("firekick is not alive", err);
      return errorCodes.firekick
    }

    try {
      await exec(fireMainCmd)
    } catch (err) {
      log.error("firemain is not alive", err);
      return errorCodes.firemain
    }

    try {
      await exec(fireApiCmd)
    } catch (err) {
      log.error("fireapi is not alive", err);
      return errorCodes.fireapi
    }

    try {
      await exec(fireMonCmd)
    } catch (err) {
      log.error("firemon is not alive", err);
      return errorCodes.firemon
    }

    return 0
  }

  async getFireResetStatus() {
    try {
      await exec("systemctl is-active firereset")
    } catch(err) {
      log.error("firereset is not active", err);
      return 1;
    }

    try {
      const result = await exec("hcitool -i hci0 dev | wc -l")
      if (result.stdout.replace("\n", "") !== "2") {
        return 6;
      }
    } catch(err) {
      log.error("bluetooth not found");
      return 5;
    }

    try {
      await exec("tail -n 8 /home/pi/.forever/firereset.log | grep 'Invalid Bluetooth'")
      log.error("Invalid bluetooth plugged in");
      return 2;
    } catch(err) {
    }

    try {
      await exec("tail -n 8 /home/pi/.forever/firereset.log | grep 'Failed to start service'")
      log.error("Likely bluetooth not plugged in");
      return 3;
    } catch(err) {
    }

    try {
      await exec("tail -n 8 /home/pi/.forever/firereset.log | grep 'can\'t read hci socket'")
      log.error("Unknown error");
      return 4;
    } catch(err) {
    }

    return 0;
  }

  getCloudConnectivity() {
    return this.connected
  }

  async getSystemMemory() {
    const result = await exec("free -m")
    const stdout = result.stdout
    const lines = stdout.split(/\n/g)

    for (var i = 0; i < lines.length; i++) {
      lines[i] = lines[i].split(/\s+/)
    }

    const allMem = parseInt(lines[1][1])

    if (allMem > 490) {
      return 0
    } else {
      return errorCodes.memory
    }
  }

  getNodeVersion() {
    return process.version
  }

  getUptime() {
    return require('os').uptime()
  }

  async getDatabase() {
    try {
      await exec("systemctl is-active redis-server")
    } catch (err) {
      log.error("Failed to check database", err);
      return errorCodes.database
    }

    return 0
  }

  async getDatabaseConnectivity() {
    try {
      await exec("redis-cli get mode")
    } catch (err) {
      log.error("Failed to check database connection status", err);
      return errorCodes.databaseConnectivity
    }
    return 0
  }

  async getGID() {
    try {
      const gid = await exec("redis-cli hget sys:ept gid")
      return gid && gid.stdout && gid.stdout.substring(0, 8)
    } catch (err) {
      log.error("Failed to get gid", err);
      return null
    }
  }

  async getFullGID() {
    try {
      const gid = await exec("redis-cli hget sys:ept gid")
      return gid && gid.stdout && gid.stdout.replace("\n", "")
    } catch (err) {
      log.error("Failed to get gid", err);
      return null
    }
  }

  async getPrimaryIP() {
    return sysManager.myDefaultWanIp() || '';
  }

  async getQRImage() {
    if (!this.broadcastInfo) {
      return null;
    }

    try {
      const imagePath = `${__dirname}/static/firewalla_pairing_info.png`;
      const jsonPath = "/tmp/pairing.info.json";

      const pairingInfo = JSON.parse(JSON.stringify(this.broadcastInfo));
      pairingInfo.type = "pairing";
      delete pairingInfo.keyhint;
      delete pairingInfo.service;
      delete pairingInfo.mid;
      delete pairingInfo.verifymode;

      await writeFileAsync(jsonPath, pairingInfo);

      const cmd = `cat ${jsonPath} | qrencode -o ${imagePath}`;

      await exec(cmd);
      return imagePath;
    } catch (err) {
      log.error("Failed to get QRImage", err);
      return null
    }
  }

  routes() {
    this.router = express.Router();

    this.app.use('/' + VIEW_PATH, this.router);
    this.app.use('/' + STATIC_PATH, express.static(path.join(__dirname, STATIC_PATH)));

    this.app.use('/log', (req, res) => {
      const filename = "/home/pi/logs/FireKick.log";
      (async () => {
        const gid = await this.getFullGID()
        await fs.accessAsync(filename, fs.constants.F_OK)
        //tail -n 1000 /home/pi/logs/FireKick.log | sed -r   "s/0-9]{1,2}(;[0-9]{1,2})?)?[mGK]//g"
        const result = (await exec(`tail -n 1000 ${filename}`)).stdout
        let lines = result.split("\n")
        lines = lines.map((originLine) => {
          let line = originLine
          line = line.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
          line = line.replace(new RegExp(gid, "g"), "<****gid****>")
          line = line.replace(/type in this key:.*$/g, "type in this key: <****key****>")
          line = line.replace(/Inviting .{10,40} to group/g, "Inviting <****rid****> to group")
          line = line.replace(/Set SYS:EPT.*/, "Set SYS:EPT<****token****>")
          return line
        })

        res.setHeader('content-type', 'text/plain');
        res.end(lines.join("\n"))
      })().catch((err) => {
        log.error("Failed to fetch log", err);
        res.status(404).send('')
      })
    });

    this.app.use('/bluetooth_log', (req, res) => {
      const filename = "/home/pi/.forever/firereset.log";
      (async () => {
        await fs.accessAsync(filename, fs.constants.F_OK)
        const result = (await exec(`tail -n 100 ${filename}`)).stdout
        let lines = result.split("\n")
        lines = lines.map((originLine) => {
          let line = originLine
          line = line.replace(/password.........................................../, "*************************");
          line = line.replace(/username.........................................../, "*************************")
          return line
        })

        res.setHeader('content-type', 'text/plain');
        res.end(lines.join("\n"))
      })().catch((err) => {
        log.error("Failed to fetch log", err);
        res.status(404).send('')
      })
    });

    this.app.use('/pairing', (req, res) => {
      if (this.broadcastInfo) {
        res.json(this.broadcastInfo);
      } else {
        res.status(501).send('');
      }
    });

    this.app.use('/pair/ping', (req, res) => {
      res.json({});
    });

    this.app.use('/pair/ready', async (req, res) => {
      try {
        const values = await this.getPairingStatus();
        if(values.success) {
          res.json({
            ready: true
          });
        } else {
          res.json({
            ready: false,
            content: values
          });
        }
      } catch(err) {
        log.error("Failed to process request", err);
        res.json({
          ready: false
        });
      }
    });


    this.app.use('/raw', async (req, res) => {
      log.info("Got a request in /raw")

      try {
        const values = await this.getPairingStatus();
        if(values.error) {
          log.error("Failed to process request", err);
          res.status(500).send({})
        } else {
          res.render('raw', values)
        }
      } catch(err) {
        log.error("Failed to process request", err);
        res.status(500).send({})
      }
    })

    this.app.use('*', async (req, res) => {
      log.info("Got a request in *")

      try {
        const values = await this.getPairingStatus();
        if(values.error) {
          log.error("Failed to process request", err);
          res.status(500).send({})
        } else {
          res.render('welcome', values)
        }
      } catch(err) {
        log.error("Failed to process request", err);
        res.status(500).send({})
      }
    })
  }

  async getPairingStatus() {
    try {
      const time = this.getSystemTime()
      const ip = await this.getPrimaryIP();
      const gid = await this.getGID()
      const database = await this.getDatabase()
      const uptime = this.getUptime()
      const nodeVersion = this.getNodeVersion()
      const memory = await this.getSystemMemory()
      const connected = this.getCloudConnectivity()
      const systemServices = await this.getSystemServices()
      const expireDate = this.expireDate;
      const qrImagePath = await this.getQRImage()

      let success = true
      let values = {
        now: new Date() / 1000
      }

      if(!this.broadcastInfo) {
        values.err_binding = true
        success = false;
      }

      if(qrImagePath) {
        values.qrImage = true;
      } else {
        success = false;
      }

      if(ip == "") {
        values.err_ip = true
        success = false
      } else {
        values.ip = ip
      }

      if(gid == null) {
        values.err_config = true
        success = false
      }

      if(database != 0) {
        values.err_database = true
        success = false
      }

      if(memory != 0) {
        values.err_memory = true
        success = false
      }

      if(connected != true) {
        values.err_cloud = true
        success = false
      }

      if(systemServices != 0) {
        values.err_service = true
        success = false
      }

      values.has_bluetooth = platform.isBluetoothAvailable();
      if(values.has_bluetooth) {
        const btStatus = await this.getFireResetStatus();
        if(btStatus !== 0) {
          values.err_bluetooth = btStatus
          // no need to set success to false, because it's not a blocking issue for QR code pairing
        }
      }

      values.success = success

      return values;

    } catch(err) {
      log.error("Failed to get pairing status, err:", err);
      return {
        success: false,
        error: true
      }
    }
  }

  async iptablesRedirection(create = true) {
    const action = create ? '-I' : '-D';

    for (const server of this.servers) {
      if (!server || !server.ip || !server.port) continue;

      // should use primitive chains here, since it needs to be working before install_iptables.sh
      log.info(create ? 'creating' : 'removing', `port forwording from 80 to ${server.port} on ${server.ip}`);
      const cmd = wrapIptables(`sudo iptables -w -t nat ${action} PREROUTING -p tcp --destination ${server.ip} --destination-port 80 -j REDIRECT --to-ports ${server.port}`);
      await exec(cmd);
    }
  }

  scheduleRebindServerInstances() {
    if (this.rebindTask)
      clearTimeout(this.rebindTask);
    this.rebindTask = setTimeout(async () => {
      await this.stop();
      setTimeout(() => {
        this.start();
      }, 2000);
    }, 6000);
  }

  _stopHttpServers() {
    for (const server of this.servers) {
      if (server.server)
        server.server.close();
    }
    this.servers = [];
  }

  _startHttpServers() {
    for (const iface of sysManager.getMonitoringInterfaces()) {
      const ip = iface && sysManager.myIp(iface.name);
      if (ip) {
        const server = http.createServer(this.app);
        server.on('error', (err) => {
          console.error(`Error from diag http server ${err.code}`);
        });
        server.listen(port, ip, () => {
          log.info(`Diag http server listening on ${ip}:${port}`);
        });
        this.servers.push({
          ip: ip,
          port: port,
          server: server
        });
      }
    }
  }

  async stop() {
    await this.iptablesRedirection(false).catch((err) => {
      log.error(`Failed to remove diag iptables redirect`, err.message);
    });
    this._stopHttpServers();
    this._started = false;
  }

  async start() {
    this._startHttpServers();
    await this.iptablesRedirection(true).catch((err) => {
      log.error(`Failed to add diag iptables redirect`, err.message);
    });
    this._started = true;
  }
}

module.exports = App
