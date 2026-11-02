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

const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child-process-promise');

// Driver counters the box reports per NIC, on top of the ones SysInfo and NicStateSensor
// already collect - those keep reading what they read today, this table is where a new counter
// goes. Every driver names the same hardware counter differently and only some have it at all,
// so a counter here is one normalized metric plus the rules that build it per driver. A NIC
// whose driver has nothing for a metric simply does not report that metric.
//
// Per metric:
//   key         field suffix in redis sys:ethInfo, <nic>_<key>, and what the checkin carries.
//   source      where the value comes from. 'ethtool' is a counter in `ethtool -S`; a counter
//               read from somewhere else adds its source to collect() below.
//   cumulative  NicStateSensor diffs it every minute and keeps a lifetime total in redis that
//               survives a reboot and a counter reset.
//   nicStates   exposed to the app in init data's nicStates. Reads the redis total, so it only
//               applies to a cumulative counter - a gauge would need a store of its own first.
//               The registry test holds this to stop a counter going silently missing.
//   rules       tried in order, first match wins. A rule with `drivers` applies only to those
//               drivers; a rule without one is the generic fallback, so an unknown NIC that
//               uses a common counter name still works with no code change. Keep the fallback
//               names conservative - a name that merely looks right (align_errors is frame
//               alignment, not CRC) silently reports a wrong number.
//                 agg 'sum'   every listed counter must be present, then they are added up.
//                             All or nothing, half a sum is worse than no value.
//                 agg 'first' the first listed counter that is present wins.
//                 agg 'max'   the largest of the listed counters that are present.
const ETH_COUNTERS = {
  // 802.3x PAUSE frames received on the port. A port being flooded with these by the switch in
  // front of it stalls the box's transmit path without showing up anywhere else: the MAC
  // consumes PAUSE frames, they never reach the stack, so /sys/class/net/<nic>/statistics and
  // /proc/net/dev cannot see them. firecommit#10330
  rxPause: {
    key: 'rx_pause', source: 'ethtool', cumulative: true, nicStates: true,
    rules: [
      // igb (gold) and igc (gold plus, gold pro, gold max) count XON and XOFF separately. Both
      // are PAUSE frames - quanta 0 is XON, which releases the pause, non-zero is XOFF - so the
      // frame count is the sum of the two
      { drivers: ['igb', 'igc', 'e1000e', 'ixgbe'], agg: 'sum', names: ['rx_flow_control_xon', 'rx_flow_control_xoff'] },
      // r8125 (gse) reports on, off and all, where all is already on+off. Adding up all three
      // doubles the count, which is why the rules are keyed on the driver instead of matching
      // every counter with pause in its name
      { drivers: ['r8125', 'r8126'], agg: 'first', names: ['rx_pause_all'] },
      // No rule for st_gmac (gse, pse, purple). It lists mmc_rx_pause_frames, because stmmac
      // always prints the whole MMC set, but the register is never populated: measured on a GSE
      // (rk_gmac-dwmac, 5.10) with PAUSE frames proven to arrive by tcpdump, with rx flow
      // control both off and on, and on a Purple (meson6-dwmac, 4.9) - the counter stayed 0 and
      // the frames were not even added to mmc_rx_framecount_gb. Reporting its 0 would say the
      // port has seen no PAUSE frames when it cannot tell, so these ports report -1 instead.
      // Its mac_tx_in_pause / mac_tx_frame_ctrl_pause are FIFO state gauges, not frame counts
      // mtk_soc_eth has a single counter and, measured on a Gold Max, it counts only the XOFF
      // frames - a XON-only burst left it untouched. That is the half that matters, a storm is
      // XOFF, but it does mean the same storm reads about half of what an igb/igc port reports
      { drivers: ['mtk_soc_eth'], agg: 'first', names: ['rx_flow_control_packets'] },
      // mlx4_en (crystal 10G) also reports rx_pause_duration and rx_pause_transition, which are
      // a time and a transition count - naming the frame counter explicitly keeps them out
      { drivers: ['mlx4_en'], agg: 'first', names: ['rx_pause'] },
      // the standard name, from ETHTOOL_A_PAUSE_STATS. No driver in the fleet implements the
      // pause statistics group yet - `ethtool -S <nic> --groups pause` answers EOPNOTSUPP on
      // every box - but one that grows the counter under its own -S output lands here
      { agg: 'first', names: ['rx_pause_frames', 'pause_frames_rx'] },
    ],
  },

  // PAUSE frames the box itself sent, i.e. the box asking the other end to slow down.
  // mtk_soc_eth counts only the receive direction, so Orange and the Gold Max 10G and SFP+
  // ports report rxPause without txPause
  txPause: {
    key: 'tx_pause', source: 'ethtool', cumulative: true, nicStates: true,
    rules: [
      { drivers: ['igb', 'igc', 'e1000e', 'ixgbe'], agg: 'sum', names: ['tx_flow_control_xon', 'tx_flow_control_xoff'] },
      { drivers: ['r8125', 'r8126'], agg: 'first', names: ['tx_pause_all'] },
      { drivers: ['mlx4_en'], agg: 'first', names: ['tx_pause'] },
      // no st_gmac rule, same as rxPause. mmc_tx_pause_frame was not measured directly - making
      // the box send PAUSE frames needs real congestion - but it sits in the same dead MMC block
      { agg: 'first', names: ['tx_pause_frames', 'pause_frames_tx'] },
    ],
  },
};

// some drivers put spaces or brackets in a counter name, e.g. "Queue[0] InErrors" of atlantic
// becomes Queue_0_InErrors
function cleanName(name) {
  return name.trim().replace(/[\W_]+/g, "_").replace(/^_|_$/g, "");
}

// `ethtool -S` output to { <counter>: <value> }. The "NIC statistics:" header does not match,
// there is no number after its colon
function parseEthtoolStats(output) {
  const stats = {};
  for (const line of output.split("\n")) {
    // e.g. "     mmc_rx_pause_frames: 0", ethtool indents counters by 5 spaces, \s* just in case
    const match = line.match(/^\s*(\S.*?):\s*(\d+)\s*$/);
    if (match)
      stats[cleanName(match[1])] = Number(match[2]);
  }
  return stats;
}

// the value of one metric for a NIC on `driver`, undefined when no rule matches, i.e. the
// driver has no counter for it
function resolve(metric, driver, stats) {
  for (const rule of ETH_COUNTERS[metric].rules) {
    if (rule.drivers && !rule.drivers.includes(driver))
      continue;
    const names = rule.names.filter(name => name in stats);
    // an explicit sum is all or nothing, a partial sum would silently under-report
    if (rule.agg === 'sum' && names.length !== rule.names.length)
      continue;
    if (!names.length)
      continue;
    const values = names.map(name => stats[name]);
    switch (rule.agg) {
      case 'sum': return values.reduce((sum, value) => sum + value, 0);
      case 'max': return Math.max(...values);
      default: return values[0]; // 'first'
    }
  }
  return undefined;
}

// Cached per-nic keyed on ifindex, not just name, since a USB NIC can be swapped while keeping
// the same nic name (udev pins name to port); ifindex changes when that happens
const driverCache = {};

async function getDriver(nic) {
  const ifindex = await fsp.readFile(`/sys/class/net/${nic}/ifindex`, {encoding: 'utf8'}).then(result => result.trim()).catch(() => null);
  const cached = driverCache[nic];
  if (cached !== undefined && ifindex !== null && cached.ifindex === ifindex)
    return cached.driver;

  const driver = await execFile('ethtool', ['-i', nic]).then(result => {
    const match = result.stdout.match(/^driver:\s*(\S+)/m);
    return match ? match[1] : "";
  }).catch(() => "");

  // never cache a failed lookup. ifindex does not change when ethtool just fails once, e.g. a
  // fork hitting EAGAIN, so a cached "" would stick for the life of the process and silently
  // turn off every driver-specific rule for this NIC
  if (!driver)
    return "";

  if (ifindex !== null)
    driverCache[nic] = {driver, ifindex};
  return driver;
}

// Every registered counter of one NIC, from a single `ethtool -S` call.
//   an object  what the NIC reports. A counter the driver cannot report is left out rather than
//              set to 0, so that the caller can tell the two apart - NicStateSensor stores it
//              as -1. {} means the driver has statistics but none of the counters, e.g. atlantic
//   null       the NIC could not be read this round, which says nothing about what its driver
//              supports: the ethtool fork can fail on its own, e.g. EAGAIN under memory
//              pressure, and the NIC may be mid-reset. The caller must leave what it stored
//              alone, not record the counters as unsupported
async function collect(nic) {
  const output = await execFile("ethtool", ["-S", nic]).then(result => result.stdout).catch(() => null);
  if (!output)
    return null;

  const stats = parseEthtoolStats(output);
  // without the driver every driver-specific rule is skipped and a NIC that does support the
  // counter would look like one that does not, so treat it as a NIC that could not be read
  const driver = await getDriver(nic);
  if (!driver)
    return null;

  const result = {};
  for (const metric in ETH_COUNTERS) {
    if (ETH_COUNTERS[metric].source !== 'ethtool')
      continue;
    const value = resolve(metric, driver, stats);
    if (value !== undefined)
      result[metric] = value;
  }
  return result;
}

module.exports = {
  ETH_COUNTERS,
  collect,
  // exported for the tests, which feed captured `ethtool -S` outputs through them without
  // needing an actual NIC
  parseEthtoolStats,
  resolve,
};
