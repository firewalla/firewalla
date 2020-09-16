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
const log = require('../../net2/logger.js')(__filename);

let instance = null;

class Docker {
    constructor() {
        if (instance === null) {
            instance = this;
            this.ready = false;
        }
        return instance;
    }

    async _getShellOutput(cmd) {
        try {
            const result = await exec(cmd, { encoding: 'utf8' });
            return result && result.stdout && result.stdout.replace(/\n$/,'');
        } catch(err) {
            log.error("ERROR: "+err);
            return "";
        }
    }

    async _getShellOutputJSON(cmd) {
        try {
            const data = await this._getShellOutput(cmd);
            return JSON.parse(data);
        } catch (err) {
            log.error(`Failed to get containers: ${err}`);
            return "";
        }
    }

    async listContainers() {
        return await this._getShellOutputJSON("sudo docker container ls -a --format '{{json .}}'| jq -r -s .");
    }

    async listImages() {
        return await this._getShellOutputJSON("sudo docker images --format '{{json .}}' | jq -s .");
    }

    async inspectContainer(container) {
        return await this._getShellOutputJSON(`sudo docker container inspect ${container}`);
    }

    async _opContainer(op,container) {
        return this._getShellOutput(`sudo docker container ${op} ${container}`);
    }

    async startContainer(container) {
        return await this._opContainer("start",container);
    }

    async stopContainer(container) {
        return await this._opContainer("stop",container);
    }

    async rmContainer(container) {
        return await this._opContainer("rm",container);
    }

    async _opDocker(op) {
        return this._getShellOutput(`sudo systemctl ${op} docker`);
    }

    async startDocker() {
        return this._opDocker("start");
    }

    async stopDocker() {
        return this._opDocker("stop");
    }

}

 module.exports = new Docker();

 /*
 (async () => {
     const d = new Docker();
     const containerName = "hw";
     log.info("containers:", await d.listContainers());
     await d.startContainer(containerName);
     log.info("containers:", await d.listContainers());
     await d.stopContainer(containerName);
     log.info("inspect container:", await d.inspectContainer(containerName));
     await d.rmContainer(containerName);
     log.info("containers:", await d.listContainers());
     log.info("images:", await d.listImages());
     log.info("status docker:", await d.statusDocker());
     log.info("stop docker:", await d.stopDocker());
     log.info("status docker:", await d.statusDocker());
     log.info("start docker:", await d.startDocker());
     log.info("status docker:", await d.statusDocker());
 })();
 */