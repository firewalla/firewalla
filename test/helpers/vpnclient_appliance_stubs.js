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

// Explicit import boundaries for the isolated VPNClient tests. Keep validation,
// address parsing, filesystem operations and lifecycle locking real.
module.exports = () => ({
  '../../net2/logger.js': () => ({
    info() {}, error() {}, warn() {}, debug() {}, verbose() {}
  }),
  '../../net2/config.js': {},
  '../../sensor/SensorEventManager.js': { getInstance: () => ({ emitEvent() {} }) },
  '../routing/routing.js': {},
  '../../net2/Iptables.js': {},
  '../../control/IptablesControl.js': {},
  '../../net2/Ipset.js': {},
  '../../net2/SysManager': {},
  '../../platform/PlatformLoader.js': { getPlatform: () => ({}) },
  '../../net2/FireRouter.js': {},
  '../../util/scheduler.js': {}
});
