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
'use strict'

const log = require('../net2/logger.js')(__filename);
const { exec } = require('child-process-promise');
const { Rule } = require('../net2/Iptables.js');
const f = require('../net2/Firewalla.js');
const path = require('path');
const fsp = require('fs').promises;

const ModuleControl = require('./ModuleControl.js')

const TABLES = ['filter', 'nat', 'mangle', 'raw'];

class IptablesControl extends ModuleControl {
  constructor() {
    super('iptables');

    // Queue of operations waiting to be processed.
    // Each table is split into chains vs rules.
    this.queuedRules = this._emptyState(true);

    // Track current iptables state (from iptables-save / setup script output)
    // Each table is split into chains vs rules.
    this.aggregatedRules = this._emptyState();
  }

  _getIptablesRestoreFile(family) {
    return path.join(f.getHiddenFolder(), 'run', 'iptables', family === 4 ? 'iptables' : 'ip6tables');
  }

  /**
   * Add a rule to the iptables queue
   * @param {Rule} rule - The Rule object representing an iptables rule
   */
  addRule(rule) {
    if (!(rule instanceof Rule)) {
      rule = new Rule().from(rule);
    }

    const family = rule.family || 4;
    const table = rule.table || 'filter';

    if (!this.queuedRules[family] || !this.queuedRules[family][table]) {
      log.error(`Unsupported family/table '${family}/${table}'`);
      return;
    }

    this.queuedRules[family][table].push(rule.clone());

    super.addRule(JSON.stringify(rule));
  }

  /**
   * Process queued rules (called by BlockControl when ready)
   */
  async processRules() {
    // snapshot & clear queue early (new requests will be handled in next round)
    const queued = this.queuedRules;
    this.queuedRules = this._emptyState(true);

    // dump current iptables to aggregate with queued rules
    await this.dumpIptables();

    // Apply queued ops to aggregatedRules, per-table, per-family
    let changed = { 4: false, 6: false };
    for (const family of [4, 6]) {
      for (const table of TABLES) {
        const res = this.mergeQueuedToAggregated(this.aggregatedRules[family][table], queued[family][table]);
        if (res) changed[family] = true;
      }
    }

    for (const family of [4, 6]) try {
      if (!changed[family]) {
        log.debug(`No changes for v${family}, skipping iptables restore`);
        continue;
      }
      log.info(`Restoring iptables v${family} queue=${this.getQueuedRuleCount(queued)}`);
      await this.restoreIptables(family);
    } catch (err) {
      log.error(`Error restoring iptables v${family}: ${err.stderr}, executing queued commands individually...`);
      log.info(err.message);
      // executing queued commands individually here
      for (const table of TABLES) {
        for (const rule of queued[family][table]) try {
          if (!(rule instanceof Rule)) continue;
          await rule.exec(rule.operation || '-A');
        } catch (err) {
          log.error(`Failed to execute individual rule`, err.message);
        }
      }
      log.info(`Successfully executed queued commands individually for v${family}`);
    }
  }

  /**
   * Run setup script in dry-run mode and read generated files
   */
  async readSetupScriptResult() {
    log.info('Reading iptables setup script result');
    try {
      // Read and parse the generated files (same format as iptables-save)
      
      // Read IPv4 iptables file
      const iptablesFile = this._getIptablesRestoreFile(4);
      const iptablesContent = await fsp.readFile(iptablesFile, 'utf8');
      this.parseIptablesSaveOutput(iptablesContent, 4);
      
      // Read IPv6 iptables file
      const ip6tablesFile = this._getIptablesRestoreFile(6);
      const ip6tablesContent = await fsp.readFile(ip6tablesFile, 'utf8');
      this.parseIptablesSaveOutput(ip6tablesContent, 6);
      
      log.info('Iptables setup script result read successfully');
    } catch (err) {
      const error = new Error(`Error reading iptables setup script result: ${err.message}`);
      log.error(error.message);
      throw error;
    }
  }

  /**
   * Backup current iptables using iptables-save
   */
  async dumpIptables() {
    log.debug('Dumping current iptables');
    try {
      // Backup both IPv4 and IPv6
      const [v4Result, v6Result] = await Promise.all([
        exec('sudo iptables-save', { timeout: 30000 }),
        exec('sudo ip6tables-save', { timeout: 30000 })
      ]);
      
      this.parseIptablesSaveOutput(v4Result.stdout, 4);
      this.parseIptablesSaveOutput(v6Result.stdout, 6);
    } catch (err) {
      const error = new Error(`Error dumping current iptables: ${err.message}`);
      log.error(error.message);
      throw error;
    }
  }


  /**
   * Parse iptables-save output into table structure
   */
  parseIptablesSaveOutput(output, family) {
    const lines = output.split('\n');
    let currentTable = null;
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Skip empty lines and comments
      if (!trimmedLine || !trimmedLine.length || trimmedLine.startsWith('#')) {
        continue;
      }
      
      // Check for table declaration
      if (trimmedLine.startsWith('*')) {
        currentTable = trimmedLine.substring(1);
        if (this.aggregatedRules[family][currentTable]) {
          this.aggregatedRules[family][currentTable] = { chains: {}, rules: [] };
        } else {
          // Skip unsupported tables (raw, security, etc.)
          log.error(`Skipping unsupported table: ${currentTable} for family ${family}`);
          currentTable = null;
        }
        continue;
      }
      
      // Check for commit
      if (trimmedLine === 'COMMIT') {
        currentTable = null;
        continue;
      }
      
      // Add rule/chain to current table
      if (currentTable && this.aggregatedRules[family][currentTable]) {
        if (trimmedLine.startsWith(':')) {
          // chains are like ":CHAIN_NAME - [pkts:bytes]"
          const rest = trimmedLine.substring(1);
          const sp = rest.indexOf(' ');
          const chainName = sp >= 0 ? rest.substring(0, sp) : rest;
          this.aggregatedRules[family][currentTable].chains[chainName] = trimmedLine
        } else if (trimmedLine.startsWith('-N')) {
          const chainName = trimmedLine.substring(3);
          this.aggregatedRules[family][currentTable].chains[chainName] = `:${chainName} - [0:0]`
        } else if (trimmedLine.startsWith('-A')) {
          // rules are like "-A CHAIN ...". Store essential part without operation.
          const essential = trimmedLine.substring(3);
          this.aggregatedRules[family][currentTable].rules.push(essential)
        } else if (trimmedLine.startsWith('-I')) {
          const essential = trimmedLine.substring(3);
          this.aggregatedRules[family][currentTable].rules.unshift(essential)
        }
      }
    }
    
    log.debug(`Parsed iptables rules for family ${family}: ${JSON.stringify(
      Object.keys(this.aggregatedRules[family]).reduce((acc, table) => {
        acc[table] = {
          chains: Object.keys(this.aggregatedRules[family][table].chains).length,
          rules: this.aggregatedRules[family][table].rules.length,
        };
        return acc;
      }, {})
    )}`);
  }


  /**
   * Add rules to aggregatedRules, checking for duplicates
   */
  // legacy entry point no longer used; kept for compatibility if someone calls it.
  async createIptablesRestoreContent() {
    return this.aggregatedRules;
  }

  /**
   * Restore iptables from aggregatedRules for a specific family
   * @param {number} family - IP family (4 for IPv4, 6 for IPv6)
   */
  async restoreIptables(family) {
    const lines = [];
    for (const table of TABLES) {
      const t = this.aggregatedRules[family][table]
      const tablelines = [];
      for (const name in t.chains) {
        tablelines.push(t.chains[name]);
      }
      for (const essential of t.rules) {
        // Filter out null values (rules that were deleted via -D operation)
        if (essential)
          tablelines.push(`-A ${essential}`);
      }
      if (tablelines.length) {
        lines.push(`*${table}`);
        lines.push(...tablelines);
        lines.push('COMMIT');
      }
    }

    const content = lines.join('\n') + '\n';
    const command = family === 4 ? 'iptables-restore' : 'ip6tables-restore';

    // Avoid E2BIG: do NOT embed the restore payload in the exec() command string.
    // Write it to the same file location used by readSetupScriptResult(),
    // then feed that file to iptables-restore.
    const restoreFile = this._getIptablesRestoreFile(family);
    await fsp.writeFile(restoreFile, content, 'utf8');

    log.debug(`${command} < ${restoreFile} bytes=${content.length}`);
    await exec(`sudo ${command} < "${restoreFile}"`, { timeout: 30000 });
    log.info(`iptables v${family} restored ${lines.length} lines successfully`);
  }

  /**
   * Get count of queued rules
   */
  getQueuedRuleCount(queue = this.queuedRules) {
    let count = 0;
    for (const family of [4, 6]) {
      for (const table of TABLES) {
        count += queue[family][table].length;
      }
    }
    return count;
  }

  /**
   * Clean up resources
   */
  flush() {
    this.queuedRules = this._emptyState(true);
    this.aggregatedRules = this._emptyState();
  }

  _emptyState(queue = false) {
    const state = {};
    for (const family of [4, 6]) {
      state[family] = {};
      for (const table of TABLES)
        // use object to dedup for existing chains
        // keep rules as array as they are ordered
        state[family][table] = queue ? [] : { chains: {}, rules: [] };
    }
    return state;
  }

  mergeQueuedToAggregated(agg, queued) {
    let changed = false;

    for (const rule of (queued || [])) {
      if (!(rule instanceof Rule)) continue;
      const operation = rule.operation || '-A';
      const essential = rule.essential();
      log.verbose(`Merging queued rule: ${operation} ${essential}`);

      switch (operation) {
        case '-N':
          // 0) new chain; just add to aggregated rules
          if (!agg.chains[rule.chain]) {
            agg.chains[rule.chain] = `:${rule.chain} - [0:0]`;
            changed = true;
          }
          break;
        case '-X':
          if (agg.chains[rule.chain]) {
            delete agg.chains[rule.chain];
            changed = true;
          }
          // fallsthrough
        case '-F':
          if (!agg.chains[rule.chain]) continue;
          for (const i in agg.rules) {
            const rule = agg.rules[i];
            if (rule && rule.startsWith(rule.chain + ' ')) {
              agg.rules[i] = null;
              changed = true;
            }
          }
          break;
        case '-I':
        case '-A':
          // 1) dedup with current aggregated rules and current queued already-applied in this loop
          if (agg.rules.includes(essential))
            continue
          else {
            if (operation === '-I')
              agg.rules.unshift(essential)
            else
              agg.rules.push(essential)
            changed = true;
          }
          break;
        case '-D':
          // 2) remove the existing rule; if missing, drop
          const idx = agg.rules.indexOf(essential);
          if (idx >= 0) {
            agg.rules[idx] = null;
            changed = true;
          }
          break;
        default:
          log.error('Unsupported operation:', operation, essential);
          break;
      }
    }

    return changed;
  }
}

module.exports = new IptablesControl()