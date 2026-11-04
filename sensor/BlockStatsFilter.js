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

module.exports = { matchFilter };
