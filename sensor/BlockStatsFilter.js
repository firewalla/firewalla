/*    Copyright 2016-2025 Firewalla Inc.
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
const Constants = require('../net2/Constants.js');

// identityKey entries: 'device' (the mac or VPN GUID itself) or a tag flowKey, e.g. userTags
const TAG_PREFIX_BY_FLOW_KEY = _.fromPairs(Object.values(Constants.TAG_TYPE_MAP).map(t => [t.flowKey, t.ruleTagPrefix]));
const IDENTITY_KEYS = ['device', ...Object.keys(TAG_PREFIX_BY_FLOW_KEY)];
// aggrCounter dimensions, event fields of bounded cardinality, so the number of counters stays bounded
const COUNTER_DIMENSIONS = ['bTarget', 'pid'];

// node:
//   { field, value }              -- leaf: exact-equality test
//   { and: [node, node, ...] }    -- all children must match
//   { or:  [node, node, ...] }    -- at least one child must match
function matchFilter(node, obj) {
  if (!node) return false;
  if (Array.isArray(node.and)) return node.and.every(child => matchFilter(child, obj));
  if (Array.isArray(node.or)) return node.or.some(child => matchFilter(child, obj));
  if ('field' in node) return obj[node.field] === node.value;
  return false;
}

// whether matchFilter can walk the tree without throwing, an empty and/or, or a leaf without a field
// name or a value, would match everything
function isValidFilter(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.and)) return node.and.length > 0 && node.and.every(isValidFilter);
  if (Array.isArray(node.or)) return node.or.length > 0 && node.or.every(isValidFilter);
  return typeof node.field === 'string' && node.field.length > 0 && 'value' in node;
}

// with device in destKeys, the same dest hit from two devices counts once
function countUniqueDests(dests) {
  return new Set(dests.map(d => d.dest)).size;
}

// { <field>Cnt: number of unique values } for each dest field but cnt, e.g. deviceCnt, destCnt
function countUniqueDestFields(dests) {
  const values = {};
  for (const d of dests) {
    for (const [field, value] of Object.entries(d)) {
      if (field === 'cnt' || value === null || value === undefined) continue;
      (values[field] = values[field] || new Set()).add(value);
    }
  }
  const counts = {};
  for (const field of Object.keys(values)) counts[`${field}Cnt`] = values[field].size;
  return counts;
}

// the aggrCounter of a setting with its dimensions defaulted, null when it isn't usable
function parseAggrCounter(aggrCounter) {
  if (!_.isPlainObject(aggrCounter)) return null;
  const dimensions = aggrCounter.dimensions === undefined ? [] : aggrCounter.dimensions;
  if (!_.isArray(dimensions) || !dimensions.every(d => COUNTER_DIMENSIONS.includes(d))) return null;
  return { dimensions: _.uniq(dimensions) };
}

// drops unusable block stats settings, so a bad cloud push disables that setting rather than
// throwing on every event. A setting may have only an aggrCounter and no buckets (identityKey and
// destKeys). Problems are logged only when log is given
function validateBlockStatsSettings(settings, log) {
  const report = log ? (...args) => log.error(...args) : () => {};
  if (!_.isArray(settings)) {
    report('Ignoring block stats settings that are not an array', settings);
    return [];
  }
  const valid = [];
  for (let setting of settings) {
    if (!_.isObject(setting) || !_.isString(setting.key) || !setting.key || _.isEmpty(setting.filter)) {
      report('Ignoring block stats setting without a key or filter', setting);
      continue;
    }
    const { identityKey, destKeys } = setting;
    const aggrCounter = setting.aggrCounter !== undefined ? parseAggrCounter(setting.aggrCounter) : null;
    if (identityKey === undefined && destKeys === undefined) {
      if (!aggrCounter) {
        report(`Ignoring block stats setting ${setting.key} without buckets or a valid aggrCounter`, setting.aggrCounter);
        continue;
      }
      valid.push({ ...setting, aggrCounter });
      continue;
    }
    if (!_.isArray(identityKey) || _.isEmpty(identityKey) || !identityKey.every(k => IDENTITY_KEYS.includes(k))) {
      report(`Ignoring block stats setting ${setting.key} with invalid identityKey`, identityKey);
      continue;
    }
    if (!_.isArray(destKeys) || _.isEmpty(destKeys) || !destKeys.every(k => _.isString(k) && k.length > 0)) {
      report(`Ignoring block stats setting ${setting.key} with invalid destKeys`, destKeys);
      continue;
    }
    if (setting.aggrCounter !== undefined) {
      if (aggrCounter) {
        setting = { ...setting, aggrCounter };
      } else {
        report(`Ignoring invalid aggrCounter of block stats setting ${setting.key}`, setting.aggrCounter);
        setting = _.omit(setting, 'aggrCounter');
      }
    }
    valid.push(setting);
  }
  // a dimension counter key is the setting key plus "::<dimension>::<value>", so a setting key nested under
  // another counter's key could write that counter's keys
  const counterKeys = valid.filter(s => s.aggrCounter).map(s => s.key);
  return valid.flatMap(setting => {
    if (!setting.aggrCounter || !counterKeys.some(k => setting.key.startsWith(`${k}::`))) return [setting];
    report(`Ignoring aggrCounter of block stats setting ${setting.key} nested under another counter key`);
    return setting.identityKey ? [_.omit(setting, 'aggrCounter')] : [];
  });
}

// the valid settings in effect: blockStatsSettings is an array of objects, and _.merge on arrays
// merges by index rather than concatenating/keying by "key", so the cloud config (when present)
// fully replaces the local default array rather than being deep-merged with it
function effectiveBlockStatsSettings(cloudConfig, localConfig, log) {
  const cloudSettings = cloudConfig && cloudConfig.blockStatsSettings;
  const localSettings = localConfig && localConfig.blockStatsSettings;
  return validateBlockStatsSettings((!_.isEmpty(cloudSettings) ? cloudSettings : localSettings) || [], log);
}

module.exports = {
  matchFilter, isValidFilter, countUniqueDests, countUniqueDestFields,
  effectiveBlockStatsSettings, TAG_PREFIX_BY_FLOW_KEY
};
