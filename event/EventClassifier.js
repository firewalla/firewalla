/*    Copyright 2016-2026 Firewalla Inc.
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

const _ = require('lodash');
const rclient = require('../util/redis_manager.js').getRedisClient();
const Constants = require('../net2/Constants.js');
const { matchFilter } = require('../sensor/BlockStatsFilter.js');

/*
 * EventClassifier decides which "type" an event belongs to, so EventApi can stamp every event
 * written to event:log with a last_ts - the ts of the previous event of that same type.
 *
 * A setting matches an event with "filter" and then derives the type key from "eventKeys"
 * (resolved against the event's TOP-LEVEL fields) plus "labelKeys" (resolved against
 * event.labels). The FIRST matching setting wins, so the order of the settings array is
 * load-bearing - and since a non-empty cloud config replaces the local array wholesale, a
 * cloud push can reorder that precedence.
 *
 * There are two tiers:
 *   - the CONFIGURED settings, shipped as the default in net2/config.json under
 *     sensors.EventSensor.eventClassifierSettings and replaceable wholesale from the cloud. These
 *     are the type-specific rules.
 *   - FALLBACK_SETTINGS below, hardcoded and NOT overridable, applied to any event no configured
 *     setting matched: a state event always classifies on state_type + state_key + state_value and
 *     an action event always on action_type.
 * So configuration can only ever REFINE how an event is grouped, never remove it from tracking -
 * the only events left unclassified are the ones that are neither state nor action.
 *
 * NOTE: the returned key is persisted as a field name in event:last:cache for as long as
 * EventSensor's latestStateEventsExpire (30 days by default), so this encoding is frozen: a
 * setting that changes its key composition (adding/removing/reordering eventKeys or
 * labelKeys) must be given a NEW "key" rather than edited in place. Editing in place orphans
 * the old fields - they keep occupying the cache until they expire - and restarts last_ts
 * from null for everything that setting covers.
 */

// The always-on floor, applied to anything the configured settings did not match, and the only
// thing the classifier runs on before loadConfig() completes. Deliberately NOT configurable: it is
// what guarantees every state and every action gets a last_ts at all. Type-specific rules belong in
// net2/config.json (sensors.EventSensor.eventClassifierSettings), which the cloud can replace.
const FALLBACK_SETTINGS = [
  {
    key: "state",
    filter: { field: "event_type", value: "state" },
    eventKeys: ["state_type", "state_key", "state_value"]
  },
  {
    key: "action",
    filter: { field: "event_type", value: "action" },
    eventKeys: ["action_type"]
  }
];

class EventClassifier {
  constructor() {
    // validated synchronously: controllers/netbot.js adds firewalla_upgrade from a 20s setTimeout
    // in its constructor with no ordering guarantee against APISensorLoader, and on platforms
    // where isEventsSupported() is false EventSensor early-returns and never calls loadConfig()
    // at all, while netbot still writes to event:log. Classification has to work with zero config
    // loads, which it does - until loadConfig() lands, everything falls through to here.
    this.fallbackSettings = this._validateSettings(FALLBACK_SETTINGS);
    this.settings = [];
  }

  async loadConfig(forceReload = false) {
    await this.loadCloudConfig(forceReload).catch((err) => {
      log.error(`Failed to load event classifier config from cloud`, err.message);
    });
    // eventClassifierSettings is an array of objects, _.merge on arrays merges by index rather
    // than concatenating/keying by "key", so the cloud config (when present) fully replaces the
    // local default array rather than being deep-merged with it
    const cloudSettings = this.cloudConfig && this.cloudConfig.eventClassifierSettings;
    // read the local default straight from the config rather than from a Sensor's this.config:
    // apiSensors.EventSensor is {} while sensors.EventSensor is the populated block, and
    // APISensorLoader only pushes the latter into FireApi sensors on a later config:updated
    const fc = require('../net2/config.js');
    const localSettings = _.get(fc.getConfig(), ["sensors", "EventSensor", "eventClassifierSettings"]);
    // no need to guard against an empty or fully-invalid result here - classify() falls back to
    // FALLBACK_SETTINGS for anything these settings don't match, so the worst a bad push can do
    // is leave the catch-all grouping in place
    this.settings = this._validateSettings((!_.isEmpty(cloudSettings) ? cloudSettings : localSettings) || []);
  }

  async loadCloudConfig(reload = false) {
    let cfg = await rclient.getAsync(Constants.REDIS_KEY_EVENT_CLASSIFIER_CLOUD_CONFIG).then(r => r && JSON.parse(r)).catch(() => null);
    this.cloudConfig = cfg;
    if (_.isEmpty(cfg) || reload) {
      // required lazily, EventApi is in the require graph of every process and lib/Bone.js is heavy
      const bone = require('../lib/Bone.js');
      cfg = await bone.hashsetAsync(Constants.KEY_EVENT_CLASSIFIER_CONFIG).then(r => r && JSON.parse(r)).catch(() => null);
      if (!_.isEmpty(cfg) && _.isObject(cfg)) {
        await rclient.setAsync(Constants.REDIS_KEY_EVENT_CLASSIFIER_CLOUD_CONFIG, JSON.stringify(cfg));
        this.cloudConfig = cfg;
      }
    }
  }

  // drops unusable settings, so a bad cloud push degrades to "this setting is ignored" rather
  // than to events being grouped under a wrong or NaN-shaped key
  _validateSettings(settings) {
    const valid = [];
    if (!_.isArray(settings)) {
      log.error('Ignoring non-array event classifier settings', settings);
      return valid;
    }
    for (const setting of settings) {
      if (!_.isObject(setting) || !setting.key) {
        log.error('Ignoring event classifier setting without a key', setting);
        continue;
      }
      // matchFilter() returns false for an empty node, a setting without a filter would silently
      // never match, which is far more confusing than dropping it here
      if (_.isEmpty(setting.filter)) {
        log.error(`Ignoring event classifier setting ${setting.key} without a filter`);
        continue;
      }
      // silently coercing a malformed list to [] would produce WRONG GROUPING rather than the
      // "setting ignored" degradation this function is contracted to provide
      if ((!_.isUndefined(setting.eventKeys) && !_.isArray(setting.eventKeys)) ||
          (!_.isUndefined(setting.labelKeys) && !_.isArray(setting.labelKeys))) {
        log.error(`Ignoring event classifier setting ${setting.key} with a non-array eventKeys/labelKeys`);
        continue;
      }
      const eventKeys = setting.eventKeys || [];
      const labelKeys = setting.labelKeys || [];
      const isNonEmptyString = k => _.isString(k) && k.length > 0;
      if (!eventKeys.every(isNonEmptyString) || !labelKeys.every(isNonEmptyString)) {
        log.error(`Ignoring event classifier setting ${setting.key} with a non-string key in eventKeys/labelKeys`);
        continue;
      }
      if (_.isEmpty(eventKeys) && _.isEmpty(labelKeys)) {
        log.error(`Ignoring event classifier setting ${setting.key} without eventKeys or labelKeys`);
        continue;
      }
      valid.push(Object.assign({}, setting, { eventKeys, labelKeys }));
    }
    return valid;
  }

  // Resolves setting.eventKeys against the top-level event, then setting.labelKeys against
  // event.labels, into a single ordered value list - outer first, then labels.
  // The isNil->null matters: JSON.stringify([undefined]) is "[null]", so without it an event
  // missing a field would land on the same key as an event whose field is literally null.
  // A non-primitive is coerced to null as well: JSON.stringify's key order for an object is
  // insertion-dependent, which would make the cache field name unstable for the same event.
  _resolveKeyValues(setting, event) {
    const labels = event.labels || {};
    return setting.eventKeys.map(k => {
      const v = event[k];
      return (_.isNil(v) || _.isObject(v)) ? null : v;
    }).concat(setting.labelKeys.map(k => {
      const v = labels[k];
      return (_.isNil(v) || _.isObject(v)) ? null : v;
    }));
  }

  /*
   * Returns the cache field name identifying this event's "type", or null when no setting
   * matches (in which case the event gets no last_ts at all).
   * The values are JSON-encoded so the key is both human-readable and collision-free (a plain
   * string join could conflate e.g. a="AA",b="BCC" with a="AAB",b="CC"), and setting.key is
   * prefixed so two settings resolving to the same value tuple stay distinct.
   */
  classify(event) {
    if (!_.isObject(event)) return null;
    return this._classifyWith(this.settings, event) || this._classifyWith(this.fallbackSettings, event);
  }

  _classifyWith(settings, event) {
    for (const setting of settings) {
      if (!matchFilter(setting.filter, event)) continue;
      return `${setting.key}::${JSON.stringify(this._resolveKeyValues(setting, event))}`;
    }
    return null;
  }
}

module.exports = new EventClassifier();
module.exports.FALLBACK_SETTINGS = FALLBACK_SETTINGS;
