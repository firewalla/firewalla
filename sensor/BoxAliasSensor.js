/*    Copyright 2016-2020 Firewalla Inc.
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

const util = require('util');
const fs = require('fs');
const writeFileAsync = util.promisify(fs.writeFile);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const PlatformLoader = require('../platform/PlatformLoader.js')
const platform = PlatformLoader.getPlatform()

const sysManager = require('../net2/SysManager.js');

const f = require('../net2/Firewalla.js');
const generatedConfigFile = `${f.getUserConfigFolder()}/dnsmasq/box_alias.conf`;
const Message = require('../net2/Message.js');
const NetworkProfile = require('../net2/NetworkProfile.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

class BoxAliasSensor extends Sensor {

    async installBoxAliases() {
      if (!platform.isFireRouterManaged()) {
        // there is only one dnsmasq instance for old platforms
        const aliases = [
            ["fire.walla", sysManager.myIp()],
            ["overlay.fire.walla", sysManager.myIp2()]
        ];

        let content = '';
        for (let alias of aliases) {
            if (alias[1]) {
                content += `address=/${alias[0]}/${alias[1]}\n`;
            }
        }

        await writeFileAsync(generatedConfigFile, content).then(() => {
            log.info(`generated ${generatedConfigFile}`, content);
        }).catch((err) => {
            log.error(`fail to write ${generatedConfigFile}`, err.message);
        });

        dnsmasq.scheduleRestartDNSService();
      } else {
        // each network has dedicated dnsmasq interface and its config directory
        const monitoringInterfaces = sysManager.getMonitoringInterfaces();
        for (const iface of monitoringInterfaces) {
          const uuid = iface.uuid;
          const dnsmasqConfDir = NetworkProfile.getDnsmasqConfigDirectory(uuid);
          if (!sysManager.myIp(iface.name)) {
            log.warn(`IP of ${uuid} is not found`);
            continue;
          }
          const dnsmasqEntry = `address=/fire.walla/${sysManager.myIp(iface.name)}`;
          await writeFileAsync(`${dnsmasqConfDir}/box_alias.conf`, dnsmasqEntry).then(() => {
            log.info(`generated ${dnsmasqConfDir}/box_alias.conf`, dnsmasqEntry);
          }).catch((err) => {
            log.error(`Failed to generate box_alias conf file ${dnsmasqConfDir}/box_alias.conf`, err.message);
          });
        }
        dnsmasq.scheduleRestartDNSService();
      }
    }

    run() {
        this.installBoxAliases();

        sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
          this.installBoxAliases();
        })
    }

}

module.exports = BoxAliasSensor;
