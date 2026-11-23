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
const ethCounters = require('../net2/EthCounters.js');

// `ethtool -S` outputs captured from the testbed on 2026-10-22, trimmed to the counters that
// matter here and given non-zero values. Every driver in the fleet is represented:
//   igb          gold v1/v2            igc          gold plus, gold pro, gold max
//   st_gmac      gse, pse, purple      r8125        gse
//   mtk_soc_eth  orange, gold max      atlantic     gold pro, gold max
//   r8152        pse                   r8168        purple
// Adding a platform or a driver means adding a fixture here, not touching platform code
const OUTPUTS = {
  // XON and XOFF are counted separately, a PAUSE frame is one or the other
  igb: `NIC statistics:
     rx_packets: 7673657
     rx_crc_errors: 12
     rx_align_errors: 0
     rx_flow_control_xon: 21344
     rx_flow_control_xoff: 332628
     tx_flow_control_xon: 4
     tx_flow_control_xoff: 6`,

  igc: `NIC statistics:
     rx_packets: 889912
     rx_flow_control_xon: 1
     rx_flow_control_xoff: 2
     tx_flow_control_xon: 0
     tx_flow_control_xoff: 0`,

  // all is already on+off, adding the three up would double the count
  r8125: `NIC statistics:
     tx_packets: 2158111
     tx_pause_on: 3
     tx_pause_off: 4
     tx_pause_all: 7
     rx_pause_on: 100
     rx_pause_off: 900
     rx_pause_all: 1000
     align_errors: 5`,

  // mac_tx_in_pause and mac_tx_frame_ctrl_pause are FIFO state gauges from the descriptor
  // path, not frame counts
  st_gmac: `NIC statistics:
     mmc_tx_pause_frame: 8
     mmc_rx_pause_frames: 4096
     mmc_rx_crc_error: 137
     rx_crc_errors: 5
     mac_tx_in_pause: 99999
     mac_tx_frame_ctrl_pause: 88888`,

  // receive direction only, the driver has no transmit PAUSE counter. rx_checksum_errors is an
  // offload miss on a frame that did arrive, which is all its kernel rx_errors total holds
  mtk_soc_eth: `NIC statistics:
     tx_packets: 5219651
     rx_overflow: 0
     rx_fcs_errors: 1
     rx_short_errors: 4
     rx_long_errors: 0
     rx_checksum_errors: 7
     rx_flow_control_packets: 512`,

  // no PAUSE counter in any direction
  atlantic: `NIC statistics:
     InPackets: 2731
     InErrorsMAC: 0
     Queue[1] InErrors: 1
     PTP Queue[8] InErrors: 3`,

  r8152: `NIC statistics:
     tx_packets: 1108184
     rx_missed: 0
     align_errors: 1
     rx_errors: 9
     tx_errors: 3`,

  r8168: `NIC statistics:
     tx_packets: 0
     rx_missed: 0
     align_errors: 0
     rx_errors: 0
     tx_errors: 16
     tx_underrun: 0`,

  // mlx4_en, crystal's two 10G ports. The duration is microseconds and the transition is a
  // state-change count, neither is a frame count, so only rx_pause/tx_pause may be read
  mlx4_en: `NIC statistics:
     rx_packets: 44
     rx_pause: 25468
     rx_pause_duration: 918273
     rx_pause_transition: 37
     tx_pause: 5
     tx_pause_duration: 11
     tx_pause_transition: 2`,

  // a driver that grows the counter under the standardized ETHTOOL_A_PAUSE_STATS names, which
  // nothing in the fleet does today. It has to work without being added to the table
  unknown: `NIC statistics:
     rx_packets: 17
     rx_pause_frames: 70
     tx_pause_frames: 7`,
};

// resolves the ethtool rules of one metric, from a captured output instead of a live NIC
function resolve(driver, metric, output = OUTPUTS[driver]) {
  return ethCounters.resolve(metric, driver, ethCounters.parseEthtoolStats(output));
}

describe('EthCounters pause frames', function () {

  it('should add up XON and XOFF on igb and igc', () => {
    expect(resolve('igb', 'rxPause')).to.equal(21344 + 332628);
    expect(resolve('igb', 'txPause')).to.equal(10);
    expect(resolve('igc', 'rxPause')).to.equal(3);
    expect(resolve('igc', 'txPause')).to.equal(0);
  });

  it('should take only the total of the three r8125 counters', () => {
    // not rx_pause_on + rx_pause_off + rx_pause_all
    expect(resolve('r8125', 'rxPause')).to.equal(1000);
    expect(resolve('r8125', 'txPause')).to.equal(7);
  });

  it('should report nothing for st_gmac, whose MMC pause counters never populate', () => {
    // the names are in the output and would parse, but the register stays 0 on every box we
    // have: measured on a GSE with tcpdump proving the frames arrived, and on a Purple with a
    // different glue driver. A 0 here would claim the port has seen no PAUSE frames
    expect(resolve('st_gmac', 'rxPause')).to.be.undefined;
    expect(resolve('st_gmac', 'txPause')).to.be.undefined;
  });

  it('should report only the receive direction on mtk_soc_eth', () => {
    expect(resolve('mtk_soc_eth', 'rxPause')).to.equal(512);
    expect(resolve('mtk_soc_eth', 'txPause')).to.be.undefined;
  });

  it('should take only the frame counter of mlx4_en, not the duration or transitions', () => {
    expect(resolve('mlx4_en', 'rxPause')).to.equal(25468); // not 25468 + 918273 + 37
    expect(resolve('mlx4_en', 'txPause')).to.equal(5);
  });

  it('should report nothing for a driver without pause counters', () => {
    for (const driver of ['atlantic', 'r8152', 'r8168', 'st_gmac']) {
      expect(resolve(driver, 'rxPause'), driver).to.be.undefined;
      expect(resolve(driver, 'txPause'), driver).to.be.undefined;
    }
  });

  it('should fall back to the standardized names for an unlisted driver', () => {
    expect(resolve('unknown', 'rxPause')).to.equal(70);
    expect(resolve('unknown', 'txPause')).to.equal(7);
  });

  it('should report nothing rather than half a sum when a counter is missing', () => {
    const partial = OUTPUTS.igb.split('\n').filter(l => !l.includes('rx_flow_control_xoff')).join('\n');
    expect(resolve('igb', 'rxPause', partial)).to.be.undefined;
    expect(resolve('igb', 'txPause', partial)).to.equal(10); // the tx pair is still complete
  });
});

describe('EthCounters error counters', function () {

  // where each driver's errors have to be read from, out of the driver sources of every NIC in
  // the fleet. 'stat' is the kernel's own total under /sys/class/net/<nic>/statistics, 'names'
  // the driver's own registers through `ethtool -S`, undefined a port that cannot count it
  const SOURCES = {
    igb:         { rxError: 'stat',  txError: 'stat',  crcError: 'stat' },
    igc:         { rxError: 'stat',  txError: 'stat',  crcError: 'stat' },
    mlx4_en:     { rxError: 'stat',  txError: 'stat',  crcError: 'stat' },
    st_gmac:     { rxError: 'stat',  txError: 'stat',  crcError: 'stat' },
    atlantic:    { rxError: 'stat',  txError: 'stat',  crcError: undefined },
    r8125:       { rxError: 'stat',  txError: 'names', crcError: 'stat' },
    r8168:       { rxError: 'stat',  txError: 'names', crcError: 'stat' },
    r8152:       { rxError: 'names', txError: 'names', crcError: undefined },
    mtk_soc_eth: { rxError: 'names', txError: 'stat',  crcError: 'stat' },
    // the x86 server NICs a Crystal may be built with, it enumerates them at runtime
    ixgbe:       { rxError: 'stat',  txError: undefined, crcError: 'stat' },
    i40e:        { rxError: 'stat',  txError: 'stat',  crcError: 'stat' },
    ice:         { rxError: 'stat',  txError: 'stat',  crcError: 'stat' },
    e1000e:      { rxError: 'stat',  txError: 'stat',  crcError: 'stat' },
    mlx5_core:   { rxError: 'stat',  txError: 'stat',  crcError: 'stat' },
    bnxt_en:     { rxError: 'stat',  txError: 'stat',  crcError: 'stat' },
    tg3:         { rxError: 'stat',  txError: 'stat',  crcError: 'stat' },
  };

  it('should read each driver\'s errors from where that driver keeps them', () => {
    for (const driver in SOURCES)
      for (const metric in SOURCES[driver]) {
        const rule = ethCounters.ruleFor(metric, driver);
        const source = rule && ['stat', 'names', 'path', 'queues'].find(kind => kind in rule);
        expect(source, `${driver} ${metric}`).to.equal(SOURCES[driver][metric]);
      }
  });

  it('should report no CRC counter for the drivers that have none', () => {
    // atlantic (gold pro, gold max 10G) and r8152 (the PSE USB port) count CRC errors neither
    // in their own registers nor in the kernel's totals, so those ports report -1, not 0
    expect(ethCounters.ruleFor('crcError', 'atlantic')).to.be.undefined;
    expect(ethCounters.ruleFor('crcError', 'r8152')).to.be.undefined;
    expect(resolve('atlantic', 'crcError')).to.be.undefined;
  });

  it('should add up the mtk frame error registers and leave the checksum misses out', () => {
    // the kernel total of this driver is only rx_checksum_errors, an offload miss on a frame
    // that did arrive, so reading it would report 0 on a port that is losing frames
    expect(resolve('mtk_soc_eth', 'rxError')).to.equal(1 + 4 + 0);
  });

  it('should read each realtek direction the way that driver keeps it', () => {
    // these count rx in the kernel's totals but keep tx only in their own tally
    expect(resolve('r8168', 'txError')).to.equal(16);
    expect(resolve('r8152', 'rxError')).to.equal(9);
    expect(ethCounters.ruleFor('rxError', 'r8125').stat).to.equal('rx_errors');
  });

  it('should report nothing rather than half a sum when a register is missing', () => {
    const partial = OUTPUTS.mtk_soc_eth.split('\n').filter(l => !l.includes('rx_short_errors')).join('\n');
    expect(resolve('mtk_soc_eth', 'rxError', partial)).to.be.undefined;
  });

  it('should not read error counters off a driver nobody has checked', () => {
    // every error rule names its drivers on purpose: the files under statistics/ are there on
    // every port whether or not the driver writes them, so an unchecked driver would report a
    // confident 0 instead of -1
    for (const metric of ['rxError', 'txError', 'crcError'])
      expect(ethCounters.ruleFor(metric, 'unknown'), metric).to.be.undefined;
  });

  it('should report no transmit error counter for ixgbe', () => {
    // it counts them neither in the kernel's totals nor in its own registers, so a Crystal
    // built with one of these cards reports -1 for that row rather than a flat 0
    expect(ethCounters.ruleFor('txError', 'ixgbe')).to.be.undefined;
  });

  it('should keep the link counters driver independent', () => {
    // these come from sysfs files the kernel keeps for every netdev, there is nothing per
    // driver about them
    for (const metric of ['linkDown', 'carrierDown', 'carrierUp', 'txTimeout'])
      expect(ethCounters.ruleFor(metric, 'unknown'), metric).to.be.an('object');
  });
});

describe('EthCounters scope', function () {

  it('should keep the error and pause counters to the ethernet ports', () => {
    for (const metric of ['rxPause', 'txPause', 'rxError', 'txError', 'crcError', 'linkDown']) {
      expect(ethCounters.appliesTo(metric, true), metric).to.be.true;
      expect(ethCounters.appliesTo(metric, false), metric).to.be.false;
    }
  });

  it('should keep the legacy counters on every nic', () => {
    // wlan included, the same as the sensor has always done for them
    for (const metric of ['carrierDown', 'carrierUp', 'txTimeout'])
      expect(ethCounters.appliesTo(metric, false), metric).to.be.true;
  });
});

describe('EthCounters legacy counters', function () {

  it('should keep the keys the cloud already reads', () => {
    const legacy = {};
    for (const metric in ethCounters.ETH_COUNTERS)
      if (ethCounters.ETH_COUNTERS[metric].legacy)
        legacy[ethCounters.ETH_COUNTERS[metric].key] = metric;
    expect(Object.keys(legacy).sort()).to.deep.equal(['link_down', 'link_up', 'tx_timeout']);
  });

  it('should not let an app counter take over one of those keys', () => {
    // <nic>_crc and <nic>_speed are live readings SysInfo puts in the same payload, the other
    // three are lifetime totals of their own. A counter of this table writing one of them would
    // change a number the cloud has been reading for years
    for (const metric in ethCounters.ETH_COUNTERS) {
      const spec = ethCounters.ETH_COUNTERS[metric];
      if (!spec.legacy)
        expect(spec.key, metric).to.not.be.oneOf(['crc', 'speed', 'link_up', 'link_down', 'tx_timeout']);
    }
  });

  it('should read 0 where a legacy counter has nothing to read, and -1 for the app one', async () => {
    // the same missing file: Purple has no carrier_down_count, where the checkin kept reporting
    // 0 and has to keep doing so, while the app must be able to tell that apart from no flaps
    const context = ethCounters.nicContext('nosuchnic0');
    expect(await ethCounters.read('carrierDown', context)).to.equal(0);
    expect(await ethCounters.read('carrierUp', context)).to.equal(0);
    expect(await ethCounters.read('txTimeout', context)).to.equal(0);
    expect(await ethCounters.read('linkDown', context)).to.be.undefined;
  });

  it('should not be reset by the app', () => {
    // resetNicCounters only puts aside what the app shows, which these are not part of
    for (const metric in ethCounters.ETH_COUNTERS) {
      const spec = ethCounters.ETH_COUNTERS[metric];
      if (spec.legacy)
        expect(spec.nicStates, metric).to.not.be.true;
    }
  });
});

describe('EthCounters.sinceReset', function () {

  it('should report what the port has counted since its last reset', () => {
    expect(ethCounters.sinceReset(1532, '1000')).to.equal(532);
  });

  it('should report the lifetime total of a port that was never reset', () => {
    expect(ethCounters.sinceReset(1532, undefined)).to.equal(1532);
    expect(ethCounters.sinceReset(1532, null)).to.equal(1532);
  });

  it('should keep the -1 of a port that cannot count it', () => {
    // a reset stores no baseline for such a counter, and must not turn it into a 0 that claims
    // the port has seen none
    expect(ethCounters.sinceReset(-1, undefined)).to.equal(-1);
    expect(ethCounters.sinceReset(-1, '7')).to.equal(-1);
  });

  it('should never report a negative count', () => {
    // the total only grows, but a redis restore could leave it under its own baseline
    expect(ethCounters.sinceReset(3, '10')).to.equal(0);
  });
});

describe('EthCounters registry', function () {

  it('should not apply a driver-scoped rule to another driver', () => {
    // the r8125 counter names under a driver no rule lists them for, and no fallback name
    expect(resolve('igb', 'rxPause', OUTPUTS.r8125)).to.be.undefined;
  });

  it('should give every counter a redis key, a scope and rules', () => {
    for (const metric in ethCounters.ETH_COUNTERS) {
      const spec = ethCounters.ETH_COUNTERS[metric];
      expect(spec.key, metric).to.be.a('string').and.not.empty;
      expect(spec.scope, metric).to.be.oneOf(['eth', 'all']);
      expect(spec.rules, metric).to.be.an('array').and.not.empty;
      for (const rule of spec.rules) {
        // one place per rule, so that what a number came from is never ambiguous
        const sources = ['names', 'stat', 'path', 'queues'].filter(kind => kind in rule);
        expect(sources.length, metric).to.equal(1);
        if (rule.names) {
          expect(rule.names, metric).to.be.an('array').and.not.empty;
          expect(rule.agg, metric).to.be.oneOf(['sum', 'first', 'max']);
        }
      }
    }
  });

  it('should only expose a cumulative counter to the app', () => {
    // nicCountersForInit reads the redis total, which only a cumulative counter gets written to.
    // A gauge flagged nicStates would be collected and then silently dropped
    for (const metric in ethCounters.ETH_COUNTERS) {
      const spec = ethCounters.ETH_COUNTERS[metric];
      if (spec.nicStates)
        expect(spec.cumulative, metric).to.be.true;
    }
  });

  it('should give every counter a key of its own', () => {
    // the key is the field name in sys:ethInfo, two counters sharing one would overwrite each
    // other's lifetime total
    const keys = Object.keys(ethCounters.ETH_COUNTERS).map(m => ethCounters.ETH_COUNTERS[m].key);
    expect(new Set(keys).size).to.equal(keys.length);
  });

});

describe('EthCounters.parseEthtoolStats', function () {

  it('should clean up counter names with spaces and brackets', () => {
    expect(ethCounters.parseEthtoolStats(OUTPUTS.atlantic)).to.deep.equal({
      InPackets: 2731,
      InErrorsMAC: 0,
      Queue_1_InErrors: 1,
      PTP_Queue_8_InErrors: 3,
    });
  });

  it('should skip the header and any line without a number', () => {
    expect(ethCounters.parseEthtoolStats('NIC statistics:\n     no_stats\n')).to.deep.equal({});
  });
});
