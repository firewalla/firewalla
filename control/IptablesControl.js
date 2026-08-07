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
// tables the setup script writes, and which therefore must never come back empty
const SCRIPT_TABLES = ['filter', 'nat', 'mangle'];

// Chains prefixed with FW_ are owned by firewalla and are the only ones the restore
// payload describes. Everything else — builtin chains, firerouter's FR_*, DOCKER-*,
// UPNP_* — belongs to another writer, is never declared and so never flushed, so rules
// landing there are applied directly by addRule() rather than through the payload.
const FW_CHAIN_PREFIX = 'FW_';

class IptablesControl extends ModuleControl {
  constructor() {
    super('iptables');

    // Queue of operations waiting to be processed.
    // Each table is split into chains vs rules.
    this.queuedRules = this._emptyState(true);

    // Desired state of the FW_ chains, built from the setup script skeleton plus
    // every rule that has been queued since. This is the source of truth for what
    // restoreIptables() writes; it is never rebuilt from the kernel.
    this.aggregatedRules = this._emptyState();

    // FW_ chain names currently in the kernel, per family and table. Filled by
    // dumpIptables() at initialization, read only to reap chains left over from a
    // previous run.
    this.liveChains = { 4: {}, 6: {} };
    for (const family of [4, 6])
      for (const table of TABLES) this.liveChains[family][table] = new Set();
  }

  isFWChain(chain) {
    return Boolean(chain) && chain.startsWith(FW_CHAIN_PREFIX);
  }

  _getIptablesRestoreFile(family, script = false) {
    return path.join(f.getHiddenFolder(), 'run', 'iptables',
      `ip${family === 6 ? '6' : ''}tables${script ? '.script' : ''}`
    );
  }

  /**
   * Add a rule to the iptables queue
   * @param {Rule} rule - The Rule object representing an iptables rule
   */
  async addRule(rule) {
    if (!(rule instanceof Rule)) {
      rule = new Rule().from(rule);
    }

    if (this.phase === 'autonomous') {
      await this._execOne(rule);
      return;
    }

    if (!f.isMain()) {
      super.addRule(JSON.stringify(rule));
      return;
    }

    // a chain we don't own is never declared and so never flushed by the restore, which
    // leaves the payload no way to make re-adding idempotent. Apply the rule directly
    // instead: Rule.toCmd() guards -A/-I and -D with a -C check.
    if (!this.isFWChain(rule.chain)) {
      await this._execOne(rule);
      return;
    }

    // init phase: queue for batch processing
    const family = rule.family || 4;
    const table = rule.table || 'filter';

    if (!this.queuedRules[family] || !this.queuedRules[family][table]) {
      log.error(`Unsupported family/table '${family}/${table}'`);
      return;
    }

    this.queuedRules[family][table].push(rule.clone());
  }

  async addRuleBatch(rules, opr) {
    for (const rule of rules) {
      if (opr) rule.opr(opr);
      await this.addRule(rule);
    }
  }

  /**
   * Execute a single iptables rule inline (autonomous phase).
   * @param {Rule} rule
   */
  async _execOne(rule) {
    if (!(rule instanceof Rule)) rule = new Rule().from(rule);
    await rule.exec().catch(err => {
      log.error(`Failed to execute iptables rule`, err.stack);
    });
  }

  /**
   * Process queued rules (called by BlockControl when ready)
   */
  async processRules(fromInitialization = false) {
    // snapshot & clear queue early (new requests will be handled in next round)
    const queued = this.queuedRules;
    this.queuedRules = this._emptyState(true);

    // the setup script skeleton seeds the desired FW_ state, aggregatedRules is
    // maintained incrementally after that and never re-derived from the kernel. The
    // chain dump is only needed for the reap, which only runs at initialization.
    if (fromInitialization) {
      await this.readSetupScriptResult();
      await this.dumpIptables();
    }

    // Apply queued ops to aggregatedRules, per-table, per-family
    let changed = { 4: false, 6: false };
    for (const family of [4, 6]) {
      for (const table of TABLES) {
        const res = this.mergeQueuedToAggregated(family, table, queued);
        if (res) changed[family] = true;
      }
    }

    for (const family of [4, 6]) try {
      if (!changed[family]) {
        log.debug(`No changes for v${family}, skipping iptables restore`);
        continue;
      }
      log.verbose(`Restoring iptables v${family} queue=${this.getQueuedRuleCount(queued)}`);
      await this.restoreIptables(family, fromInitialization);
    } catch (err) {
      log.error(`Error restoring iptables v${family}: ${err.stderr}`);
      log.info(err.message);
      if (fromInitialization) {
        log.info(`Initialization restore failed for v${family}, restoring from setup file...`);
        try {
          // the setup file only declares FW_ chains, so --noflush leaves everything
          // owned by other processes alone. No flush_iptables.sh here on purpose.
          const restoreCmd = family === 4 ? 'iptables-restore' : 'ip6tables-restore';
          const restoreFile = this._getIptablesRestoreFile(family, true);
          await exec(`sudo ${restoreCmd} --noflush < ${restoreFile}`, { timeout: 30000 });
          log.info(`Setup file restored for v${family}`);
        } catch (setupErr) {
          log.error(`Error restoring setup file for v${family}: ${setupErr.message}`);
        }
      }
      log.info(`Executing queued commands individually for v${family}...`);
      for (const table of TABLES) {
        for (const rule of queued[family][table]) try {
          if (!(rule instanceof Rule)) continue;
          await rule.exec();
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
      const iptablesFile = this._getIptablesRestoreFile(4, true);
      const iptablesContent = await fsp.readFile(iptablesFile, 'utf8');
      this.parseIptablesSaveOutput(iptablesContent, 4);
      
      // Read IPv6 iptables file
      const ip6tablesFile = this._getIptablesRestoreFile(6, true);
      const ip6tablesContent = await fsp.readFile(ip6tablesFile, 'utf8');
      this.parseIptablesSaveOutput(ip6tablesContent, 6);
      
      // A table with no chains means the generated file is malformed, most likely a
      // missing *table header. Bail out: an empty desired state makes every live FW_
      // chain look stale, and the reap would try to delete all of them.
      for (const family of [4, 6]) {
        for (const table of SCRIPT_TABLES) {
          if (!Object.keys(this.aggregatedRules[family][table].chains).length)
            throw new Error(`no ${table} chain declared for v${family}`);
        }
      }

      log.info('Iptables setup script result read successfully');
    } catch (err) {
      const error = new Error(`Error reading iptables setup script result: ${err.message}`);
      log.error(error.message);
      throw error;
    }
  }

  /**
   * Read the chain names that currently exist in the kernel. Only used to reap the FW_
   * chains left over from a previous run — every rule lives in aggregatedRules.
   */
  async dumpIptables() {
    log.debug('Dumping current iptables chains');
    try {
      const [v4Result, v6Result] = await Promise.all([
        exec('sudo iptables-save', { timeout: 30000 }),
        exec('sudo ip6tables-save', { timeout: 30000 })
      ]);

      for (const [family, output] of [[4, v4Result.stdout], [6, v6Result.stdout]]) {
        for (const table of TABLES) this.liveChains[family][table] = new Set();
        let currentTable = null;
        for (const line of output.split('\n')) {
          if (line.startsWith('*'))
            currentTable = line.substring(1).trim();
          else if (line.startsWith(':') && currentTable && this.liveChains[family][currentTable])
            // chains are like ":CHAIN_NAME - [pkts:bytes]"
            this.liveChains[family][currentTable].add(line.substring(1).split(' ')[0]);
        }
      }
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
      // a workaround to handle extra spaces in udp_tls dump
      const trimmedLine = line.trim().replace(/\s{2,}/g, ' ')
        // comments with colon or space are dumped with quotes
        // comment should not contain quote, otherwise this fails
        .replace(/ --comment ([^" ]+) /, ' --comment "$1" ');
      
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
   * Restore iptables from aggregatedRules for a specific family.
   * Only FW_ chains are described, so the payload is applied with --noflush.
   * @param {number} family - IP family (4 for IPv4, 6 for IPv6)
   */
  async restoreIptables(family, fromInitialization = false) {
    const lines = [];
    for (const table of TABLES) {
      const t = this.aggregatedRules[family][table]
      const tablelines = [];

      // 1) declare every desired FW_ chain. Under --noflush a ':' line creates the
      // chain when missing and flushes it when it already exists, which is exactly
      // the create-or-reset primitive we want, and it never touches other chains.
      for (const name in t.chains) {
        tablelines.push(t.chains[name]);
      }

      // 2) reap FW_ chains left over from a previous run: still in the kernel but named
      // neither by the setup script nor by any queued rule. Only at initialization —
      // afterwards chains are deleted inline by whoever owns them. Everything that
      // referenced them lives in an FW_ chain that step 1 just flushed, so they are
      // unreferenced by the time -X runs.
      const stale = fromInitialization
        ? Array.from(this.liveChains[family][table]).filter(name => this.isFWChain(name) && !t.chains[name])
        : [];
      // flush all of them first, so cross references between them are gone before
      // any of them is deleted
      for (const name of stale) {
        tablelines.push(`-F ${name}`);
      }
      for (const name of stale) {
        tablelines.push(`-X ${name}`);
      }

      // 3) contents of the FW_ chains, in order
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

    // --noflush is essential: the payload only describes FW_ chains, so flushing
    // would wipe every rule installed by firerouter, docker, upnp, etc.
    await exec(`sudo ${command} --noflush < "${restoreFile}"`, { timeout: 30000 });
    log.verbose(`iptables v${family} restored successfully`);
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

  mergeQueuedToAggregated(family, table, queued) {
    const agg = this.aggregatedRules[family][table];
    let changed = false;

    for (const rule of (queued[family][table] || [])) {
      if (!(rule instanceof Rule)) continue;
      const operation = rule.operation;
      const essential = rule.essential();
      log.debug(`Merging v${family} ${table}: ${operation} ${essential}`);

      if (operation !== '-N') {
        const undeclared = [rule.chain, rule.jump].find(c => this.isFWChain(c) && !agg.chains[c]);
        if (undeclared) {
          log.error(`v${family} ${table}: refers to undeclared chain ${undeclared}, skipped`, operation, essential);
          continue;
        }
      }

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
            if (agg.rules[i] && agg.rules[i].startsWith(rule.chain + ' ')) {
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