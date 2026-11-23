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

const _ = require('lodash');
const net = require('net');

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const fc = require('../net2/config.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const LogReader = require('../util/LogReader.js');
const era = require('../event/EventRequestApi.js');
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const FEATURE_NAME = 'aca';
const DEFAULT_LOG_FILE = '/blog/current/aca.log';
const DEFAULT_COOLDOWN = 3600;
const COOLDOWN_KEY_PREFIX = 'aca:cooldown:';
const EVENT_TYPE = 'aca_finding';

// Turns zssids abnormal connection findings (aca.log) into alarms and events
class AcaLogPlugin extends Sensor {
  constructor(config) {
    super(config);
    this.logReader = null;
  }

  // LogReader cannot be stopped, so it always runs and processLine checks the feature switch
  async run() {
    const logFile = this.config.logFile || DEFAULT_LOG_FILE;
    this.logReader = new LogReader(logFile);
    this.logReader.on('line', this.processLine.bind(this));
    this.logReader.watch();
  }

  async processLine(line) {
    if (!fc.isFeatureOn(FEATURE_NAME)) {
      return;
    }

    if (_.isEmpty(line)) {
      return;
    }
    let finding = null;
    try {
      finding = JSON.parse(line);
    } catch (err) {
      log.warn('Failed to parse aca.log line', line);
      return;
    }
    if (!finding || !finding.type || !finding.src || typeof finding.ts !== 'number') {
      return;
    }

    // 1. Build context
    const context = await this.buildContext(finding);
    if (!context) {
      return;
    }
    await this.addLearnedInfo(context);
    await this.addCloudInfo(context);

    // 2. Update device summary
    await this.updateDeviceSummary(context);

    // 3. Decide by rules
    const rule = this.findRule(context);
    if (!rule || rule.action === 'drop') {
      return;
    }
    if (rule.action !== 'alarm' && rule.action !== 'event') {
      log.warn(`Rule ${rule.name} has an unknown action ${rule.action}`);
      return;
    }
    // each kind of finding has its own switch under the aca feature
    if (rule.feature && !fc.isFeatureOn(rule.feature)) {
      return;
    }
    // alarms follow the cyber security switch, checked before the cooldown so turning it on again is not held back
    if (rule.action === 'alarm' && !am2.isCyberSecurityEnabled()) {
      return;
    }

    // 4. Cool down
    const cooldownKey = this.getCooldownKey(rule, context);
    const started = await this.startCooldown(cooldownKey, rule);
    if (!started) {
      log.info(`Skip ${finding.type} of ${context.device.id}, cooling down by rule ${rule.name}`);
      return;
    }

    // 5. Send alarm or event
    try {
      if (rule.action === 'alarm') {
        await this.sendAlarm(rule, context, cooldownKey);
      } else {
        await this.sendEvent(rule, context);
      }
    } catch (err) {
      // nothing went out, so the next finding of the same kind may try again
      await rclient.delAsync(cooldownKey).catch(() => {});
      throw err;
    }
  }

  async buildContext(finding) {
    // a finding is about its source device, except types like brute_force whose source is the outside attacker
    let side = 'src';
    const typesAboutDst = this.config.deviceFromDst || [];
    if (typesAboutDst.includes(finding.type)) {
      side = 'dst';
    }

    let ip = finding.src;
    let mac = null;
    if (side === 'dst') {
      ip = finding.dst;
    } else if (finding.src_l2_addr) {
      // aca.log writes MACs in lower case, the box stores them in upper case
      mac = finding.src_l2_addr.toUpperCase();
    }
    if (!ip) {
      log.verbose(`Skip ${finding.type}, it has no ${side} address`);
      return null;
    }

    // aca.log has no MAC for the destination, nor for a routed or tunneled source, so it comes from the box's address records
    if (!mac) {
      const macEntry = await hostTool.getMacEntryByIPRecord(ip);
      if (macEntry && macEntry.mac) {
        mac = macEntry.mac.toUpperCase();
      }
    }

    const deviceFields = await am2.getDeviceAlarmFields({ ip: ip, mac: mac, withIntf: true });
    if (!deviceFields) {
      log.verbose(`Skip ${finding.type}, unknown device ${ip} ${mac || ''}`);
      return null;
    }

    const deviceId = deviceFields['p.device.mac'];
    const monitorable = await hostManager.getIdentityOrHost(deviceId);
    if (!monitorable) {
      log.verbose(`Skip ${finding.type}, device ${deviceId} not found`);
      return null;
    }

    // devices the user stopped monitoring get neither alarms nor events
    const isRecordingOn = await hostTool.isRecordingOn(monitorable, deviceFields['p.intf.id']);
    if (!isRecordingOn) {
      return null;
    }

    // fan_out samples sharing one /24 look like a sweep of a subnet, not a broken network
    let sample = _.get(finding, ['evidence', 'sample']);
    if (!Array.isArray(sample)) {
      sample = [];
    }
    let sampleInOneSubnet = sample.length >= 2;
    let firstPrefix = null;
    for (const address of sample) {
      if (!net.isIPv4(address)) {
        sampleInOneSubnet = false;
        break;
      }
      const prefix = address.split('.').slice(0, 3).join('.');
      if (firstPrefix === null) {
        firstPrefix = prefix;
      } else if (prefix !== firstPrefix) {
        sampleInOneSubnet = false;
        break;
      }
    }

    const findingInfo = Object.assign({}, finding, {
      hasDomain: !_.isEmpty(finding.domain),
      sampleInOneSubnet: sampleInOneSubnet,
    });

    // same precedence as DeviceIdentificationSensor: the user's own choice wins
    const deviceType = _.get(monitorable, ['o', 'detect', 'feedback', 'type']) || _.get(monitorable, ['o', 'detect', 'type']) || null;
    const vendor = (_.get(monitorable, ['o', 'macVendor']) || '').toLowerCase();
    const brand = (_.get(monitorable, ['o', 'detect', 'brand']) || '').toLowerCase();

    const deviceInfo = {
      id: deviceId,
      side: side,
      name: monitorable.getReadableName(),
      type: deviceType,
      isFirewalla: vendor.includes('firewalla') || brand.includes('firewalla'),
      alarmFields: deviceFields,
    };

    return {
      finding: findingInfo,
      device: deviceInfo,
      learned: {},
      cloud: {},
      summary: {},
    };
  }

  // Reserved: fill context.learned with what the box learned about the device
  async addLearnedInfo(context) {
  }

  // Reserved: fill context.cloud with intel and verdicts from the cloud
  async addCloudInfo(context) {
  }

  // Reserved: keep per-device counts of recent findings in context.summary
  async updateDeviceSummary(context) {
  }

  // the first rule whose conditions all hold: a list means one of its values, anything else an exact value
  findRule(context) {
    const rules = this.config.rules || [];
    for (const rule of rules) {
      const conditions = rule.match || {};
      let matched = true;
      for (const path of Object.keys(conditions)) {
        const expected = conditions[path];
        const actual = _.get(context, path);
        if (Array.isArray(expected)) {
          matched = expected.includes(actual);
        } else {
          matched = actual === expected;
        }
        if (!matched) {
          break;
        }
      }
      if (matched) {
        return rule;
      }
    }
    return null;
  }

  getCooldownKey(rule, context) {
    const dedupBy = rule.dedupBy || ['device.id'];
    const values = [];
    for (const path of dedupBy) {
      values.push(String(_.get(context, path)));
    }
    return `${COOLDOWN_KEY_PREFIX}${rule.name}:${values.join('|')}`;
  }

  // true when no cooldown was running and one has just started
  async startCooldown(cooldownKey, rule) {
    const seconds = rule.cooldown || this.config.defaultCooldown || DEFAULT_COOLDOWN;
    const result = await rclient.setAsync(cooldownKey, '1', 'NX', 'EX', seconds);
    return result === 'OK';
  }

  async sendAlarm(rule, context, cooldownKey) {
    const finding = context.finding;
    const payload = Object.assign({}, context.device.alarmFields, {
      'p.dest.ip': finding.dst,
      'p.dest.port': finding.dst_p,
      'p.dest.name': finding.domain || finding.dst,
      'p.protocol': finding.proto,
      'p.aca.type': finding.type,
      'p.aca.message': finding.msg,
      'p.aca.rule': rule.name,
      'p.aca.evidence': JSON.stringify(finding.evidence || {}),
      'p.aca.dedup': cooldownKey,
    });
    const cleanPayload = _.omitBy(payload, _.isNil);

    const alarm = new Alarm.AcaAlarm(finding.ts, context.device.alarmFields['p.device.ip'], cleanPayload);
    log.info(`Alarm ${finding.type} of ${context.device.id} by rule ${rule.name}`);
    const saved = await am2.enqueueAlarm(alarm);
    if (!saved) {
      throw new Error(`Failed to enqueue ${finding.type} alarm of ${context.device.id}`);
    }
  }

  async sendEvent(rule, context) {
    const finding = context.finding;
    const labels = _.omitBy({
      type: finding.type,
      message: finding.msg,
      rule: rule.name,
      deviceId: context.device.id,
      deviceIp: context.device.alarmFields['p.device.ip'],
      deviceName: context.device.name,
      dst: finding.dst,
      dstPort: finding.dst_p,
      domain: finding.domain,
    }, _.isNil);

    // only logged for the app's event list, ACA events are not pushed to the phone
    log.info(`Event ${finding.type} of ${context.device.id} by rule ${rule.name}`);
    const published = await era.addActionEvent(EVENT_TYPE, 1, labels, Math.round(finding.ts * 1000));
    if (!published) {
      throw new Error(`Failed to publish ${finding.type} event of ${context.device.id}`);
    }
  }
}

module.exports = AcaLogPlugin;
