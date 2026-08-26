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
const proxyquire = require('proxyquire');

// `ethtool -S` outputs captured from real boxes, trimmed to the interesting counters.
// the naming of error counters differs completely between drivers, which is why
// getEthErrorStats greps the output instead of looking for known counter names
const OUTPUTS = {
  // igb, gold/goldpro. tx_deferred_ok and rx_no_buffer_count are normal counters that
  // must not be picked up, dropped_smbus is not a link error either
  igb: `NIC statistics:
     rx_packets: 7673657
     collisions: 0
     rx_crc_errors: 12
     rx_no_buffer_count: 41
     rx_missed_errors: 3
     tx_deferred_ok: 9
     rx_align_errors: 0
     tx_errors: 2
     rx_fifo_errors: 0
     dropped_smbus: 0
     tx_queue_0_packets: 1554191
     rx_queue_0_csum_err: 7`,

  // stmmac, purple/gse/pse. counts rx CRC errors in two registers, mmc_* comes from the MMC
  // counters and rx_crc from the descriptor status, so <nic>_crc must not add them up.
  // mtl_*/mac_*/irq_* are FIFO state machine and LPI mode gauges, they are large and always moving
  stmmac: `NIC statistics:
     mmc_tx_underflow_error: 2
     mmc_rx_crc_error: 137
     mmc_rx_align_error: 4
     mmc_rx_watchdog_error: 0
     mmc_rx_ipv4_hderr: 3
     mmc_tx_deferred: 88888
     mmc_rx_ipc_intr_mask: 2111012122
     rx_crc_errors: 5
     rx_crc: 137
     dribbling_bit: 11
     fatal_bus_error_irq: 1
     rx_pkt_n: 1078291
     mtl_rx_fifo_fill_level_full: 999999
     mac_rx_frame_ctrl_fifo: 777777
     irq_rx_path_in_lpi_mode_n: 666666`,

  // realtek, purple eth1 / pse eth0 / gse eth0. no CRC counter at all, so no <nic>_crc is reported
  realtek: `NIC statistics:
     tx_packets: 100
     tx_errors: 3
     rx_errors: 0
     rx_missed: 12
     align_errors: 1
     tx_aborted: 2
     tx_underrun: 4
     multicast: 55`,

  // enetc, goldplus2 eth3. CamelCase names, brackets and spaces
  enetc: `NIC statistics:
     InErrorsMAC: 21
     Queue[0]_InErrors: 5
     Queue[1]_InErrors: 0
     PTP_Queue[8]_InErrors: 3
     Tx LPI entry counter: 9`,

  // goldplus2 eth0/eth4, CRC errors are named after the frame check sequence here
  fcs: `NIC statistics:
     rx_fcs_errors: 44
     rx_short_errors: 0
     rx_long_errors: 0
     rx_xdp_tx_errors: 0`,

  // healthy box, every error counter reads zero
  clean: `NIC statistics:
     rx_packets: 100
     rx_crc_errors: 0
     rx_errors: 0
     tx_errors: 0`,

  // a driver that reports nothing
  empty: `NIC statistics:`,
};

// loads SysInfo.js with `ethtool -S <nic>` answered from the fixtures above.
// a nic without a fixture makes exec reject, the same way ethtool fails on a driver
// that does not support statistics
function loadSysInfo(fixtures) {
  return proxyquire('../extension/sysinfo/SysInfo.js', {
    'child-process-promise': {
      exec: async (cmd) => {
        const match = cmd.match(/^ethtool -S (\S+)$/);
        if (!match || !(match[1] in fixtures))
          throw new Error(`Command failed: ${cmd}`);
        return { stdout: fixtures[match[1]] + "\n", stderr: "" };
      },
    },
  });
}

describe('SysInfo.getEthErrorStats', function () {
  this.timeout(10000);

  it('should collect the non-zero error counters of igb and skip the normal ones', async () => {
    const sysInfo = loadSysInfo({ eth0: OUTPUTS.igb });
    const stats = await sysInfo.getEthErrorStats('eth0');
    expect(stats).to.deep.equal({
      eth0_rx_crc_errors: 12,
      eth0_rx_missed_errors: 3,
      eth0_tx_errors: 2,
      eth0_crc: 12,
    });
    // rx_no_buffer_count/tx_deferred_ok/dropped_smbus/rx_queue_0_csum_err carry no "error" in
    // their names, they are not collected even though they are non-zero
    expect(Object.keys(stats)).to.have.lengthOf(4);
  });

  it('should take the max of the CRC counters instead of adding them up', async () => {
    const sysInfo = loadSysInfo({ eth1: OUTPUTS.stmmac });
    const stats = await sysInfo.getEthErrorStats('eth1');
    expect(stats.eth1_crc).to.equal(137); // not 137 + 5 + 137
    expect(stats.eth1_mmc_rx_crc_error).to.equal(137);
    expect(stats.eth1_rx_crc_errors).to.equal(5);
  });

  it('should not report the state gauges and the non-error counters of stmmac', async () => {
    const sysInfo = loadSysInfo({ eth1: OUTPUTS.stmmac });
    const stats = await sysInfo.getEthErrorStats('eth1');
    expect(stats).to.deep.equal({
      eth1_mmc_tx_underflow_error: 2,
      eth1_mmc_rx_crc_error: 137,
      eth1_mmc_rx_align_error: 4,
      eth1_rx_crc_errors: 5,
      eth1_fatal_bus_error_irq: 1,
      eth1_crc: 137,
    });
    // rx_crc has no "error" in its name, it only feeds <nic>_crc
    expect(stats).to.not.have.property('eth1_rx_crc');
    // counters abbreviated to err are out of scope on purpose, matching err instead of error
    // would also pick up normal counters like tx_deferred_ok of igb
    expect(stats).to.not.have.property('eth1_mmc_rx_ipv4_hderr');
  });

  it('should report no CRC field for a driver without a CRC counter', async () => {
    const sysInfo = loadSysInfo({ eth1: OUTPUTS.realtek });
    const stats = await sysInfo.getEthErrorStats('eth1');
    expect(stats).to.deep.equal({
      eth1_tx_errors: 3,
      eth1_align_errors: 1,
    });
    expect(stats).to.not.have.property('eth1_crc');
  });

  it('should match error counters case insensitively and clean up the counter names', async () => {
    const sysInfo = loadSysInfo({ eth3: OUTPUTS.enetc });
    const stats = await sysInfo.getEthErrorStats('eth3');
    expect(stats).to.deep.equal({
      eth3_InErrorsMAC: 21,
      eth3_Queue_0_InErrors: 5,
      eth3_PTP_Queue_8_InErrors: 3,
    });
  });

  it('should take rx_fcs_errors as the CRC counter', async () => {
    const sysInfo = loadSysInfo({ eth0: OUTPUTS.fcs });
    const stats = await sysInfo.getEthErrorStats('eth0');
    expect(stats).to.deep.equal({
      eth0_rx_fcs_errors: 44,
      eth0_crc: 44,
    });
  });

  it('should report the CRC counter only on a healthy NIC', async () => {
    const sysInfo = loadSysInfo({ eth2: OUTPUTS.clean });
    // <nic>_crc is reported even when it is 0, it is the field the cloud has been reading
    expect(await sysInfo.getEthErrorStats('eth2')).to.deep.equal({ eth2_crc: 0 });
  });

  it('should return an empty result when the driver reports no counter', async () => {
    const sysInfo = loadSysInfo({ eth0: OUTPUTS.empty });
    expect(await sysInfo.getEthErrorStats('eth0')).to.deep.equal({});
  });

  it('should return null when ethtool fails', async () => {
    const sysInfo = loadSysInfo({});
    expect(await sysInfo.getEthErrorStats('eth0')).to.be.null;
  });
});
