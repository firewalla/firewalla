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

// lodash only: EventApi puts EventClassifier, and so this module, in every process's require graph
const _ = require('lodash');

const isNonEmptyString = k => _.isString(k) && k.length > 0;

/*
 * Checks the parts a filter + eventKeys/labelKeys setting shares between EventClassifier and
 * EventSummarySensor. Returns { eventKeys, labelKeys } normalized to arrays, or { error } holding
 * the log arguments that follow the caller's "Ignoring <name> setting" prefix.
 */
function checkKeySettings(setting) {
  if (!_.isObject(setting) || !setting.key)
    return { error: ['without a key', setting] };
  // matchFilter() returns false for an empty node, a setting without a filter would silently
  // never match, which is far more confusing than dropping it here
  if (_.isEmpty(setting.filter))
    return { error: [`${setting.key} without a filter`] };
  // silently coercing a malformed list to [] would produce WRONG GROUPING rather than the
  // "setting ignored" degradation the callers are contracted to provide
  if ((!_.isUndefined(setting.eventKeys) && !_.isArray(setting.eventKeys)) ||
      (!_.isUndefined(setting.labelKeys) && !_.isArray(setting.labelKeys)))
    return { error: [`${setting.key} with a non-array eventKeys/labelKeys`] };
  const eventKeys = setting.eventKeys || [];
  const labelKeys = setting.labelKeys || [];
  // event[null] or event[''] would create a field literally named "null"/""
  if (!eventKeys.every(isNonEmptyString) || !labelKeys.every(isNonEmptyString))
    return { error: [`${setting.key} with a non-string key in eventKeys/labelKeys`] };
  if (_.isEmpty(eventKeys) && _.isEmpty(labelKeys))
    return { error: [`${setting.key} without eventKeys or labelKeys`] };
  return { eventKeys, labelKeys };
}

// Resolves names against source as [name, value] pairs. isNil->null matters: JSON.stringify([undefined])
// is "[null]", so a missing field would otherwise collide with a literal null while the stored field
// is dropped. coerceObjects maps a non-primitive to null too, since JSON.stringify's key order for an
// object is insertion-dependent and would make a key built from it unstable.
function resolveValues(names, source, coerceObjects) {
  return names.map(k => {
    const v = source[k];
    return [k, (_.isNil(v) || (coerceObjects && _.isObject(v))) ? null : v];
  });
}

module.exports = { checkKeySettings, resolveValues };
