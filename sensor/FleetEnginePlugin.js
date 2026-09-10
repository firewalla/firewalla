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
const fs = require('fs');

// the engine selectors, plus the pcap roles themselves: switching the flow
// role off moves the IDS from the shared brofish fleet to a fleet of its own
// under the suricata unit, which is another apply
const ENGINE_FEATURES = [Constants.FEATURE_PCAP_ZEEK_FLEET, Constants.FEATURE_PCAP_SURICATA_FLEET];
const FEATURES = [...ENGINE_FEATURES, Constants.FEATURE_PCAP_ZEEK, Constants.FEATURE_PCAP_SURICATA];
// net2/config.js merges cloud, MSP and version configuration, which
// platform.sh cannot; the effective values are written here for it to read
const EFFECTIVE_FEATURES = '/dev/shm/fleet-engine.features';
// fleet-engine.sh holds this from the first change it makes until verification
// succeeds, so a failed or interrupted apply leaves it behind. While it is
// there BroControl.restart, SuricataControl.restart and the script's own
// restart path refuse to start the pcap services.
const FAILED_MARKER = FlowEngine.APPLY_FAILED_MARKER;

class FleetEnginePlugin extends Sensor {
  async run() {
    this.applyJob = new scheduler.UpdateJob(this.apply.bind(this), 3000);

    // Subscribe before the first apply: a feature that moves while that apply
    // is running would never be replayed to a listener registered afterwards,
    // leaving stale drop-ins with nothing to trigger a retry.
    for (const feature of FEATURES) {
      fc.onFeature(feature, (name, status) => {
        if (name !== feature) return;
        log.info(`Feature ${name} is now ${status ? 'on' : 'off'}: zeek role -> ${FlowEngine.zeekEngine()}, suricata role -> ${FlowEngine.suricataEngine()}`);
        this.applyJob.exec().catch((err) => {
          log.error('Failed to apply flow engine change', err.message);
        });
      });
    }

    // Reconcile the drop-ins with the features, for the case where FireMain
    // started without main-start (a plain `systemctl restart firemain`). The
    // services keep running the previous engine unless they are restarted, so
    // restart when the applied state changed, or when main-start's own apply
    // failed and left the services held back.
    const heldBack = fs.existsSync(FAILED_MARKER);
    const before = `${FlowEngine.appliedZeekEngine()}/${FlowEngine.appliedSuricataEngine()}`;
    const wanted = () => FEATURES.map(name => `${name}=${fc.isFeatureOn(name)}`).join(',');
    const wantedBefore = wanted();
    await this.apply(false).then(() => {
      const after = `${FlowEngine.appliedZeekEngine()}/${FlowEngine.appliedSuricataEngine()}`;
      if (heldBack || after !== before) {
        log.info(`flow engine reconciled at startup: ${before} -> ${after}${heldBack ? ' (was held back)' : ''}`);
        sem.emitLocalEvent({ type: Message.MSG_PCAP_RESTART_NEEDED });
      }
      // a feature that changed while that ran is applied now
      if (wanted() !== wantedBefore) {
        log.info('features changed during the initial apply, applying again');
        this.applyJob.exec().catch((err) => log.error('Failed to re-apply flow engine', err.message));
      }
    }).catch((err) => {
      log.error('Initial flow engine apply failed', err.message);
    });

    // The binary is an asset: when it first arrives (or disappears) with a
    // feature on, the effective engines change with no feature event, so watch
    // for that and re-apply, which also re-picks the cron templates. A failed
    // apply leaves the services held back, so keep retrying that too.
    this.fleetAvailable = FlowEngine.fleetAvailable();
    setInterval(() => {
      if (fs.existsSync(FAILED_MARKER)) {
        this.applyJob.exec().catch((err) => log.error('Retrying flow engine apply', err.message));
        return;
      }
      const available = FlowEngine.fleetAvailable();
      if (available === this.fleetAvailable) return;
      this.fleetAvailable = available;
      if (ENGINE_FEATURES.some(name => fc.isFeatureOn(name))) {
        log.info(`fleet binary ${available ? 'arrived' : 'went missing'}: zeek role -> ${FlowEngine.zeekEngine()}, suricata role -> ${FlowEngine.suricataEngine()}`);
        this.applyJob.exec().catch((err) => {
          log.error('Failed to apply flow engine change', err.message);
        });
      }
    }, 30000);
  }

  // hand the shell side the effective feature values before it decides
  publishFeatures() {
    const state = {};
    for (const name of FEATURES) state[name] = fc.isFeatureOn(name);
    // atomically: a shell reader must never see a truncated document, or it
    // would fall through to the config files and pick different roles
    const tmp = `${EFFECTIVE_FEATURES}.${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o644 });
      fs.renameSync(tmp, EFFECTIVE_FEATURES);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (e) {}
      // the shell side would fall back to a stale file, or to the config
      // files, and could apply the opposite engine: do not apply at all
      throw new Error(`publishing the effective flow engine features failed: ${err.message}`);
    }
  }

  async apply(restart = true) {
    // the shell side reads these; a stale file would make it apply the
    // opposite engine, so this throws rather than continue
    this.publishFeatures();
    const script = `${f.getFirewallaHome()}/scripts/fleet-engine.sh`;
    let applied = false;
    await exec(`sudo ${script} apply`).then((r) => {
      applied = true;   // fleet-engine.sh cleared its hold on success
      if (r.stdout && r.stdout.trim()) log.info('fleet-engine:', r.stdout.trim().replace(/\n/g, '; '));
    }).catch((err) => {
      // the drop-ins are not what the features say: restarting now would
      // apply stale ones, so leave the services alone and try again next time
      log.error('fleet-engine.sh apply failed, services left as they are', err.message);
    });
    if (restart && applied) {
      sem.emitLocalEvent({ type: Message.MSG_PCAP_RESTART_NEEDED });
    }
    if (!applied) throw new Error('fleet-engine.sh apply failed');
  }
}

module.exports = FleetEnginePlugin;
