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

const f = require('../net2/Firewalla.js');
const iptables = require('./IptablesControl.js');
const ipset = require('./IpsetControl.js');
const tlsset = require('./TLSSetControl.js');
const MessageBus = require('../net2/MessageBus.js');
const messageBus = new MessageBus('info')
const { delay } = require('../util/util.js');

const { exec } = require('child-process-promise');

// BlockControl class coordinates multiple modules (ipset, iptables, tlsset) to apply networking rules efficiently.
// It maintains a state machine to align changes across modules
class BlockControl {
  constructor() {
    this.queuingTimer = null;
    this.queuingTimeout = 10000; // 10 seconds
    this.processingPromise = null;

    // Order matters: ipset operations should be applied before iptables rules that may reference sets
    // TLSIpset is depends on iptables rules to create hashset files
    this.modules = [ipset, iptables, tlsset];
    
    // Listen to RuleAdded events from modules
    // Modules manage their own queues, BlockControl just coordinates timing
    messageBus.subscribe('Control', 'RuleAdded', (channel, type, moduleName, rule) => {
      log.debug(`Rule added event from ${moduleName}`);

      if (this.state === 'idle')
        this.enterQueuingState();
      else
        this.refreshQueuingTimer();
      // If in 'processing' or 'initializing' state, rules will be processed when state changes
    })
    
    this.enterIdleState();
  }

  /**
   * Enter queuing state
   */
  enterQueuingState() {
    log.verbose('Entering queuing state');
    this.state = 'queuing';
    
    this.refreshQueuingTimer();
  }

  /**
   * Enter processing state and call modules to process their queued rules
   */
  async enterProcessingState() {
    log.verbose('Entering processing state');
    
    const fromInitialization = this.state === 'initializing';
    this.state = 'processing';
    
    // Pause the timer during processing
    if (this.queuingTimer) {
      clearTimeout(this.queuingTimer);
      this.queuingTimer = null;
    }
    
    // Call all registered modules to process their own queued rules
    // Each module manages its own queue and processes it when called
    // Process modules in order to avoid races (e.g. iptables referencing ipset before it's created)
    for (const module of this.modules) try {
      // there's a short delay before TLS set file is created
      // if (module == tlsset) await delay(3000);
      await module.processRules(fromInitialization);
    } catch (err) {
      log.error('Error processing rules', module.name, err);
    }

    log.verbose('All modules completed processing');
    this.enterIdleState();
  }

  /**
   * Refresh the queuing state timer
   */
  refreshQueuingTimer() {
    // Clear existing timer
    if (this.queuingTimer) {
      clearTimeout(this.queuingTimer);
    }

    // Only refresh timer if not in processing or initializing state
    if (this.state === 'processing' || this.state === 'initializing')
      return
    
    // Set new timer
    this.queuingTimer = setTimeout(() => {
      this.enterProcessingState();
    }, this.queuingTimeout);
    
    log.verbose(`Queuing timer refreshed, will process in ${this.queuingTimeout}ms`);
  }

  /**
   * Start initialization process
   */
  async startInitialization() {
    log.info('Starting initialization process');
    this.state = 'initializing';
    
    log.info('Running iptables setup script in dry-run mode');
    try {
      const path = require('path');
      const setupScriptPath = path.join(f.getFirewallaHome(), 'control', 'install_iptables_setup.sh');
      
      await exec(setupScriptPath, { timeout: 10000 });
    } catch (err) {
      log.error(`Error running iptables setup script: ${err.message}`);
      throw err;
    }
    log.info('Iptables setup script completed successfully');

    // Clear queued rules in all modules
    this.modules.forEach(module => {
      module.flush()
    });
    
    log.info('Entered initializing state - rules can be added until finishInitialization is called');
  }

  /**
   * Finish initialization and enter processing state
   */
  async finishInitialization() {
    log.info('Finishing initialization process');
    
    if (this.state !== 'initializing') {
      throw new Error('finishInitialization can only be called in initializing state');
    }
    
    await this.enterProcessingState();

    log.info('Initialization completed');
  }

  /**
   * Enter idle state
   */
  enterIdleState() {
    // Clear timers and promises
    if (this.queuingTimer) {
      clearTimeout(this.queuingTimer);
      this.queuingTimer = null;
    }
    
    this.processingPromise = null;
    
    // Check if any module has queued rules
    const totalQueuedRules = this.modules.reduce((sum, module) => {
      return sum + (module.getQueuedRuleCount ? module.getQueuedRuleCount() : 0);
    }, 0);
    
    if (totalQueuedRules > 0) {
      // Enter queuing state if there are queued rules
      this.enterQueuingState();
    } else {
      // Enter idle state if no queued rules
      log.verbose('Entering idle state after processing (no queued rules)');
      this.state = 'idle';
    }
  }

  /**
   * Get current state
   */
  getState() {
    const totalQueuedRules = this.modules.reduce((sum, module) => {
      return sum + (module.getQueuedRuleCount ? module.getQueuedRuleCount() : 0);
    }, 0);
    
    return {
      state: this.state,
      queuedRulesCount: totalQueuedRules,
      modules: this.modules.map(module => ({
        name: module.name || module.constructor.name,
        queuedRulesCount: module.getQueuedRuleCount ? module.getQueuedRuleCount() : 0
      }))
    };
  }

  /**
   * Force flush rules immediately (for testing or emergency)
   */
  async forceFlush() {
    log.info('Force flushing rules');
    if (this.queuingTimer) {
      clearTimeout(this.queuingTimer);
    }
    await this.enterProcessingState();
  }

  /**
   * Clean up resources
   */
  flush() {
    if (this.queuingTimer) {
      clearTimeout(this.queuingTimer);
    }
    
    // Reset processing state
    this.processingPromise = null;
    
    // Clean up all modules
    this.modules.forEach(module => {
      if (module.flush) {
        module.flush();
      }
    });
  }
}

module.exports = new BlockControl()