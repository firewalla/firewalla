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
const util = require('util');
const fs = require('fs');

const ModuleControl = require('./ModuleControl.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();

const TLS_MODULES = ['xt_tls', 'xt_udp_tls'];
const TLS_HOSTSET_BASE_PATH = '/proc/net';
const TLS_HOSTSET_FOLDER = 'hostset';

/**
 * TLSIpset
 * - Controls kernel TLS hostset "ipset-like" files under /proc/net/<module>/hostset/<setName>
 * - Queues "+domain", "-domain", and "/" (flush) operations per file
 * - Applies them in batch when processRules() is called (similar to other ModuleControl modules)
 */
class TLSSetControl extends ModuleControl {
  constructor() {
    super('tlsset');
    this.queuedRules = { 'xt_tls': {}, 'xt_udp_tls': {} };
    // Active TLS set names (files under /proc/net/<module>/hostset/<setName>)
    // e.g. 'c_bd_games_tls_hostset', 'c_bd_default_c_tls_hostset', etc.
    this.activeTCPSets = {}; // set name -> 1
    this.activeUDPSets = {}; // set name -> 1
  }

  /**
   * Returns which TLS modules should be updated for this operation, based on platform support
   * and (optionally) TLS set activation + protocol filter.
   *
   * @param {object} opts
   * @param {string} [opts.protocol] - optional filter: 'tcp' or 'udp'
   * @param {string} [opts.tlsHostSet] - TLS set name to check activation for
   */
  getModulesToUpdate(opts = {}) {
    const { protocol = '', tlsHostSet } = opts;
    const modules = [];
    if ((protocol === 'tcp' || protocol === '') && platform.isTLSBlockSupport() && (!tlsHostSet || this.isSetActiveTCP(tlsHostSet))) {
      modules.push('xt_tls');
    }
    if ((protocol === 'udp' || protocol === '') && platform.isUdpTLSBlockSupport() && (!tlsHostSet || this.isSetActiveUDP(tlsHostSet))) {
      modules.push('xt_udp_tls');
    }
    return modules;
  }

  /**
   * Determine which modules should be updated for a domain based on its protocol.
   * @param {string} domain - domain[,protocol:start_port-end_port]
   * @param {string} tlsHostSet - TLS set name to check activation
   * @returns {string[]} Array of module names
   */
  getModulesForDomain(domain, tlsHostSet) {
    if (!domain) return [];

    // domain format:
    // domain[,protocol:start_port-end_port]
    // protocol is optional, if not specified, it will match all protocols
    // start_port and end_port are optional, if not specified, it will match all ports
    const parts = domain.split(',');
    const protocol = parts.length > 1 ? parts[1].split(':')[0] : '';

    return this.getModulesToUpdate({ protocol, tlsHostSet });
  }

  /**
   * Queue a hostset update (add/rm) for one domain entry.
   *
   * @param {string} tlsHostSet
   * @param {string} action - 'add' or 'rm'
   * @param {string} domain - already finalized by application layer (e.g. exact match vs suffix match)
   */
  addRule(tlsHostSet, action, domain) {
    // Determine which modules to update based on domain protocol and platform support
    log.debug(`addRule: ${tlsHostSet}, ${action}, ${domain}`);
    const modules = this.getModulesForDomain(domain, tlsHostSet);

    for (const module of modules) {
      if (action === 'add') {
        this._queueWrite(module, tlsHostSet, `+${domain}`);
      } else if (action === 'rm') {
        this._queueWrite(module, tlsHostSet, `-${domain}`);
      }
    }

    super.addRule(`${action}:${tlsHostSet}:${domain}`);
  }

  /**
   * Queue a flush operation ("/") for a hostset, for each module.
   * @param {string} tlsHostSet
   */
  flushHostset(tlsHostSet) {
    // Determine which modules to update based on platform support and set activation
    const modules = this.getModulesToUpdate({ tlsHostSet });
    
    for (const module of modules) {
      this.queuedRules[module][tlsHostSet] = [];
      this._queueWrite(module, tlsHostSet, '/'); // kernel interface: "/" => flush
    }

    super.addRule(`flush:${tlsHostSet}`);
  }

  /**
   * Execute queued hostset operations.
   */
  async processRules() {
    // TLS sets are updated by iptables rules, which should be processed right before this
    await this.refreshTLSCategoryActivated();

    const queued = this.queuedRules;
    this.queuedRules = { 'xt_tls': {}, 'xt_udp_tls': {} };

    for (const module of TLS_MODULES) {
      const proto = module === 'xt_tls' ? 'tcp' : 'udp';
      const sets = queued[module] || {};
      for (const setName of Object.keys(sets)) {
        const ops = sets[setName] || [];
        if (!ops.length) continue;

        if (!this.isSetActive(setName, proto)) {
          log.warn("Skip inactive TLS set", proto, setName, ops);
          continue;
        }

        const tlsFilePath = this._tlsFilePath(setName, module);

        log.verbose(`processRules: ${proto} ${setName}, ${ops.length} entries`);
        log.debug(tlsFilePath, ops);
        for (const op of ops) {
          await fs.promises.appendFile(tlsFilePath, op).catch(err => {
            log.error('Failed to write TLS hostset', tlsFilePath, op, err);
          });
        }
      }
    }
  }

  getQueuedRuleCount() {
    let sum = 0;
    const modules = Object.keys(this.queuedRules || {});
    for (const module of modules) {
      const sets = this.queuedRules[module] || {};
      for (const setName of Object.keys(sets)) {
        sum += (sets[setName] || []).length;
      }
    }
    return sum;
  }

  flush() {
    this.queuedRules = { 'xt_tls': {}, 'xt_udp_tls': {} };
  }

  /**
   * Check if a TLS set name is active for TCP
   * @param {string} tlsHostSet - TLS set name (e.g. 'c_bd_games_tls_hostset')
   */
  isSetActiveTCP(tlsHostSet) {
    return this.activeTCPSets && this.activeTCPSets[tlsHostSet] !== undefined;
  }

  /**
   * Check if a TLS set name is active for UDP
   * @param {string} tlsHostSet - TLS set name (e.g. 'c_bd_games_tls_hostset')
   */
  isSetActiveUDP(tlsHostSet) {
    return this.activeUDPSets && this.activeUDPSets[tlsHostSet] !== undefined;
  }

  /**
   * Check if a TLS set name is active for either TCP or UDP
   * @param {string} tlsHostSet - TLS set name (e.g. 'c_bd_games_tls_hostset')
   * @param {string} proto - 'tcp' | 'udp' | '' (both)
   */
  isSetActive(tlsHostSet, proto = '') {
    if (proto === 'tcp') return this.isSetActiveTCP(tlsHostSet);
    if (proto === 'udp') return this.isSetActiveUDP(tlsHostSet);
    return this.isSetActiveTCP(tlsHostSet) || this.isSetActiveUDP(tlsHostSet);
  }

  /**
   * Mark a TLS set as activated (application intent). This does not touch /proc directly.
   * @param {string} tlsHostSet - TLS set name (e.g. 'c_bd_games_tls_hostset')
   * @param {string} proto - 'tcp' | 'udp' | '' (both)
   */
  activateTLSSet(tlsHostSet, proto = '') {
    if (proto === 'tcp' || proto === '') {
      this.activeTCPSets[tlsHostSet] = 1;
    }
    if (proto === 'udp' || proto === '') {
      this.activeUDPSets[tlsHostSet] = 1;
    }
  }

  /**
   * Refresh active TLS sets by probing hostset files under /proc/net.
   * This discovers which sets actually exist in the filesystem.
   */
  async refreshTLSCategoryActivated() {
    try {
      const refreshForModule = async (module) => {
        const dirPath = `${TLS_HOSTSET_BASE_PATH}/${module}/${TLS_HOSTSET_FOLDER}`;
        let entries = [];
        try {
          entries = await fs.promises.readdir(dirPath);
        } catch (err) {
          log.error(`Failed to read TLS hostset folder ${dirPath}`, err && err.message ? err.message : err);
          return {};
        }

        const out = {};
        // Store set names directly (not categories)
        for (const setName of entries) {
          out[setName] = 1;
        }
        return out;
      };

      if (platform.isTLSBlockSupport()) {
        this.activeTCPSets = await refreshForModule('xt_tls');
      }
      if (platform.isUdpTLSBlockSupport()) {
        this.activeUDPSets = await refreshForModule('xt_udp_tls');
      }
    } catch (err) {
      log.info("Failed to refresh active TLS sets", err);
    }
  }

  _tlsFilePath(tlsHostSet, module) {
    return `${TLS_HOSTSET_BASE_PATH}/${module}/${TLS_HOSTSET_FOLDER}/${tlsHostSet}`;
  }

  _queueWrite(module, setName, payload) {
    if (!this.queuedRules[module][setName]) this.queuedRules[module][setName] = [];
    this.queuedRules[module][setName].push(payload);
  }
}

module.exports = new TLSSetControl();


