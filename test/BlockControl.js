/*    Copyright 2016-2026 Firewalla Inc.
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

const { expect } = require('chai');
const blockControl = require('../control/BlockControl.js');
const ModuleControl = require('../control/ModuleControl.js');

describe('BlockControl.enterProcessingState', function () {
  this.timeout(5000);

  const saved = {};
  const received = {};

  // a module whose restore, like ipset's, runs long enough for another enforce to arrive
  class FakeModule extends ModuleControl {
    constructor(name, queue, onProcess) {
      super(name);
      this.queuedRules = queue;
      this.onProcess = onProcess;
    }
    async processRules(batch) {
      received[this.name] = batch;
      if (this.onProcess) this.onProcess();
    }
    getQueuedRuleCount() {
      return this.queuedRules.length;
    }
  }
  const fakeModule = (name, queue, onProcess) => new FakeModule(name, queue, onProcess);

  before(() => {
    saved.modules = blockControl.modules;
    saved.state = blockControl.state;
  });

  after(() => {
    if (blockControl.queuingTimer) {
      clearTimeout(blockControl.queuingTimer);
      blockControl.queuingTimer = null;
    }
    blockControl.modules = saved.modules;
    blockControl.state = saved.state;
  });

  it('a rule enqueued while an earlier module processes waits for the next round with its sets', async () => {
    const second = fakeModule('iptables', ['rule queued before the round']);
    const first = fakeModule('ipset', ['create queued before the round'], () => {
      // the enforce of a rule during the first module's restore: its set into the first module's
      // queue, which was already taken, and its rule into the second module's queue
      first.queuedRules.push('create queued during the round');
      second.queuedRules.push('rule queued during the round');
    });
    blockControl.modules = [first, second];
    blockControl.state = 'initializing';

    await blockControl.enterProcessingState();

    expect(received.ipset).to.deep.equal(['create queued before the round']);
    expect(received.iptables).to.deep.equal(['rule queued before the round']);
    expect(first.queuedRules).to.deep.equal(['create queued during the round']);
    expect(second.queuedRules).to.deep.equal(['rule queued during the round']);
    // both halves are still queued, so the round is followed by another instead of autonomous
    expect(blockControl.state).to.equal('queuing');
  });
});
