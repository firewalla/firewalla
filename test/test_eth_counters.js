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

  // receive direction only, the driver has no transmit PAUSE counter
  mtk_soc_eth: `NIC statistics:
     tx_packets: 5219651
     rx_overflow: 0
     rx_fcs_errors: 1
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
     tx_errors: 3`,

  r8168: `NIC statistics:
     tx_packets: 0
     rx_missed: 0
     align_errors: 0
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

// resolves one metric the way collect() does, from a captured output instead of a live NIC
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

describe('EthCounters registry', function () {

  it('should not apply a driver-scoped rule to another driver', () => {
    // the r8125 counter names under a driver no rule lists them for, and no fallback name
    expect(resolve('igb', 'rxPause', OUTPUTS.r8125)).to.be.undefined;
  });

  it('should give every counter a redis key, a source and rules', () => {
    for (const metric in ethCounters.ETH_COUNTERS) {
      const spec = ethCounters.ETH_COUNTERS[metric];
      expect(spec.key, metric).to.be.a('string').and.not.empty;
      expect(spec.source, metric).to.be.a('string').and.not.empty;
      if (spec.source !== 'ethtool')
        continue;
      expect(spec.rules, metric).to.be.an('array').and.not.empty;
      for (const rule of spec.rules) {
        expect(rule.names, metric).to.be.an('array').and.not.empty;
        expect(rule.agg, metric).to.be.oneOf(['sum', 'first', 'max']);
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

  it('should only mark a counter cumulative when collect() actually reads it', () => {
    // NicStateSensor persists the cumulative counters out of collect(), which only fills the
    // ethtool-sourced ones. A cumulative counter from another source would read as missing
    // every round and get pinned to the -1 "driver cannot count it" sentinel
    for (const metric in ethCounters.ETH_COUNTERS) {
      const spec = ethCounters.ETH_COUNTERS[metric];
      if (spec.cumulative)
        expect(spec.source, metric).to.equal('ethtool');
    }
  });

  it('should not collide with the counter keys the cloud already reads', () => {
    const keys = Object.keys(ethCounters.ETH_COUNTERS).map(m => ethCounters.ETH_COUNTERS[m].key);
    for (const existing of ['crc', 'speed', 'link_up', 'link_down', 'tx_timeout'])
      expect(keys, existing).to.not.include(existing);
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
