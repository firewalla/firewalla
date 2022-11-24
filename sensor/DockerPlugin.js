/*    Copyright 2019-2021 Firewalla Inc.
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

const Sensor = require('./Sensor.js').Sensor;
const extensionManager = require('./ExtensionManager.js')
const docker = require('../extension/docker/docker.js');

class DockerPlugin extends Sensor {
    async apiRun() {
        extensionManager.onGet("docker.containers", (msg) => {
            return docker.listContainers();
        });
        extensionManager.onCmd("docker.container.start", (msg, data) => {
            return docker.startContainer(data.container);
        });
        extensionManager.onCmd("docker.container.stop", (msg, data) => {
            return docker.stopContainer(data.container);
        });
        extensionManager.onCmd("docker.container.rm", (msg, data) => {
            return docker.rmContainer(data.container);
        });
        extensionManager.onGet("docker.container.inspect", (msg, data) => {
            return docker.inspectContainer(data.container);
        });
        extensionManager.onGet("docker.images", (msg) => {
            return docker.listImages();
        });
        extensionManager.onCmd("docker.service.start", (msg) => {
            return docker.startDocker();
        });
        extensionManager.onCmd("docker.service.stop", (msg) => {
            return docker.stopDocker();
        });
    }
}

module.exports = DockerPlugin
