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
const ModuleControl = require('./ModuleControl.js');
const f = require('../net2/Firewalla.js');

const MAX_BATCH_SIZE = 2000

const { exec } = require('child-process-promise');

/**
 * - Queues ipset operations as ipset-restore lines (e.g. "create -! ...", "add -! ...")
 * - Applies them in batch using "sudo ipset restore -!".
 * - No need to dump current state (ipset restore is incremental).
 */
class IpsetControl extends ModuleControl {
  constructor() {
    super('ipset');
    this.queuedRules = []; // array of ipset-restore lines
    this.existingSets = new Set(); // maintain a set of existing ipset set names to filter out invalid operations
  }

  /**
   * Add an ipset command string.
   * @param {string|string[]} cmd
   */
  addRule(cmd) {
    if (Array.isArray(cmd)) {
      this.queuedRules.push(...cmd);
    } else if (typeof cmd === 'string') {
      this.queuedRules.push(cmd);
    } else {
      throw new Error('IpsetControl.addRule requires a command string or array of strings');
    }

    super.addRule(cmd);
  }

  /**
   * Execute queued ipset operations in a single ipset-restore batch.
   */
  async processRules(fromInitialization = false) {
    if (fromInitialization) {
      // do nothing here, trust install script for initial setup
      // await this.readSetupScriptResult();
    }

    let ops = this.queuedRules;
    this.queuedRules = [];

    if (!ops.length) return;

    log.info(`Processing ${ops.length} ipset operations via ipset restore`);

    this.existingSets = await this.listExistingSets();

    ops = ops.filter(line => {
      const [ op, setName, newName ] = line.split(' ');
      switch (op) {
        case 'create':
          this.existingSets.add(setName);
          return true;
        case 'flush':
          return this.existingSets.has(setName);
        case 'add':
        case 'del':
          if (!this.existingSets.has(setName)) {
            log.warn(`${setName} not found, dropping ${line}`);
            return false;
          }
          return true;
        case 'rename':
          if (this.existingSets.has(setName)) {
            this.existingSets.delete(setName);
            this.existingSets.add(newName);
            return true;
          } else {
            log.warn(`${setName} not found, dropping ${line}`);
            return false;
          }
        case 'swap':
          if (!this.existingSets.has(setName) || !this.existingSets.has(newName)) {
            log.warn(`${setName} or ${newName} not found, dropping ${line}`);
            return false;
          }
          return true
        case 'destroy':
          return this.existingSets.delete(setName);
        default:
          return false;
      }
    });

    for (let i = 0; i < ops.length; i += MAX_BATCH_SIZE) {
      let batch = ops.slice(i, i + MAX_BATCH_SIZE);
      const batchNumber = Math.floor(i / MAX_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(ops.length / MAX_BATCH_SIZE);
      
      let retryCount = 0;
      const MAX_RETRIES = 10; // Prevent infinite loops
      
      while (batch.length > 0 && retryCount < MAX_RETRIES) {
        const input = batch.join('\n');
        log.info(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} operations, retry ${retryCount})`);
        log.debug(input);
        
        try {
          await exec(`sudo ipset restore -! << EOF\n${input}\nEOF`);
          break; // Success, exit retry loop
        } catch (err) {
          const errorLine = this._parseErrorLine(err.stderr);
          if (errorLine !== null && errorLine > 0 && errorLine <= batch.length) {
            // Line number is 1-indexed in error message, convert to 0-indexed array
            const failedIndex = errorLine - 1;
            const failedLine = batch[failedIndex];
            log.error(`ipset restore failed at line ${errorLine} in batch ${batchNumber}: ${failedLine}`);
            
            // Remove everything before and including the error line, keep only lines after
            // Lines before the error were successfully processed, so we only retry with remaining lines
            batch = batch.slice(errorLine);
            retryCount++;
            continue
          } else {
            // Cannot parse error line or invalid line number, log and skip this batch
            log.error(`Error processing ipset operations (batch ${batchNumber}): ${err.stderr}`);
            log.error(`Failed to parse error line number, skipping batch`);
            break;
          }
        }
      }
      
      if (retryCount >= MAX_RETRIES) {
        log.error(`Max retries (${MAX_RETRIES}) reached for batch ${batchNumber}, skipping remaining operations`);
      }
    }
  }

  /**
   * Read setup script result from generated ipset file
   */
  async readSetupScriptResult() {
    log.info('Reading ipset setup script result');
    try {
      const path = require('path');
      const fs = require('fs').promises;

      const ipsetFile = path.join(f.getHiddenFolder(), 'run', 'iptables', 'ipset');
      
      const content = await fs.readFile(ipsetFile, 'utf8');
      const lines = content.split('\n');
      this.queuedRules = lines.concat(this.queuedRules);

      log.info(`Successfully queued ${lines.length} entries from ipset setup script`);
    } catch (err) {
      log.error('Error reading ipset setup script result', err.message)
    }
  }

  getQueuedRuleCount() {
    return this.queuedRules.length;
  }

  flush() {
    this.queuedRules = [];
  }

  /**
   * Parse error line number from ipset restore stderr output
   * @param {string} stderr - stderr output from ipset restore
   * @returns {number|null} Line number (1-indexed) or null if cannot parse
   */
  _parseErrorLine(stderr) {
    if (!stderr) return null;
    
    // Match patterns like:
    // "ipset v7.15: Error in line 1022: The set with the given name does not exist"
    // "Error in line 5: ..."
    const match = stderr.match(/Error in line (\d+):/i);
    if (match && match[1]) {
      const lineNum = parseInt(match[1], 10);
      return isNaN(lineNum) ? null : lineNum;
    }
    
    return null;
  }

  /**
   * List all existing ipset names
   * @returns {Promise<Set<string>>} Set of ipset set names
   */
  async listExistingSets() {
    try {
      const result = await exec('sudo ipset list -name', { timeout: 10000 });
      const names = result.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      
      log.verbose(`Found ${names.length} existing ipset names`);
      return new Set(names);
    } catch (err) {
      log.error(`Error listing current ipset names: ${err.message}`);
      // Return empty array on error rather than throwing, to allow graceful degradation
      return new Set();
    }
  }
}

module.exports = new IpsetControl();