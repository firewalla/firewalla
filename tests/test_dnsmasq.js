/*    Copyright 2016 Firewalla LLC
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

let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect;
let should = chai.should;

let log = require('../net2/logger.js')(__filename, 'info');

let fs = require('fs');
let cp = require('child_process');

let assert = chai.assert;

let Promise = require('bluebird');
Promise.promisifyAll(fs);

let Bootstrap = require('../net2/Bootstrap');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let DNSMASQSensor = require('../sensor/DNSMASQSensor');
let s = new DNSMASQSensor();

let ModeManager = require('../net2/ModeManager');

let DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
let dnsmasq = new DNSMASQ();

let fireRouter = require('../net2/FireRouter.js')
let sysManager = require('../net2/SysManager');

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

describe.skip('Test dnsmasq feature', function() {
  this.timeout(10000);

  beforeEach((done) => {
    (async() =>{
      require('../control/Block.js').setupBlockChain()
      await Bootstrap.bootstrap();
      sem.clearAllSubscriptions();
      s.registered = false;
      s.run()
      sem.emitEvent({
        type: 'IPTABLES_READY'
      })
      await delay(2000)
      await ModeManager.enableSecondaryInterface()
      done();
    })();
  });

  afterEach((done) => {
    s._stop()
      .then(() => {
        done();
      });
  });

  it('should translate and create iptables correctly', (done) => {
    dnsmasq._add_iptables_rules();
    dnsmasq._add_iptables_rules();
    dnsmasq._add_iptables_rules();
    dnsmasq._add_iptables_rules();
    dnsmasq._remove_iptables_rules();
    dnsmasq._remove_iptables_rules();
    dnsmasq._remove_iptables_rules();
    dnsmasq._remove_iptables_rules();
    done();
  })

  it('should reload correctly even multiple reload requests arrive at the same time', (done) => {
    sem.emitEvent({
      type: 'ReloadDNSRule'
    });
    sem.emitEvent({
      type: 'ReloadDNSRule'
    });
    sem.emitEvent({
      type: 'ReloadDNSRule'
    });
    sem.emitEvent({
      type: 'ReloadDNSRule'
    });

    delay(5000)
      .then(() => {
        cp.exec("ps aux | grep dnsmasq", (err) => {
          expect(err).to.be.null;
          done();
        })
      })
  });

  it('should enable dhcp mode if dhcp mode is enabled', (done) => {
    sem.emitEvent({
      type: 'StartDHCP'
    });

    (async() =>{
      await delay(2000)
      cp.exec("ps aux | grep dnsma[s]q | grep d[h]cp", (err, stdout, stderr) => {
        expect(err).to.be.null;
        done();
      });
    })();
  });

  it('should NOT enable dhcp mode if dhcp mode is not enable', (done) => {
    sem.emitEvent({
      type: 'StartDHCP'
    });

    (async() =>{
      await delay(2000)
      sem.emitEvent({
        type: 'StopDHCP'
      });
      await delay(2000)
      cp.exec("ps aux | grep dnsma[s]q | grep d[h]cp", (err, stdout, stderr) => {
        expect(err).to.not.null;
        done();
      });
    })();

  });
});

describe('Test dns connectivity', function(){
  this.timeout(30000);

  before((done) => {
    (async() =>{
      fireRouter.scheduleReload();
      await delay(2000)
      await sysManager.updateAsync();
      done();
    })();
  });

  after((done) => {
    // sysManager.release();
    done();
  });

  it('should check upstream dns connectivity', async()=> {
    const intfes = sysManager.getMonitoringInterfaces();
    for (const intf of intfes) {
        console.log("interface", intf.name, intf.resolver);
        const status = await dnsmasq.dnsUpstreamConnectivity(intf);
        console.log("dns ok:", status);
        expect(status).to.equal(true);
    }
  });
});
