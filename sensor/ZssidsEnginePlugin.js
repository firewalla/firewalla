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

// On a live toggle of the pcap engine features, re-applies the systemd drop-ins and restarts the pcap services; at boot main-start does it.

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const fc = require('../net2/config.js');
const f = require('../net2/Firewalla.js');
const Constants = require('../net2/Constants.js');
const Message = require('../net2/Message.js');
const sem = require('./SensorEventManager.js').getInstance();
const scheduler = require('../util/scheduler.js');
const execFile = require('child-process-promise').execFile;
const FlowEngine = require('../net2/FlowEngine.js');
const CloudConfigLoader = require('./CloudConfigLoader.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const rclient = require('../util/redis_manager.js').getRedisClient();
const fs = require('fs');
const _ = require('lodash');

// which program runs each pcap role: zssids or the original zeek / suricata
const ENGINE_FEATURES = [Constants.FEATURE_PCAP_ZEEK_ZSSIDS, Constants.FEATURE_PCAP_SURICATA_ZSSIDS];
// the roles themselves count too: turning the flow role off moves the IDS into its own zssids
const FEATURES = [...ENGINE_FEATURES, Constants.FEATURE_PCAP_ZEEK, Constants.FEATURE_PCAP_SURICATA];
// platform.sh can't merge cloud/MSP/version config, so FireMain writes the final values here for it
const EFFECTIVE_FEATURES = '/dev/shm/zssids-engine.features';
// left by zssids-engine.sh when an apply fails; while it exists the pcap services are not started
const FAILED_MARKER = FlowEngine.APPLY_FAILED_MARKER;

class ZssidsEnginePlugin extends Sensor {
  async run() {
    // runs apply() 3s after a request, one at a time, merging requests that arrive meanwhile
    this.applyJob = new scheduler.UpdateJob(this.apply.bind(this), 3000);

    // this box's part of zssids:config from the cloud, e.g. { pcap_zeek_zssids: false }
    this.cloudOverride = {};
    this.cloudConfigLoader = new CloudConfigLoader({
      cacheKey: Constants.REDIS_KEY_ZSSIDS_CLOUD_CONFIG,
      hashsetName: Constants.KEY_ZSSIDS_CONFIG,
      label: 'zssids',
      apply: cloudConfig => this.applyCloudConfig(cloudConfig),
      acceptEmpty: true   // an emptied config withdraws the override
    });
    this.cloudConfigStarted = false;
    await this.cloudConfigLoader.start();
    this.cloudConfigStarted = true;

    // subscribe before the first apply, so a toggle during that apply is not missed
    for (const feature of FEATURES) {
      fc.onFeature(feature, (name, status) => {
        if (name !== feature) {
          return;
        }
        log.info(`Feature ${name} is now ${status ? 'on' : 'off'}, wanted: ${this.wantedFeatures()}`);
        this.requestApply();
      });
    }

    await this.applyAtStartup();

    // the zssids binary is an asset that can arrive or disappear later, which changes the engines with no feature event
    this.zssidsAvailable = FlowEngine.zssidsAvailable();
    setInterval(() => this.checkEveryThirtySeconds(), 30000);
  }

  // FireMain may have restarted alone (no main-start), so the drop-ins can be out of date
  async applyAtStartup() {
    const wasHeldBack = fs.existsSync(FAILED_MARKER);
    const enginesBeforeApply = `${FlowEngine.appliedZeekEngine()}/${FlowEngine.appliedSuricataEngine()}`;

    try {
      await this.apply(false);
    } catch (err) {
      // apply() left applyFailed set, so the 30s check keeps retrying
      log.error('Initial flow engine apply failed', err.message);
      return;
    }

    // restart only when something changed, so a normal boot doesn't interrupt the services main-start just started
    const enginesAfterApply = `${FlowEngine.appliedZeekEngine()}/${FlowEngine.appliedSuricataEngine()}`;
    const enginesChanged = enginesAfterApply !== enginesBeforeApply;
    if (enginesChanged || wasHeldBack) {
      log.info(`flow engine reconciled at startup: ${enginesBeforeApply} -> ${enginesAfterApply}${wasHeldBack ? ' (was held back)' : ''}`);
      sem.emitLocalEvent({ type: Message.MSG_PCAP_RESTART_NEEDED });
    }
  }

  checkEveryThirtySeconds() {
    // a failed apply leaves the services held back, so keep retrying until one succeeds
    if (this.applyFailed || fs.existsSync(FAILED_MARKER)) {
      this.requestApply();
      return;
    }

    const available = FlowEngine.zssidsAvailable();
    if (available === this.zssidsAvailable) {
      return;
    }
    this.zssidsAvailable = available;

    const anyEngineFeatureOn = ENGINE_FEATURES.some(name => this.featureOn(name));
    if (!anyEngineFeatureOn) {
      return;
    }
    log.info(`zssids binary ${available ? 'arrived' : 'went missing'}, wanted: ${this.wantedFeatures()}`);
    this.requestApply();
  }

  requestApply() {
    this.applyJob.exec().catch((err) => {
      log.error('Failed to apply flow engine change', err.message);
    });
  }

  // a value set from the app (sys:features) wins over the cloud override, which wins over the config files
  featureOn(name) {
    const dynamicFeatures = fc.getDynamicFeatures() || {};
    if (name in dynamicFeatures) {
      return fc.isFeatureOn(name);
    }
    if (name in this.cloudOverride) {
      return this.cloudOverride[name];
    }
    return fc.isFeatureOn(name);
  }

  // e.g. "pcap_zeek_zssids=true,pcap_suricata_zssids=false,...", compared to tell whether anything changed
  wantedFeatures() {
    return FEATURES.map(name => `${name}=${this.featureOn(name)}`).join(',');
  }

  async applyCloudConfig(cloudConfig) {
    const platformName = platform.getName();
    const releaseType = f.getReleaseType();
    const section = _.get(cloudConfig, [platformName, releaseType]) || {};
    const override = {};
    for (const name of ENGINE_FEATURES) {
      if (typeof section[name] === 'boolean') {
        override[name] = section[name];
      }
    }

    // platform.sh reads this at early boot, before FireMain publishes the effective features
    try {
      if (_.isEmpty(override)) {
        await rclient.unlinkAsync(Constants.REDIS_KEY_ZSSIDS_CLOUD_OVERRIDE);
      } else {
        await rclient.setAsync(Constants.REDIS_KEY_ZSSIDS_CLOUD_OVERRIDE, JSON.stringify(override));
      }
    } catch (err) {
      log.error('Failed to save the zssids cloud override for early boot', err.message);
    }

    const featuresBeforeCloud = this.wantedFeatures();
    this.cloudOverride = override;
    const featuresAfterCloud = this.wantedFeatures();

    // start() only applies the cache; run() does the first apply right after it
    if (!this.cloudConfigStarted) {
      return;
    }
    // e.g. a value set from the app hides the cloud change
    if (featuresAfterCloud === featuresBeforeCloud) {
      return;
    }
    log.info(`zssids cloud config for ${platformName}/${releaseType} is now ${JSON.stringify(override)}, wanted: ${featuresAfterCloud}`);
    this.requestApply();
  }

  // a stale or truncated file would make the shell side pick the opposite engine, so this throws instead
  publishFeatures() {
    const state = {};
    for (const name of FEATURES) {
      state[name] = this.featureOn(name);
    }

    const tmpFile = `${EFFECTIVE_FEATURES}.${process.pid}`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(state), { mode: 0o644 });
      fs.renameSync(tmpFile, EFFECTIVE_FEATURES);
    } catch (err) {
      try {
        fs.unlinkSync(tmpFile);
      } catch (e) {
        // the temp file may not exist
      }
      throw new Error(`publishing the effective flow engine features failed: ${err.message}`);
    }
  }

  async apply(restart = true) {
    // stays set unless the whole apply succeeds, so the 30s check keeps retrying
    this.applyFailed = true;
    this.publishFeatures();

    const script = `${f.getFirewallaHome()}/scripts/zssids-engine.sh`;
    let result;
    try {
      result = await execFile('sudo', [script, 'apply']);
    } catch (err) {
      // restarting now would run the stale drop-ins, so the services are left alone
      log.error('zssids-engine.sh apply failed, services left as they are', err.message);
      throw new Error('zssids-engine.sh apply failed');
    }
    this.applyFailed = false;

    const output = result.stdout && result.stdout.trim();
    if (output) {
      log.info('zssids-engine:', output.replace(/\n/g, '; '));
    }
    if (restart) {
      sem.emitLocalEvent({ type: Message.MSG_PCAP_RESTART_NEEDED });
    }
  }
}

module.exports = ZssidsEnginePlugin;
