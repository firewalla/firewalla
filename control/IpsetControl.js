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
const path = require('path');
const fsp = require('fs').promises;

const { exec } = require('child-process-promise');

/**
 * - Queues ipset operations as ipset-restore lines (e.g. "create -! ...", "add -! ...")
 * - Writes operations to a file and applies via "ipset restore -! -f <file>"
 * - No need to dump current state (ipset restore is incremental).
 */
class IpsetControl extends ModuleControl {
  constructor() {
    super('ipset');
    this.queuedRules = []; // array of ipset-restore lines
    this.existingSets = new Set(); // maintain a set of existing ipset set names to filter out invalid operations
  }

  getIpsetRestoreFile(script = false) {
    return path.join(f.getHiddenFolder(), 'run', 'iptables', 'ipset' + (script ? '.script' : ''));
  }

  /** Replace first occurrence of setName with newName in line (for ipset restore lines). */
  _replaceSetNameInLine(line, setName, newName) {
    const idx = line.indexOf(setName);
    if (idx < 0) return line;
    return line.substring(0, idx) + newName + line.substring(idx + setName.length);
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

    log.debug(cmd);

    super.addRule(cmd);
  }

  getSwapSetName(setName) {
    return setName.includes('_set') ? setName.replace('_set', '_swp') : `${setName}_swp`;
  }

  /**
   * Execute queued ipset operations: filter into a map by set, then write restore file and run ipset restore
   * to avoid interrupting blocking rules, use swap for existing sets
   */
  async processRules(fromInitialization = false, dryRun = false) {
    if (fromInitialization) {
      await this.readSetupScriptResult();
    }

    const queuedOps = this.queuedRules;
    this.queuedRules = [];

    if (!queuedOps.length) return;

    // sets before processing queued ops
    const previousSets = await this.listExistingSets();
    // expected existing sets updated as filtering queued ops
    this.existingSets = fromInitialization ? new Set() : (previousSets || this.existingSets);
    // sets should be swapped
    const swapSets = new Set();
    const restoreFile = this.getIpsetRestoreFile();
    const ops = []
    const leftoverSwpSets = [];

    if (fromInitialization) {
      // clean leftover _swp sets
      leftoverSwpSets.push(...Array.from(previousSets).filter(setName => setName.startsWith('c_bd_tmp_') || setName.includes('_swp')));
      ops.push(...leftoverSwpSets.map(setName => `flush ${setName}`))
      ops.push(...leftoverSwpSets.map(setName => `destroy ${setName}`));
      if (leftoverSwpSets.length)
        log.verbose('leftover _swp sets', leftoverSwpSets);
    }

    let errorAddDel = 0
    queuedOps.forEach(line => {
      let [ op, setName, newName ] = line.split(' ');
      // for initialization, swap existing sets to avoid interrupting blocking rules
      // temporary sets are not swapped, leave the flush job to CategoryUpdater
      // this is mainly to workaround the set name length limit
      if (fromInitialization && previousSets.has(setName) && !setName.startsWith('c_bd_tmp_')) {
        swapSets.add(setName);
        const swapSetName = this.getSwapSetName(setName);
        line = line.replace(setName, swapSetName);
        setName = swapSetName;
      }
      switch (op) {
        case 'create':
          if (!this.existingSets.has(setName)) {
            this.existingSets.add(setName);
            ops.push(line);
          } else
            log.info(`${setName} already exists, dropping ${line}`);
          break
        case 'flush':
          if (this.existingSets.has(setName)) ops.push(line);
          break;
        case 'destroy':
          if (this.existingSets.delete(setName)) ops.push(line);
          if (fromInitialization && previousSets.has(setName)) previousSets.delete(setName);
          break;
        case 'add':
        case 'del':
          if (this.existingSets.has(setName))
            ops.push(line);
          else if (errorAddDel++ < 10) {
            log.warn(`${setName} not found, dropping ${line}`);
          }
          break;
        case 'rename':
          if (this.existingSets.has(setName)) {
            this.existingSets.delete(setName);
            if (fromInitialization && previousSets.has(newName)) {
              const swapSetName = this.getSwapSetName(newName);
              line = line.replace(newName, swapSetName);
              newName = swapSetName;
            }
            this.existingSets.add(newName);
            ops.push(line);
          } else
            log.warn(`${setName} not found, dropping ${line}`);
          break;
        case 'swap':
          if (fromInitialization && swapSets.has(newName)) {
            const swapSetName = this.getSwapSetName(newName);
            line = line.replace(newName, swapSetName);
            newName = swapSetName;
          }
          if (!this.existingSets.has(setName) || !this.existingSets.has(newName)) {
            log.warn(`${setName} or ${newName} not found, dropping ${line}`);
          } else
            ops.push(line);
          break;
        default:
      }
    })

    // swap then destroy old ipsets
    // same logic as install_iptables_setup.sh, flush first so members in list set could be destroyed
    if (fromInitialization) {
      previousSets.forEach(setName => {
        if (setName.startsWith('c_bd_tmp_')) return
        if (swapSets.has(setName)) {
          const swapSetName = this.getSwapSetName(setName);
          // only swap if set has been created
          if (this.existingSets.has(swapSetName)) {
            ops.push(`swap ${setName} ${swapSetName}`);
            ops.push(`flush ${swapSetName}`);
            return
          }
          // this should not happen, it probably indicates a bug somewhere
          log.error(`${swapSetName} not found, skip swap and destroy`);
        }
        // _swp sets are already handled by leftover cleanup above; skip to avoid duplicate ops
        if (setName.startsWith('c_') && !setName.includes('_swp')) {
          ops.push(`flush ${setName}`);
        }
      });
      // if ipset name changes between versions/restarts, ipset with old name might still be referenced
      // and destroy operation might fail, but that's fine.
      previousSets.forEach(setName => {
        if (setName.startsWith('c_bd_tmp_')) return
        if (swapSets.has(setName)) {
          const swapSetName = this.getSwapSetName(setName);
          if (this.existingSets.has(swapSetName)) {
            ops.push(`destroy ${swapSetName}`);
            return
          }
        }
        // _swp sets are already handled by leftover cleanup above; skip to avoid duplicate ops
        if (setName.startsWith('c_') && !setName.includes('_swp')) {
          ops.push(`destroy ${setName}`);
        }
      });
    }

    if (ops.length !== 0) {
      log.verbose(`Processing ${ops.length} ipset operations`);
    } else {
      return;
    }

    const restoreDir = path.dirname(restoreFile);
    await fsp.mkdir(restoreDir, { recursive: true });

    let remaining = ops;
    let retryCount = 0;
    const MAX_RETRIES = 10;
    if (fromInitialization) {
      await fsp.writeFile(restoreFile + '.init', remaining.join('\n') + '\n', 'utf8');
    }

    let logLevel
    while (remaining.length > 0 && retryCount < MAX_RETRIES) {
      const content = remaining.join('\n') + '\n';
      await fsp.writeFile(restoreFile, content, 'utf8');

      if (dryRun) {
        log.info(`DRY-RUN: ipset restore would have processed ${remaining.length} operations`);
        return
      }

      try {
        // the 5 min timeout is for https://ubuntu.com/security/CVE-2024-26910
        await exec(`sudo ipset restore -! -f "${restoreFile}"`, { timeout: 300000 });
        log.verbose(`ipset restore completed ${remaining.length} operations successfully`);
        break;
      } catch (err) {
        // copy the ipset file as ipset.error
        if (retryCount == 0)
          await fsp.copyFile(restoreFile, restoreFile + '.err').catch(copyErr => {
            log.error(`Failed to copy ipset restore file to ${restoreFile}.err:`, copyErr);
          })

        const errorLine = this._parseErrorLine(err.stderr);
        if (errorLine !== null && errorLine > 0 && errorLine <= remaining.length) {
          const failedLine = remaining[errorLine - 1];
          if (!logLevel)
            logLevel = (errorLine > leftoverSwpSets.length * 2 && failedLine.startsWith('destroy ') ? log.info : log.error)
          logLevel(`ipset restore failed at line ${errorLine}: ${failedLine}`);
          remaining = remaining.slice(errorLine);
          retryCount++;
        } else {
          log.error('Error processing ipset operations', err);
          log.error('Failed to parse error line number, skipping');
          break;
        }
      }
    }

    if (retryCount >= MAX_RETRIES && remaining.length > 0) {
      (logLevel || log.error)(`Max retries (${MAX_RETRIES}) reached, skipping ${remaining.length} remaining operations`);
    }
  }

  /**
   * Read setup script result from generated ipset file
   */
  async readSetupScriptResult() {
    log.info('Reading ipset setup script result');
    try {
      const ipsetFile = this.getIpsetRestoreFile(true);
      const content = await fsp.readFile(ipsetFile, 'utf8');
      const lines = content.split('\n')
        .filter(line => line.length && !line.startsWith('flush') && !line.startsWith('#'));
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
      log.silly(names.join(' '));
      return new Set(names);
    } catch (err) {
      log.error(`Error listing current ipset names: ${err.message}`);
      // Return empty array on error rather than throwing, to allow graceful degradation
      return new Set();
    }
  }
}

module.exports = new IpsetControl();