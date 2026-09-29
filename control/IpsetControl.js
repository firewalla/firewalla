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
const uuid = require('uuid');

const { execFile } = require('child-process-promise');
const { spawn } = require('child_process');

// recycle the long lived ipset process at this age to avoid a potential memory leak
const INTERACTIVE_MAX_AGE_MS = 600000;
// lower bound between spawn attempts, so an ipset that dies on startup does not get
// forked once per batch
const INTERACTIVE_RESPAWN_INTERVAL_MS = 5000;

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
    this.interactiveIpset = null;
    // spawn time of the current process, or of the last attempt if it is gone. Drives
    // both the age based recycle and the respawn interval.
    this.interactiveIpsetStartTs = 0;
    if (f.isMain()) this._initInteractiveIpset();
  }

  _initInteractiveIpset() {
    log.info('Starting interactive ipset for batch operations');
    this.interactiveIpsetStartTs = Date.now();
    const child = spawn('sudo', ['ipset', '-', '-!']);
    this.interactiveIpset = child;

    // a handler must never act on a child that has already been replaced, otherwise a
    // late error from an old process tears down the healthy one that took its place.
    // Nothing respawns from in here either, _batchWrite does that lazily.
    const retire = (reason) => {
      if (this.interactiveIpset !== child) return; // already replaced, expected
      this.interactiveIpset = null;
      log.error('Interactive ipset is gone,', reason);
    };

    child.stdout.on('data', () => {});
    child.stderr.on('data', data => log.error('Error in interactive ipset stderr', data.toString()));
    child.on('error', err => retire(`spawn failed: ${err.message}`));
    child.on('exit', (code, signal) => retire(`exited code=${code} signal=${signal}`));
    // when the child is still up but no longer reading (ipset failed and is on its way
    // out, or sudo is lingering after it), a write gets a real EPIPE, delivered
    // asynchronously. The try/catch in _batchWrite never sees it, and with no listener
    // here it is an uncaught exception that takes the whole process down.
    child.stdin.on('error', err => retire(`stdin error: ${err.message}`));
  }

  _recycleInteractiveIpset() {
    const previous = this.interactiveIpset;
    // spawn the replacement first, so retire() sees the old child is no longer current
    // and treats its exit as expected rather than logging a failure
    this._initInteractiveIpset();
    try {
      previous.stdin.write('quit\n');
      previous.stdin.end(); // in case quit is not honored, EOF still ends it
    } catch (err) {
      log.verbose('Failed to quit previous interactive ipset', err.message);
    }
  }

  /**
   * Write ipset-restore lines to the long lived ipset process.
   *
   * That process is an optimization, not a dependency: it saves a fork and a temp file
   * on the hot path, and anything that cannot be written to it falls back to the same
   * "ipset restore -f" path restore() uses, so operations are never silently dropped.
   * Every line is applied with -!, so replaying a whole batch after a failed write is
   * harmless even when the child consumed part of it before dying.
   * @param {string[]} ops - array of ipset-restore lines
   */
  async _batchWrite(ops) {
    if (!Array.isArray(ops) || !ops.length) return;

    if (this.interactiveIpset && Date.now() - this.interactiveIpsetStartTs > INTERACTIVE_MAX_AGE_MS) {
      log.info('Interactive ipset living > 600s, restarting to avoid potential memory leak');
      this._recycleInteractiveIpset();
    }

    if (!this.interactiveIpset) {
      if (Date.now() - this.interactiveIpsetStartTs < INTERACTIVE_RESPAWN_INTERVAL_MS)
        return this.restore(ops, false); // respawned too recently, do not fork per batch
      this._initInteractiveIpset();
    }

    // once the child exits node destroys its stdin, and writes to a destroyed stream are
    // discarded silently: they neither throw nor emit, so a write that "succeeds" here
    // proves nothing. Check before trusting it, rather than relying on the exit handler
    // having already run.
    const child = this.interactiveIpset;
    const stdin = child.stdin;
    if (stdin.destroyed || stdin.writableEnded) {
      log.error('Interactive ipset stdin is closed, falling back to ipset restore');
      this.interactiveIpset = null;
      return this.restore(ops, false);
    }

    try {
      log.verbose('batchWrite:', ops);
      const flushed = stdin.write(ops.join('\n') + '\n', err => {
        if (!err) return;
        // EPIPE arrives after write() has already returned, so this callback is the only
        // place the in flight batch can still be recovered. Replaying it whole is safe,
        // every line carries -!
        log.error('Interactive ipset write failed, falling back to ipset restore', err.message);
        if (this.interactiveIpset === child) this.interactiveIpset = null;
        this.restore(ops, false).catch(e => log.error('ipset restore fallback failed', e.message));
      });
      if (!flushed)
        log.warn('Interactive ipset stdin is backed up, buffering', ops.length, 'operations');
    } catch (err) {
      // the stream is unusable, apply this batch through the file path rather than
      // retrying into a pipe that is already broken
      log.error('Failed to write to ipset stream, falling back to ipset restore', err.message);
      this.interactiveIpset = null;
      return this.restore(ops, false);
    }
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
  async addRule(cmd, allowDeferredExec = false) {
    if (this.phase === 'autonomous') {
      const cmds = Array.isArray(cmd) ? cmd : [cmd];
      if (allowDeferredExec) {
        return this._batchWrite(cmds);
      }
      for (const line of cmds) {
        await this._execOne(line);
      }
      return;
    }

    if (!f.isMain()) {
      super.addRule(cmd);
      return;
    }

    // init phase: queue for batch processing
    if (Array.isArray(cmd)) {
      for (const line of cmd) this.queuedRules.push(line);
    } else if (typeof cmd === 'string') {
      this.queuedRules.push(cmd);
    } else {
      throw new Error('IpsetControl.addRule requires a command string or array of strings');
    }

    log.debug(cmd);
  }

  /**
   * Execute a single ipset command inline (autonomous phase).
   * @param {string} line - ipset command line (without 'ipset' prefix); tokens are
   *   whitespace-separated with no quoting, so callers must not pass values
   *   containing spaces (e.g. ipset comment text)
   */
  async _execOne(line) {
    await execFile('sudo', ['ipset', '-!', ...line.trim().split(/\s+/)], { timeout: 10000 }).catch(err => {
      log.error('Failed to execute command:', err.stack);
    });
  }

  /**
   * Bulk-apply ipset operations.
   * @param {string[]} ops - array of ipset-restore lines
   * @param {boolean} allowDeferredExec - if true and autonomous, write to interactive shell stdin (no fork)
   */
  async restore(ops, allowDeferredExec = false) {
    if (!ops || !ops.length) return;
    if (this.phase !== 'autonomous') {
      return this.addRule(ops);
    }
    if (allowDeferredExec) {
      return this._batchWrite(ops);
    }
    // Autonomous: write to a unique temp file and restore immediately
    const restoreFile = `/tmp/ipset-${uuid.v4()}`;
    try {
      await fsp.mkdir(path.dirname(restoreFile), { recursive: true });
      await fsp.writeFile(restoreFile, ops.join('\n') + '\n', 'utf8');
      await execFile("sudo", ["ipset", "restore", "-!", "-f", restoreFile], { timeout: 300000 });
    } finally {
      await fsp.unlink(restoreFile).catch(() => {});
    }
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
      let [op, setName, newName] = line.split(' ');
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
        await execFile("sudo", ["ipset", "restore", "-!", "-f", restoreFile], { timeout: 300000 });
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
      const result = await execFile('sudo', ['ipset', 'list', '-name'], { timeout: 10000 });
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