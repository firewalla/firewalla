/*    Copyright 2026 Firewalla Inc.
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

// Applies the pcap_zeek_fleet / pcap_zeek_suricata features: when either
// flips, scripts/fleet-engine.sh rewrites the systemd drop-ins beside
// brofish.service and suricata.service (fleet in, zeek/suricata out, or the
// reverse) and the pcap plugins are asked to restart their services, which
// makes the change take effect and re-picks the watchdog cron template.
// At boot main-start applies the drop-ins before any service starts; this
// sensor only re-applies them on a live toggle.

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const fc = require('../net2/config.js');
const f = require('../net2/Firewalla.js');
const Constants = require('../net2/Constants.js');
const Message = require('../net2/Message.js');
const sem = require('./SensorEventManager.js').getInstance();
const scheduler = require('../util/scheduler.js');
const exec = require('child-process-promise').exec;
const FlowEngine = require('../net2/FlowEngine.js');

const FEATURES = [Constants.FEATURE_PCAP_ZEEK_FLEET, Constants.FEATURE_PCAP_SURICATA_FLEET];

class FleetEnginePlugin extends Sensor {
  async run() {
    this.applyJob = new scheduler.UpdateJob(this.apply.bind(this), 3000);
    // make sure the drop-ins match the features even if FireMain started
    // without main-start (a plain `systemctl restart firemain`)
    await this.apply(false);
    for (const feature of FEATURES) {
      fc.onFeature(feature, (name, status) => {
        if (name !== feature) return;
        log.info(`Feature ${name} is now ${status ? 'on' : 'off'}: zeek role -> ${FlowEngine.zeekEngine()}, suricata role -> ${FlowEngine.suricataEngine()}`);
        this.applyJob.exec().catch((err) => {
          log.error('Failed to apply flow engine change', err.message);
        });
      });
    }
  }

  // restart = true: the features changed while running, so the pcap plugins
  // must restart brofish and suricata for the new drop-ins to take effect
  async apply(restart = true) {
    const script = `${f.getFirewallaHome()}/scripts/fleet-engine.sh`;
    await exec(`sudo ${script} apply`).then((r) => {
      if (r.stdout && r.stdout.trim()) log.info('fleet-engine:', r.stdout.trim().replace(/\n/g, '; '));
    }).catch((err) => {
      log.error('fleet-engine.sh apply failed', err.message);
    });
    if (restart) {
      sem.emitLocalEvent({ type: Message.MSG_PCAP_RESTART_NEEDED });
    }
  }
}

module.exports = FleetEnginePlugin;
