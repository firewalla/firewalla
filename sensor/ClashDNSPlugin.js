/*    Copyright 2022 Firewalla Inc
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

const DockerDNS = require('../extension/dockerdns/dockerdns.js');


class ClashDNSPlugin extends Sensor {
  async run() {
    const featureName = "clashdns";

    const config = {
      profileId: featureName,
      featureName: featureName,
      type: "clash"
    };
    this.docker = new DockerDNS(config);
    await this.docker.run();

    this.hookFeature(featureName);
  }

  async globalOn() {
    await super.globalOn();
    await this.docker.globalOn();
  }

  async globalOff() {
    await super.globalOff();
    await this.docker.globalOff();
  }
}

module.exports = ClashDNSPlugin;
