/*    Copyright 2020 Firewalla Inc.
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

const exec = require('child-process-promise').exec;
const _ = require('lodash');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const yaml = require('../../api/dist/lib/js-yaml.min.js');

const f = require('../../net2/Firewalla.js');
const fr = require('../../net2/FireRouter.js');
const log = require('../../net2/logger.js')(__filename);
const util = require('../../util/util.js');

const dockerDir = `${f.getRuntimeInfoFolder()}/docker/freeradius`
const configDir = `${f.getUserConfigFolder()}/freeradius`
const logDir = `${f.getUserHome()}/.forever/freeradius`

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let instance = null;

class FreeRadius {
  constructor(config) {
    if (instance === null) {
      instance = this;
      this.config = config || {};
      this.running = false;
      this.watcher = null;
      this.pid = null;
      this.featureOn = false;
    }
    return instance;
  }

  async cleanUp() {
    this.pid = null;
    this.running = false;
    if (this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
  }

  async prepare(options = {}) {
    try {
      await this._prepare(options);
    } catch (err) {
      log.warn(`failed to prepare freeradius`, err.message);
    }
  }

  async _prepare(options = {}) {
    await this.watchContainer();
    await this.startDockerDaemon(options);
    await this.generateDockerCompose(options);
    await this.prepareImage(options);
    await this.generateOptions(options);
    await this.prepareIptables(options);
  }

  async ready() {
    if (!await fs.accessAsync(`${dockerDir}/docker-compose.yml`, fs.constants.F_OK).then(() => true).catch(_err => false)) {
      return false;
    }
    return true;
  }

  async _watchStatus() {
    await exec("netstat -an  | egrep -q ':1812'").then(() => { this.running = true }).catch((err) => { this.running = false });
  }

  async _watch() {
    await this._watchStatus();
    if (this.running) {
      await sleep(1000);
      if (!await fs.accessAsync(`${dockerDir}/docker-compose.yml`, fs.constants.F_OK).then(() => true).catch(_err => false)) {
        log.debug("freeradius docker compose file not exist, skip checking status of container freeradius-server");
        return;
      }
      const cmd = `sudo docker-compose -f ${dockerDir}/docker-compose.yml exec -T freeradius pidof freeradius`
      await exec(cmd).then((r) => { this.pid = r.stdout.trim() }).catch((e) => { this.pid = null; });
    }
    await this.saveIpset("ap_ip_list");
  }

  async saveIpset(name = "ap_ip_list") {
    try {
      const data = await this.getIpset(name);
      if (!await fs.accessAsync(`${dockerDir}/config`).then(() => true).catch(() => false)) {
        await exec(`mkdir -p ${dockerDir}/config`).catch((e) => {
          log.warn(`Failed to create directory ${dockerDir}/config,`, e.message);
        });
      }
      await fs.writeFileAsync(`${dockerDir}/config/${name}`, data.join("\n"), 'utf8');
    } catch (err) {
      log.warn(`Failed to save ipset ${name},`, err.message);
    }
  }

  async watchContainer(interval) {
    if (this.watcher) {
      clearInterval(this.watcher);
    }

    await this._watch();
    this.watcher = setInterval(async () => {
      await this._watch();
    }, interval * 1000 || 60000); // every 60s by default
  }

  async startDockerDaemon(options = {}) {
    let dockerRunning = false;
    if (await exec(`sudo systemctl -q is-active docker`).then(() => true).catch((err) => false)) {
      dockerRunning = true;
      return true;
    }
    log.info("Starting docker service...")
    const watcher = setInterval(() => {
      exec(`sudo systemctl -q is-active docker`).then(() => { dockerRunning = true }).catch((err) => { dockerRunning = false });
    }, 10000);
    await exec(`sudo systemctl start docker`).catch((err) => { });
    await util.waitFor(_ => dockerRunning === true, 30000).then(() => true).catch((err) => false);
    clearInterval(watcher);
    return dockerRunning
  }

  async startServer(options = {}) {
    this.watchContainer(5);
    await this._startServer(options);
    this.watchContainer(60);
  }

  async _startServer(options = {}) {
    if (this.running) {
      log.warn("Abort starting radius-server, server is already running.")
      return false;
    }
    log.info("Starting container freeradius-server...");
    try {
      await this.generateOptions(options);
      if (!await this._start()) {
        return false;
      }
      await util.waitFor(_ => this.running === true, options.timeout * 1000 || 60000).catch((err) => { });
      if (!this.running && !await this.isListening()) {
        log.warn("Container freeradius-server is not started.")
        return false;
      }
      log.info("Container freeradius-server is started.");
      return true;
    } catch (err) {
      log.warn("Failed to start radius-server,", err.message);
    }
    return false;
  }

  async _start() {
    if (!await this.startDockerDaemon()) {
      log.error("Docker daemon is not running.");
      return false;
    }
    await exec("sudo systemctl start docker-compose@freeradius").catch((e) => {
      log.warn("Cannot start freeradius,", e.message);
      return false;
    });
    return true;
  }

  async generateOptions(options = {}) {
    const configPath = `${dockerDir}/config/.env`;
    // remove existing file
    if (await fs.accessAsync(configPath, fs.constants.F_OK).then(() => true).catch(_err => false)) {
      await fs.unlinkAsync(configPath);
    }
    if (!await fs.accessAsync(`${dockerDir}/config`).then(() => true).catch(() => false)) {
      await exec(`mkdir -p ${dockerDir}/config`).catch((e) => {
        log.warn("Failed to create config directory,", e.message);
      });
    }
    // generate new file
    const lines = Object.entries(options).filter(([key, _value]) => key !== 'secret').map(([key, value]) => `${key}=${value}`);
    const content = lines.join("\n");
    await fs.writeFileAsync(configPath, content, 'utf8');
    return true;
  }

  async generateRadiusConfig(options = {}) {
    try {
      await exec(`mkdir -p ${dockerDir}/config`).catch((e) => {
        log.warn("Failed to create config directory,", e.message);
      });
      await this.prepareIptables().catch((e) => {
        log.warn("Failed to prepare ap ipset iptables,", e.message);
      });
      if (!await fs.accessAsync(`${dockerDir}/docker-compose.yml`).then(() => true).catch(() => false)) {
        await this.generateDockerCompose(options);
      }
      // check if container is up
      if (!await this._checkContainer(options)) {
        log.warn("container freeradius-server is not running, cannot generate radius config");
        return false;
      }

      log.info("container freeradius-server is running, generating radius config...");
      return await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml exec -T freeradius bash -c "bash /root/freeradius/freeradius.sh generate"`).then((r) => { return true }).catch((e) => {
        log.warn("Failed to generate radius config,", e.message);
        return false;
      });
    } catch (err) {
      log.warn("Failed to generate radius config,", err.message);
      return false;
    }
  }

  async loadOptionsAsync() {
    const options = {};
    // Load environment file if .env` exists in working directory
    if (await fs.accessAsync(`${dockerDir}/config/.env`).then(() => true).catch(() => false)) {
      try {
        const envContent = await fs.readFileAsync(`${dockerDir}/config/.env`, 'utf8');
        const envLines = envContent.split('\n').filter(line =>
          line.trim() && !line.trim().startsWith('#')
        );
        for (const line of envLines) {
          const [key, value] = line.split('=');
          if (key && value) options[key] = value;
        }
      } catch (error) {
        log.warn(`Warning: Could not read environment file: ${error.message}`);
      }
    }
    return options;
  }

  // policy in format: { "0.0.0.0": { "options": {}, "radius": {} }, "tag":{"radius":{"users":[]}} }
  async processCommand(script, cmd, options) {
    log.info(`Processing ${script} with command ${cmd}`);
    try {
      // check if container is running
      if (!await this._checkContainer(options)) {
        log.warn("container freeradius-server is not running, cannot process radius command");
        return false;
      }
      return await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml exec -T freeradius bash -c "/usr/bin/node /root/freeradius/${script} ${cmd}"`).then((r) => {
        return r.stdout.trim()
      }).catch((e) => { return e.message });
    } catch (err) {
      log.warn("Failed to process script,", script, cmd, err.message);
    }
  }

  async saveFile(filepath, content) {
    filepath = filepath.replace(/^\//, ''); // remove leading slash
    const baseFolder = filepath.split('/').slice(0, -1).join('/'); // get base folder
    await exec(`mkdir -p ${configDir}/${baseFolder}`).catch((e) => {
      log.warn(`Failed to create config directory ${baseFolder}`, e.message);
    });

    log.info(`Saving file to ${configDir}/${filepath}...`);
    return await fs.writeFileAsync(`${configDir}/${filepath}`, content, 'utf8').then((r) => {
      log.info(`File ${configDir}/${filepath} saved successfully.`);
      return { ok: true };
    }).catch((e) => {
      log.warn(`Failed to save file to ${configDir}/${filepath},`, e.message);
      return { ok: false, error: e.message };
    });
  }

  async generateDockerCompose(options = {}) {
    await exec(`mkdir -p ${configDir}`).catch((e) => {
      log.warn("Failed to create config directory,", e.message);
    });

    await exec(`mkdir -p ${dockerDir}/config`).catch((e) => {
      log.warn("Failed to create config directory,", e.message);
    });

    await exec(`mkdir -p ${logDir}/`).catch((e) => {
      log.warn("Failed to create log directory,", e.message);
    });

    const content = await fs.readFileAsync(`${__dirname}/docker-compose.yml`, 'utf8');
    const yamlContent = yaml.load(content);
    const tag = this.getImageTag(options);
    yamlContent.services.freeradius.image = `public.ecr.aws/a0j1s2e9/freeradius:${tag}`;
    if (options.hostname) {
      yamlContent.services.freeradius.hostname = options.hostname;
    }
    await fs.writeFileAsync(`${dockerDir}/docker-compose.yml`, yaml.dump(yamlContent), 'utf8');
  }

  async prepareImage(options = {}) {
    try {
      if (await this._checkImage(options) && !await this.upgradeImage(options)) {
        log.info("Image freeradius-server is pulled and up to date.");
        return;
      }

      log.info("Pull image freeradius-server...");
      if (!await fs.accessAsync(`${dockerDir}/docker-compose.yml`, fs.constants.F_OK).then(() => true).catch(_err => false)) {
        log.info("freeradius docker compose file not exist, skip pulling image freeradius-server");
        return;
      }
      await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml pull`).catch((e) => {
        log.warn("Failed to pull image freeradius,", e.message)
        return;
      });
      if (await this._checkImage(options)) {
        log.info("Image freeradius-server is pulled.");
        return;
      }
      log.warn("Image freeradius-server is not pulled.");
      return false;
    } catch (err) {
      log.warn("Failed to pull image freeradius,", err.message);
      return false;
    }
  }

  async upgradeImage(options = {}) {
    try {
      log.debug("Checking for new image freeradius-server...");
      const tag = this.getImageTag(options);
      log.info(`Checking for new image freeradius-server:${tag}`);
      // get current image digest using docker images (works even when container not running)
      const currentImage = await exec(`sudo docker images --format "{{.ID}}" --filter "reference=public.ecr.aws/a0j1s2e9/freeradius:${tag}"`).then(r => r.stdout.trim()).catch(() => null);
      if (!currentImage) {
        log.info("No freeradius image found, need to pull");
      }

      // pull latest image
      await exec(`sudo docker pull public.ecr.aws/a0j1s2e9/freeradius:${tag}`).catch((e) => {
        log.warn("Failed to pull image for comparison,", e.message);
        return false;
      });

      await sleep(2000);

      // get new image digest using docker images
      const newImage = await exec(`sudo docker images --format "{{.ID}}" --filter "reference=public.ecr.aws/a0j1s2e9/freeradius:${tag}"`).then(r => r.stdout.trim()).catch(() => null);
      if (!newImage) {
        log.warn("Failed to get new image digest");
        return false;
      }

      // Check if image has changed
      if (currentImage === newImage) {
        log.info("Current image is latest", currentImage);
        return false;
      }

      log.info("new image detected and pulled", newImage);
      // remove old image
      if (currentImage) {
        // stop container first
        await this._stopServer(options);

        await exec(`sudo docker rmi ${currentImage}`).catch((e) => {
          log.warn("Failed to remove old image,", e.message);
        });
        log.info("outdated image removed", currentImage);
      }

      return true;

    } catch (err) {
      log.error("Failed to check for new image,", err.message);
      return false;
    }
  }

  // get clients from frcc
  async _getFrccClients() {
    const frcc = await fr.getConfig();
    const assets = _.get(frcc, "apc.assets", {});
    const wifis = _.get(frcc, "apc.assets_template.ap_default.wifiNetworks", {});
    const interfaces = _.get(frcc, "interface", {});
    const wifi_intfs = _.isObject(wifis) && Object.values(wifis).map(v => v.intf).filter(i => i) || [];
    const subnets = Object.values(interfaces).flatMap(intf => wifi_intfs.filter(name => intf[name] && intf[name].ipv4).map(name => intf[name].ipv4));
    const macs = _.isObject(assets) && Object.keys(assets).filter(i => i) || [];
    return { macs, subnets }
  }

  async getClients() {
    const { macs, subnets } = await this._getFrccClients();
    log.debug(`get clients from frcc`, { macs, subnets });

    return {
      macs: macs,
      subnets: subnets
    };
  }

  async getIpset(name = "ap_ip_list", number = 1000) {
    const data = await exec(`sudo ipset list ${name} | grep -A ${number} "Members:" | grep -v "^Members:$" | awk '{print $1}'| sort`).then(r => r.stdout.trim()).catch((err) => {
      log.warn(`failed to get ipset clients`, err.message);
      return [];
    });
    return data.split("\n").map(i => i.trim()).filter(i => i);
  }

  async prepareIptables() {
    try {
      await this._prepareIptables();
    } catch (err) {
      log.warn(`failed to prepare iptables`, err.message);
    }
  }

  async _prepareIptables() {
    const { macs, subnets } = await this.getClients();
    await this.setupIptables(macs, subnets);
    await this.saveIpset("ap_ip_list");
  }

  async setupIptables(macs = [], subnets = []) {
    log.debug(`setting up iptables rules...`);
    try {
      await exec(`sudo iptables -D INPUT -m set --match-set ap_subnet_list src -m set --match-set ap_mac_list src -j SET --add-set ap_ip_list src`);
      await exec(`sudo ipset destroy ap_mac_list`);
      await exec(`sudo ipset destroy ap_subnet_list`);
    } catch (error) {
      log.warn(`failed to remove iptables rules`, error.message);
    }

    await exec(`sudo ipset create ap_mac_list hash:mac --exist`).catch((err) => {
      log.warn(`failed to create ap_mac_list`, err.message);
    });
    await exec(`sudo ipset create ap_subnet_list hash:net --exist`).catch((err) => {
      log.warn(`failed to create ap_subnet_list`, err.message);
    });
    // create ap_ip_list if not exists
    await exec(`sudo ipset list ap_ip_list`).then(r => r.stdout.trim()).catch(async (err) => {
      await exec(`sudo ipset create ap_ip_list hash:ip timeout 86400 --exist`).catch((err) => {
        log.warn(`failed to create ap_ip_list`, err.message);
      });
    });

    for (const mac of macs) {
      await exec(`sudo ipset add ap_mac_list ${mac}`).catch((err) => {
        log.warn(`failed to add mac to ap_mac_list`, err.message);
      });
    }
    for (const subnet of subnets) {
      await exec(`sudo ipset add ap_subnet_list ${subnet}`).catch((err) => {
        log.warn(`failed to add subnet to ap_subnet_list`, err.message);
      });
    }

    try {
      await exec(`sudo iptables -C INPUT -m set --match-set ap_subnet_list src -m set --match-set ap_mac_list src -j SET --add-set ap_ip_list src`);
    } catch (error) {
      log.debug(`inserting iptables ap_ip_list rule...`);
      await exec(`sudo iptables -I INPUT -m set --match-set ap_subnet_list src -m set --match-set ap_mac_list src -j SET --add-set ap_ip_list src`).catch((err) => {
        log.warn(`failed to add iptables rule`, err.message);
      });
    }
  }

  getImageTag(options = {}) {
    if (options.image_tag) {
      return options.image_tag;
    }
    return f.isDevelopmentVersion() ? "dev" : "latest";
  }

  async _checkImage(options) {
    const tag = this.getImageTag(options);
    const result = await exec(`sudo docker images | grep freeradius | grep ${tag}`).then(r => r.stdout.trim()).catch((e) => {
      log.warn("Failed to check image freeradius,", e.message)
      return false;
    });
    log.info("Image freeradius-server:", result);
    return result && result.includes("freeradius") && result.includes(tag);
  }

  async _checkContainer(options = {}) {
    const tag = this.getImageTag(options);
    const result = await exec(`sudo docker ps | grep freeradius | grep ${tag}`).then(r => r.stdout.trim()).catch((e) => {
      log.warn("Failed to check container freeradius,", e.message)
      return false;
    });
    log.info("Container freeradius-server status:", result);
    return result && result.includes("freeradius");
  }

  async _terminateServer(options = {}) {
    log.info("Fallback to terminate container freeradius-server...");
    await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml down`).catch((e) => {
      log.warn("Failed to stop docker freeradius,", e.message)
      return;
    });
    await sleep(3000);
    await util.waitFor(_ => this.running === false, options.timeout * 1000 || 60000).catch((err) => {
      log.warn("Container freeradius-server timeout to terminate,", err.message)
    });

    if (await this.isListening()) {
      log.warn("Container freeradius-server is not terminated.")
      return;
    }
    log.info("Container freeradius-server is terminated.");
    return;
  }

  // TODO: will not reload clients, need to check changes
  async _reloadServer(options = {}) {
    try {
      const pid = this.pid;

      if (!await this.generateRadiusConfig(options)) {
        log.warn("Abort starting radius-server, configuration not ready");
        return false;
      }
      log.info("Reloading container freeradius-server...");

      if (pid) {
        log.info(`Current freeradius pid ${pid}...`);
        // check if pid is changed in 30s, return true if changed
        await util.waitFor(_ => this.pid && this.pid !== pid, 60000).catch((err) => {
          log.warn(`Container freeradius-server pid ${pid} not changed, try to reload container`, err.message);
        });
        if (this.pid && this.pid !== pid) {
          log.info(`Container freeradius-server pid changed, new pid ${this.pid}`);
          return true;
        }
      }

      await exec(`sudo systemctl restart docker-compose@freeradius`).catch((e) => {
        log.warn("Cannot restart freeradius,", e.message)
        return false;
      });
      await sleep(3000);
      await util.waitFor(_ => this.running === true, options.timeout * 1000 || 60000).catch((err) => {
        log.warn("Container freeradius-server timeout to reload,", err.message)
      });
      if (this.running) {
        log.info("Container freeradius-server is reloaded successfully.");
      }
      return this.running === true;
    } catch (err) {
      log.warn("Failed to reload radius-server,", err.message);
    }
    return false;
  }

  async _statusServer(options = {}) {
    try {
      this.pid = null;
      if (!await fs.accessAsync(`${dockerDir}/docker-compose.yml`, fs.constants.F_OK).then(() => true).catch(_err => false)) {
        log.debug("freeradius docker compose file not exist, skip checking status of container freeradius-server");
        return false;
      }

      log.info("Checking status of container freeradius-server...");
      await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml ps`).catch((e) => {
        log.warn("Cannot get container status of freeradius by docker-compose,", e.message)
      });

      const result = await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml exec -T freeradius pidof freeradius`).then(r => r.stdout.trim()).catch(async (e) => {
        log.warn("Cannot get freeradius pid from container,", e.message)
        if (!await this._checkContainer(options)) {
          this.running = false;
          log.info("Container freeradius-server is not running");
          return;
        }
        return;
      });
      if (result) {
        log.info("Container freeradius-server is running, pid:", result);
        this.pid = result;
        this.running = true;
        return;
      }
      log.info("Container freeradius-server is not running.");
    } catch (err) {
      log.warn("Failed to check status of radius-server,", err.message);
    }
  }

  async globalOn() {
    this.featureOn = true;
  }

  async globalOff() {
    this.featureOn = false;
  }

  async stopServer(options = {}) {
    this.watchContainer(5);
    await this._stopServer(options);
    this.watchContainer(60);
  }

  async _stopServer(options = {}) {
    try {
      log.info("Stopping container freeradius-server...");
      await exec("sudo systemctl stop docker-compose@freeradius").catch((e) => {
        log.warn("Cannot stop freeradius,", e.message)
      });
      await util.waitFor(_ => this.running === false, options.timeout * 1000 || 60000).catch((err) => {
        log.warn("Container freeradius-server timeout to stop,", err.message)
      });
      if (this.running) {
        log.warn("Container freeradius-server is not stopped.")
        await this._terminateServer(options);
        return
      }
      log.info("Container freeradius-server is stopped.");
    } catch (err) {
      log.warn("Failed to stop radius-server,", err.message);
    }
  }

  async _reconfigServer(target, options = {}) {
    // if new image detected, update image first
    const imageUpdated = await this.upgradeImage(options);
    const isRunning = await this._checkContainer(options);
    log.debug(`reconfigure freeradius, imageUpdated ${imageUpdated}, target ${target}, isRunning ${isRunning}, force_restart ${options.force_restart}`);
    if (!imageUpdated && isRunning && !options.force_restart) {
      log.info("reloading freeradius server to apply new config...");
      await this._reloadServer(options);
    } else {
      log.info("restarting freeradius container to apply new config...");
      await this._stopServer(options);
      if (!await this._startServer(options)) {
        return false;
      }
    }
  }

  async reconfigServer(target, options = {}) {
    if (!this.featureOn) {
      log.error(`feature is disabled`);
      return false;
    }

    try {
      this.watchContainer(5);
      await this._reconfigServer(target, options);
    } catch (err) {
      log.warn("Failed to reconfig freeradius,", target, options, err.message);
    } finally {
      this.watchContainer(60);
    }

    return this.running;
  }

  // radius listens on 1812-1813
  async isListening() {
    return await exec("netstat -an | egrep -q ':1812'").then(() => true).catch((err) => false);
  }

  async getStatus(options = {}) {
    await this._statusServer(options);
    return { running: this.running, pid: this.pid };
  }

  mask(jsonStr) {
    jsonStr = jsonStr.replace(/"secret"\s*:\s*"[^"]*"/g, '"secret":"*** redacted ***"');
    return jsonStr.replace(/"passwd"\s*:\s*"[^"]*"/g, '"passwd":"*** redacted ***"');
  }

}



module.exports = new FreeRadius();
