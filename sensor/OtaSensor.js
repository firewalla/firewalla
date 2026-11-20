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

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const extensionManager = require('./ExtensionManager.js');
const sem = require('./SensorEventManager.js').getInstance();
const sysManager = require('../net2/SysManager.js');
const localApi = require('../util/localApi.js');
const otaRebootMarker = require('../util/otaRebootMarker.js');
const SysTool = require('../net2/SysTool.js');
const sysTool = new SysTool();
const NM = require('../ui/NotifyManager.js');
const nm = new NM();
const { execFile } = require('child-process-promise');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const fsp = require('fs').promises;
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));

const SCHEDULE_FILE = '/dev/shm/ota_reboot_schedule.json';
// every read-modify-write of the schedule file and its timer, so the app and the daily run don't overwrite each other
const LOCK_SCHEDULE = 'ota_reboot_schedule';
// let FireApi finish starting before a run can send a notification
const MIN_START_DELAY = 120;
const PAST_TIME_DELAY = 60;
const TIMEOUTS = { '/ota/image/check': 30000, '/ota/image/upgrade': 600000 };

class OtaSensor extends Sensor {
  constructor(config) {
    super(config);
    this.dailyTimer = null;
    this.rebootTimer = null;
    this.upgrading = null;
    // the check/upgrade run in flight, from the timer or the app
    this.running = null;
    // false, 'waiting' while reboot() checks the image, 'started' once it reboots
    this.rebooting = false;
    this.rebootSeq = 0;
    this.scheduleGen = 0;
    this.lastWindowEnd = 0;
    this.tmpSeq = 0;
  }

  async apiRun() {
    extensionManager.onSet('otaRebootSchedule', async (msg, data) => this.setSchedule(data));
    extensionManager.onGet('otaRebootSchedule', async () => this.getSchedule());
    extensionManager.onCmd('vulcan', async (msg, data) => {
      if (!data || !data.path)
        throw new Error('invalid input');
      const result = await this.apiCall(data.method || 'GET', data.path, data.body);
      if (result.code == 200)
        return result.body;
      throw new Error(`vulcan API call failed: ${result.msg || result.code}`);
    });
    extensionManager.onCmd('otaCheckUpgrade', async () => this.checkUpgrade());

    try {
      await lock.acquire(LOCK_SCHEDULE, async () => {
        const schedule = await this.readSchedule();
        if (schedule)
          await this.armRebootTimer(schedule);
      });
    } catch (err) {
      log.error('Failed to restore OTA state', err.message);
    }
    this.scheduleDailyRun();
  }

  apiCall(method, path, body) {
    return localApi.call(this.config.baseUrl, method, path, body, { timeout: TIMEOUTS[path] || 10000, errorCode: localApi.gatewayErrorCode });
  }

  // a random time in the first local [startHour, endHour) window that ends after notBefore, never before notBefore
  windowTime(notBefore, startHour, endHour) {
    const tz = sysManager.getTimezone();
    const day = (tz ? moment.unix(notBefore).tz(tz) : moment.unix(notBefore)).startOf('day');
    for (let i = 0; ; i++) {
      const d = day.clone().add(i, 'days');
      const start = this.atLocalHour(d, startHour);
      const end = this.atLocalHour(d, endHour);
      if (end > notBefore) {
        const from = Math.max(start, notBefore);
        return { time: from + Math.floor(Math.random() * (end - from)), end };
      }
    }
  }

  // set the wall clock, not add minutes to midnight, which shifts by an hour on DST days
  atLocalHour(day, hour) {
    return day.clone().set({ hour: Math.floor(hour), minute: Math.round((hour % 1) * 60) }).unix();
  }

  checkWindowTime(notBefore) {
    return this.windowTime(notBefore, this.config.checkWindowStartHour, this.config.checkWindowEndHour);
  }

  // after the check window, so an upgrade has finished before the reboot it schedules
  rebootWindowTime(notBefore) {
    return this.windowTime(notBefore, this.config.rebootWindowStartHour, this.config.rebootWindowEndHour);
  }

  scheduleDailyRun() {
    const now = Date.now() / 1000;
    // after a run, skip the rest of the window it ran in
    const { time, end } = this.checkWindowTime(Math.max(now + MIN_START_DELAY, this.lastWindowEnd));
    log.info(`Next OTA check at ${new Date(time * 1000).toISOString()}`);
    clearTimeout(this.dailyTimer);
    this.dailyTimer = setTimeout(async () => {
      this.lastWindowEnd = end;
      if (this.running)
        log.info('OTA daily run skipped, a run requested by the app is in progress');
      else
        await this.runOnce().catch((err) => log.error('OTA daily run failed', err.message));
      this.scheduleDailyRun();
    }, (time - now) * 1000);
  }

  // one check/upgrade run at a time, so vulcan never sees two upgrades
  runOnce(onCheck) {
    if (!this.running)
      this.running = this.dailyRun(onCheck).finally(() => { this.running = null; });
    return this.running;
  }

  // the app's check: answer once vulcan's check is known, an upgrade can take minutes, longer than a request waits
  async checkUpgrade() {
    if (this.rebooting === 'started')
      throw new Error('OTA reboot in progress');
    if (this.running)
      throw new Error('OTA check already in progress');
    log.info('OTA check requested by the app');
    let checked;
    const result = new Promise((resolve) => { checked = resolve; });
    this.runOnce(checked).catch((err) => {
      log.error('OTA run failed', err.message);
      checked(null);
    });
    const check = await result;
    if (!check)
      throw new Error('OTA check failed');
    return check;
  }

  async dailyRun(onCheck) {
    const image = await this.checkAndUpgrade(onCheck);
    if (!image)
      return;
    if (image.write_failed) {
      log.error(`OTA image ${image.build} write failed:`, image.write_error);
      return;
    }
    if (image.reboot_required)
      await this.onRebootRequired(image);
  }

  // check, upgrade if needed, and always end with vulcan's current image, or null if unreachable
  async checkAndUpgrade(onCheck = () => {}) {
    const check = await this.apiCall('POST', '/ota/image/check');
    if (check.code !== 200 || !check.body) {
      log.error('OTA check failed', check.code, check.msg);
      onCheck(null);
    } else {
      const { current_build, latest_build, need_upgrade } = check.body;
      const upgrade = need_upgrade === true && !this.rebooting;
      onCheck({ current_build, latest_build, need_upgrade: need_upgrade === true, upgrade_started: upgrade });
      if (upgrade) {
        log.info(`OTA upgrade ${current_build} -> ${latest_build}`);
        this.upgrading = this.apiCall('POST', '/ota/image/upgrade');
        const resp = await this.upgrading;
        this.upgrading = null;
        if (resp.code === 200 && resp.body && resp.body.image)
          return resp.body.image;
        log.error('OTA upgrade failed', resp.code, resp.msg);
      }
    }

    const resp = await this.apiCall('GET', '/ota/image');
    if (resp.code === 200 && resp.body && resp.body.image)
      return resp.body.image;
    log.error('Failed to get OTA image', resp.code, resp.msg);
    return null;
  }

  async onRebootRequired(image) {
    const settings = image.reboot_settings;
    if (!settings || !Number.isFinite(settings.grace_period) || !Number.isFinite(settings.max_delay)) {
      log.error(`OTA image ${image.build} needs a reboot but has no reboot_settings`);
      return;
    }
    await this.writeMarker(image);

    await lock.acquire(LOCK_SCHEDULE, async () => {
      let schedule = await this.readSchedule();
      if (!schedule) {
        const { time } = this.rebootWindowTime(Date.now() / 1000 + settings.grace_period);
        schedule = { time, before: Math.ceil((time + settings.max_delay) / 3600) * 3600, image };
        await this.writeSchedule(schedule);
        log.info(`OTA reboot for ${image.build} scheduled`, schedule.time, schedule.before);
        this.notifyScheduled(image, schedule);
      } else {
        // a newer build may have been written since, the app shows the one that will boot
        schedule = Object.assign({}, schedule, { image });
        await this.writeSchedule(schedule);
      }
      await this.armRebootTimer(schedule);
    });
  }

  notifyScheduled(image, schedule) {
    if (nm.canNotify() != true)
      return;
    const tz = sysManager.getTimezone();
    const t = (tz ? moment.unix(schedule.time).tz(tz) : moment.unix(schedule.time)).startOf('hour');
    const releaseType = this.releaseType(image);
    sem.sendEventToFireApi({
      type: 'FW_NOTIFICATION',
      titleKey: 'NOTIF_OTA_REBOOT_SCHEDULED_TITLE',
      bodyKey: 'NOTIF_OTA_REBOOT_SCHEDULED',
      titleLocalKey: 'OTA_REBOOT_SCHEDULED',
      bodyLocalKey: 'OTA_REBOOT_SCHEDULED',
      bodyLocalArgs: [t.format('HH:00'), t.clone().add(1, 'hour').format('HH:00'), t.format('MMM D'), releaseType],
      payload: { build: image.build, time: schedule.time, before: schedule.before, releaseType }
    });
  }

  releaseType(image) {
    return image.release_notes && image.release_notes.type || otaRebootMarker.DEFAULT_RELEASE_TYPE;
  }

  async armRebootTimer(schedule) {
    if (this.rebooting === 'started') {
      log.info('OTA reboot in progress, reboot timer not re-armed');
      return;
    }
    const now = Date.now() / 1000;
    if (schedule.time <= now) {
      if (now < schedule.before) {
        schedule = { time: now + PAST_TIME_DELAY, before: schedule.before };
      } else {
        // missed the whole range (FireApi down past it): move to the next window, same allowed delay
        const { time } = this.rebootWindowTime(now + PAST_TIME_DELAY);
        schedule = { time, before: Math.ceil((time + schedule.before - schedule.time) / 3600) * 3600, image: schedule.image };
        await this.writeSchedule(schedule);
      }
    }
    log.info(`OTA reboot timer armed for ${new Date(schedule.time * 1000).toISOString()}`);
    clearTimeout(this.rebootTimer);
    this.rebootTimer = setTimeout(() => {
      this.reboot().catch((err) => log.error('OTA reboot failed', err.message));
    }, (schedule.time - now) * 1000);
  }

  async reboot() {
    // a check can still overlap a reboot (moved by the app, or after a FireApi restart):
    // don't start an upgrade the reboot would cut short
    this.rebooting = 'waiting';
    const seq = ++this.rebootSeq;
    const gen = this.scheduleGen;
    const stop = () => {
      // an older run must not clear the flag for a newer one still waiting
      if (seq === this.rebootSeq)
        this.rebooting = false;
    };
    let resp;
    if (this.upgrading) {
      log.info('OTA reboot waits for the in-flight upgrade');
      resp = await this.upgrading;
    } else {
      // a write may have failed after the timer was armed, in an earlier daily run
      resp = await this.apiCall('GET', '/ota/image');
    }
    if (gen !== this.scheduleGen) {
      // the app moved the reboot while this run waited, the new timer owns it now
      log.info('OTA reboot superseded by a new schedule');
      stop();
      return;
    }
    const image = resp.code === 200 && resp.body && resp.body.image;
    if (!image || image.write_failed) {
      // the kernel may not boot, or vulcan can't confirm it will
      log.error('OTA reboot skipped', resp.code, resp.msg || (image && image.write_error));
      stop();
      return;
    }
    this.rebooting = 'started';
    try {
      // a newer build may have been written since the schedule was made
      await this.writeMarker(image);
      log.info(`Rebooting for OTA image ${image.build}`);
      await sysTool.rebootSystem();
    } catch (err) {
      stop();
      throw err;
    }
  }

  async setSchedule(data) {
    return lock.acquire(LOCK_SCHEDULE, async () => {
      const schedule = await this.readSchedule();
      if (!schedule)
        throw new Error('No OTA reboot schedule');
      const time = data && data.time;
      if (!Number.isFinite(time) || time <= Date.now() / 1000 || time > schedule.before)
        throw new Error(`time must be between now and ${schedule.before}`);
      const updated = Object.assign({}, schedule, { time });
      await this.writeSchedule(updated);
      // with clearTimeout in the same tick, a run already past its timer sees the change
      this.scheduleGen++;
      await this.armRebootTimer(updated);
      return updated;
    });
  }

  // read by SystemRebootSensor on the next boot to tell an OTA reboot from any other
  async writeMarker(image) {
    await otaRebootMarker.write({
      build: image.build,
      releaseNotes: image.release_notes ? image.release_notes.url : undefined,
      releaseType: this.releaseType(image)
    });
  }

  async getSchedule() {
    return (await this.readSchedule()) || {};
  }

  async readSchedule() {
    try {
      return JSON.parse(await fsp.readFile(SCHEDULE_FILE, 'utf8')).rebootSchedule;
    } catch (err) {
      if (err.code === 'ENOENT')
        return null;
      throw err;
    }
  }

  // root-owned, or systemd RemoveIPC deletes it when pi logs out;
  // renamed into place so a concurrent get never reads a partial file
  async writeSchedule(schedule) {
    const tmp = `${SCHEDULE_FILE}.${process.pid}.${++this.tmpSeq}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ rebootSchedule: schedule }));
      await execFile('sudo', ['chown', 'root:root', tmp]);
      await execFile('sudo', ['mv', '-f', tmp, SCHEDULE_FILE]);
    } catch (err) {
      await execFile('sudo', ['rm', '-f', tmp]).catch(() => {});
      throw err;
    }
  }
}

module.exports = OtaSensor;
