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

module.exports = { matchFilter, isValidFilter, countUniqueDests, countUniqueDestFields };
