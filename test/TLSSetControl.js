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
const fs = require('fs');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const tlsc = require('../control/TLSSetControl.js');

describe('TLSSetControl activation marks across processing rounds', function () {
  this.timeout(5000);

  const saved = {};

  // no hostset file exists, so a refresh that trusts /proc alone drops every mark
  before(() => {
    // a running FireMain answers BlockControl's phase request on this channel, which would set the
    // phase to autonomous in the middle of a case; the listeners go back when the suite is done
    saved.listeners = sem.rawListeners('Control:StateChanged');
    sem.clearEventType('Control:StateChanged');
    saved.readdir = fs.promises.readdir;
    saved.tcp = platform.isTLSBlockSupport;
    saved.udp = platform.isUdpTLSBlockSupport;
    saved.phase = tlsc.phase;
    fs.promises.readdir = async () => [];
    platform.isTLSBlockSupport = () => true;
    platform.isUdpTLSBlockSupport = () => true;
    tlsc.setPhase('init');
  });

  // a case that enters the autonomous phase starts the hourly refresh timer; leaving it stops the timer
  afterEach(() => {
    tlsc.setPhase('init');
  });

  after(() => {
    fs.promises.readdir = saved.readdir;
    platform.isTLSBlockSupport = saved.tcp;
    platform.isUdpTLSBlockSupport = saved.udp;
    tlsc.setPhase(saved.phase);
    for (const listener of saved.listeners) sem.on('Control:StateChanged', listener);
  });

  it('a set marked after the snapshot stays active through that round, and is judged from /proc in the next', async () => {
    tlsc.takeQueue(); // the round's snapshot
    tlsc.activateTLSSet('c_bd_late_tls_hostset'); // a rule enforced while the round runs
    await tlsc.processRules(tlsc.emptyQueue()); // the refresh at the end of the round
    expect(tlsc.isSetActive('c_bd_late_tls_hostset', 'tcp')).to.equal(true);
    expect(tlsc.isSetActive('c_bd_late_tls_hostset', 'udp')).to.equal(true);

    tlsc.takeQueue(); // next round: the rule is in this batch
    await tlsc.processRules(tlsc.emptyQueue()); // still no file, so the rule did not land
    expect(tlsc.isSetActive('c_bd_late_tls_hostset')).to.equal(false);
  });

  it('a deactivated set is not brought back by the refresh', async () => {
    tlsc.takeQueue();
    tlsc.activateTLSSet('c_bd_gone_tls_hostset');
    tlsc.deactivateTLSSet('c_bd_gone_tls_hostset');
    await tlsc.processRules(tlsc.emptyQueue());
    expect(tlsc.isSetActive('c_bd_gone_tls_hostset')).to.equal(false);
  });

  it('a refresh scheduled by an unenforce is pending until its backoff has run', async () => {
    tlsc.setPhase('autonomous');
    tlsc.scheduleRefresh();
    expect(tlsc.isRefreshPending()).to.equal(true);
    await new Promise(resolve => setTimeout(resolve, 2100)); // REFRESH_BACKOFF_MS plus margin
    expect(tlsc.isRefreshPending()).to.equal(false);
  });

  it('entering the autonomous phase leaves nothing pending', async () => {
    tlsc.takeQueue();
    tlsc.activateTLSSet('c_bd_last_tls_hostset');
    tlsc.setPhase('autonomous');
    await tlsc.refreshTLSCategoryActivated();
    expect(tlsc.isSetActive('c_bd_last_tls_hostset')).to.equal(false);
  });
});
