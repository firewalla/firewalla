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

// Every per-port counter the box keeps, in one table. NicStateSensor walks it once a minute and
// keeps a lifetime total of each one in redis sys:ethInfo, HostManager puts the ones marked
// nicStates into init data. A new counter is a row here, not code in the sensor.
//
// Per counter:
//   key         field suffix in sys:ethInfo, <nic>_<key>, and what the checkin carries. Never
//               rename one, the cloud reads these.
//   scope       'eth' for the box's ethernet ports, 'all' for every NIC the platform lists.
//   legacy      a counter that predates the -1 convention and that the cloud already reads out
//               of the checkin under this exact key. A source that is not there reads 0 and the
//               counter is kept for a NIC that is not plugged in, both the way they were before
//               this table existed - nothing reading them today may see a number change.
//   cumulative  the sensor diffs it every minute and keeps a lifetime total in redis that
//               survives a reboot and a driver counter reset.
//   nicStates   exposed to the app in init data's nicStates, minus what Reset Stats set aside.
//               Reads the redis total, so it only applies to a cumulative counter - a gauge
//               would need a store of its own first. The registry test holds this to stop a
//               counter going silently missing.
//   rules       tried in order, the first rule that applies to the driver and has something to
//               read wins. Each rule reads from exactly one place:
//                 stat     /sys/class/net/<nic>/statistics/<stat>, the total the kernel keeps
//                          itself, i.e. what `ip -s link` prints
//                 path     a file under /sys/class/net/<nic>/
//                 queues   the sum of <queues> over /sys/class/net/<nic>/queues/tx-*/
//                 names    counters out of `ethtool -S`, combined by agg: 'sum' adds them up
//                          and needs every one of them, since half a sum under-reports,
//                          'first' takes the first one present, 'max' the largest present
//               `drivers` limits a rule to those drivers, a rule without it applies to any.
//               A NIC that matches no rule cannot count that metric: the sensor stores -1
//               rather than 0, so "has seen none" and "cannot tell" stay apart.
//
// Why the error counters name drivers instead of just reading the kernel's own totals: the
// files under /sys/class/net/<nic>/statistics exist on every port whether or not the driver
// ever writes them, so a driver that keeps its errors only in its own registers would read as a
// port that has seen no errors - the one thing the -1 convention exists to prevent. Read out of
// the driver sources of every NIC in the fleet (2026-11-19):
//   igb, igc, mlx4_en, atlantic  fill rx_errors and tx_errors from the hardware counters
//   st_gmac                      rx_errors and tx_errors in the rx/tx paths, rx_crc_errors off
//                                the descriptor status (enh_desc, norm_desc, dwmac4_descs)
//   r8125, r8168                 rx_errors and rx_crc_errors in the rx path, nothing for tx -
//                                their own tally counter has it
//   r8152                        netdev stats only for failed tx URBs, so both directions come
//                                from the tally instead
//   mtk_soc_eth                  rx_errors is hw_stats->rx_checksum_errors and nothing else,
//                                measured on a Gold Max: a port reading rx_fcs_errors 1 and
//                                rx_short_errors 4 still had rx_errors 0. Its input errors are
//                                the sum of its own frame error registers
//   atlantic, r8152              have no CRC counter at all, in either place
// The x86 server NICs a Crystal may be built with are read the same way, checked in the same
// sources: ixgbe, i40e, ice, e1000e, mlx5_core, bnxt_en and tg3 all fill the kernel's totals,
// except that ixgbe keeps no transmit error count anywhere, so such a port reports -1 for
// txError. Crystal enumerates its NICs at runtime and ships with whatever card is in it, so a
// driver that is not in this table reports -1 rather than a 0 nobody has checked - adding a
// platform or a card means adding a row here, which the registry test is there to force
const ETH_COUNTERS = {
  // 802.3x PAUSE frames received on the port. A port being flooded with these by the switch in
  // front of it stalls the box's transmit path without showing up anywhere else: the MAC
  // consumes PAUSE frames, they never reach the stack, so /sys/class/net/<nic>/statistics and
  // /proc/net/dev cannot see them. firecommit#10330
  rxPause: {
    key: 'rx_pause', scope: 'eth', cumulative: true, nicStates: true,
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
      //
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
    key: 'tx_pause', scope: 'eth', cumulative: true, nicStates: true,
    rules: [
      { drivers: ['igb', 'igc', 'e1000e', 'ixgbe'], agg: 'sum', names: ['tx_flow_control_xon', 'tx_flow_control_xoff'] },
      { drivers: ['r8125', 'r8126'], agg: 'first', names: ['tx_pause_all'] },
      { drivers: ['mlx4_en'], agg: 'first', names: ['tx_pause'] },
      // no st_gmac rule, same as rxPause. mmc_tx_pause_frame was not measured directly - making
      // the box send PAUSE frames needs real congestion - but it sits in the same dead MMC block
      { agg: 'first', names: ['tx_pause_frames', 'pause_frames_tx'] },
    ],
  },

  // Frames the port received but could not hand up: a bad frame check sequence, a runt, a giant,
  // a FIFO overrun. The app's Input Errors. firecommit#11022
  rxError: {
    key: 'rx_error', scope: 'eth', cumulative: true, nicStates: true,
    rules: [
      { drivers: ['igb', 'igc', 'e1000e', 'ixgbe', 'i40e', 'ice', 'mlx4_en', 'mlx5_core', 'bnxt_en', 'tg3',
                  'atlantic', 'st_gmac', 'r8125', 'r8126', 'r8168', 'r8169'], stat: 'rx_errors' },
      // mtk keeps only the checksum errors under rx_errors, so the frame errors are read out of
      // its own three registers. rx_checksum_errors is deliberately left out: it is an offload
      // miss on a frame that did arrive, not a frame the port lost
      { drivers: ['mtk_soc_eth'], agg: 'sum', names: ['rx_fcs_errors', 'rx_short_errors', 'rx_long_errors'] },
      { drivers: ['r8152'], agg: 'first', names: ['rx_errors'] },
    ],
  },

  // Frames the port could not send: late collisions, carrier loss, an aborted transmit. The
  // app's Output Errors. On mtk this is the kernel's own total, which that driver only grows on
  // a transmit timeout, so the number is thin rather than wrong
  txError: {
    key: 'tx_error', scope: 'eth', cumulative: true, nicStates: true,
    rules: [
      // no ixgbe rule: that driver counts transmit errors neither in the kernel's totals nor in
      // its own registers
      { drivers: ['igb', 'igc', 'e1000e', 'i40e', 'ice', 'mlx4_en', 'mlx5_core', 'bnxt_en', 'tg3',
                  'atlantic', 'st_gmac', 'mtk_soc_eth'], stat: 'tx_errors' },
      { drivers: ['r8125', 'r8126', 'r8168', 'r8169', 'r8152'], agg: 'first', names: ['tx_errors'] },
    ],
  },

  // Frames dropped for a bad frame check sequence - a bad cable, a duplex mismatch or a dying
  // port. SysInfo already reports <nic>_crc, but that is a live reading of the driver register
  // and goes back to 0 whenever the driver resets it, so the lifetime total keeps its own key.
  // The frame check sequence is the CRC: mtk names its register rx_fcs_errors and the kernel
  // puts it under rx_crc_errors all the same. Not align_errors, which is frame alignment
  crcError: {
    key: 'crc_error', scope: 'eth', cumulative: true, nicStates: true,
    rules: [
      { drivers: ['igb', 'igc', 'e1000e', 'ixgbe', 'i40e', 'ice', 'mlx4_en', 'mlx5_core', 'bnxt_en', 'tg3',
                  'st_gmac', 'r8125', 'r8126', 'r8168', 'r8169', 'mtk_soc_eth'], stat: 'rx_crc_errors' },
      // no rule for atlantic (gold pro, gold max 10G) or r8152 (pse USB port): neither counts
      // CRC errors anywhere, so those ports report -1
    ],
  },

  // Times the link went down, i.e. how often the cable, the port or the other end dropped out.
  // carrier_down_count is a lifetime count the kernel keeps for every netdev, but it only
  // arrived in 4.13: on Purple (4.9) the file is not there, which is a port that cannot tell
  // rather than one that never flapped, so it reports -1. carrier_changes, the one that kernel
  // does have, counts both directions together and is not the same number.
  // A key of its own rather than the <nic>_link_down below: that one is in the checkin already
  // and reads 0 on those boxes, and nothing reading it today may start seeing a -1
  linkDown: {
    key: 'link_drop', scope: 'eth', cumulative: true, nicStates: true,
    rules: [ { path: 'carrier_down_count' } ],
  },

  // The three counters the sensor kept before this table existed, under the keys the cloud
  // reads them by. Same files, same values, same 0 where the kernel keeps no counter - they are
  // listed here to be collected by the one loop rather than by a list of their own
  carrierDown: {
    key: 'link_down', scope: 'all', cumulative: true, nicStates: false, legacy: true,
    rules: [ { path: 'carrier_down_count' } ],
  },

  carrierUp: {
    key: 'link_up', scope: 'all', cumulative: true, nicStates: false, legacy: true,
    rules: [ { path: 'carrier_up_count' } ],
  },

  // transmit watchdog timeouts, i.e. the driver gave up waiting for the hardware to drain a
  // queue. Summed over the queues, a port has one file per tx queue
  txTimeout: {
    key: 'tx_timeout', scope: 'all', cumulative: true, nicStates: false, legacy: true,
    rules: [ { queues: 'tx_timeout' } ],
  },
};

// field in sys:ethInfo:base, <nic>_stats_since, seconds. Written only when the app resets a
// port, so the absence of it means that port has never been reset and the app has no "counting
// since" time to show
const STATS_SINCE = 'stats_since';

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

// the ethtool rules of one metric against a driver and a captured `ethtool -S`, undefined when
// none of them has anything on this driver
function resolve(metric, driver, stats) {
  for (const rule of ETH_COUNTERS[metric].rules) {
    if (!rule.names || (rule.drivers && !rule.drivers.includes(driver)))
      continue;
    const value = aggregate(rule, stats);
    if (value !== undefined)
      return value;
  }
  return undefined;
}

function aggregate(rule, stats) {
  const names = rule.names.filter(name => name in stats);
  // an explicit sum is all or nothing, a partial sum would silently under-report
  if (rule.agg === 'sum' && names.length !== rule.names.length)
    return undefined;
  if (!names.length)
    return undefined;
  const values = names.map(name => stats[name]);
  switch (rule.agg) {
    case 'sum': return values.reduce((sum, value) => sum + value, 0);
    case 'max': return Math.max(...values);
    default: return values[0]; // 'first'
  }
}

// the rule that a metric is read from on this driver, undefined when the driver has none. What
// the registry test checks the per-driver matrix with, without needing a NIC
function ruleFor(metric, driver) {
  return (ETH_COUNTERS[metric].rules || []).find(rule => !rule.drivers || rule.drivers.includes(driver));
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

// one number out of a sysfs file.
//   a number    what the kernel has counted
//   undefined   the file is not there, i.e. this kernel or driver does not keep the counter
//   null        it is there but could not be read or did not hold a number this round, which
//               says nothing about whether the counter exists
async function readFileCounter(path) {
  return fsp.readFile(path, {encoding: 'utf8'})
    .then(content => {
      const value = Number(content.trim());
      return isNaN(value) ? null : value;
    })
    .catch(err => err && err.code === 'ENOENT' ? undefined : null);
}

// the same file summed over every tx queue of a NIC. A port with no tx queue directory at all
// cannot count this. A port whose queues are there but cannot all be read this round has not
// counted fewer timeouts, it has no reading - and a sum short of a queue would be worse than
// none: the collector would take it for the counter dropping to that sum and add the whole
// difference back on the next round, inflating a counter the cloud reads. firecommit#11022
async function readQueueCounter(nic, name) {
  const entries = await fsp.readdir(`/sys/class/net/${nic}/queues`)
    .catch(err => err && err.code === 'ENOENT' ? undefined : null);
  if (!Array.isArray(entries))
    return entries;
  const queues = entries.filter(entry => entry.startsWith('tx-'));
  if (!queues.length)
    return undefined;
  let total = 0;
  for (const queue of queues) {
    const value = await readFileCounter(`/sys/class/net/${nic}/queues/${queue}/${name}`);
    // a queue that went away between the readdir and the read counts as a failed read, not as
    // a port that cannot count: the queues this NIC does have are still counting
    if (typeof value !== 'number')
      return null;
    total += value;
  }
  return total;
}

// What one round of collection needs off a NIC, read at most once and only when a rule actually
// asks for it: a wlan NIC only has link counters, forking ethtool at it every minute would be
// pure waste
function nicContext(nic) {
  const context = { nic };
  context.driver = () => {
    if (!context._driver)
      context._driver = getDriver(nic);
    return context._driver;
  };
  context.stats = () => {
    if (!context._stats)
      context._stats = execFile("ethtool", ["-S", nic])
        .then(result => parseEthtoolStats(result.stdout))
        .catch(() => null);
    return context._stats;
  };
  return context;
}

async function evaluate(context, rule) {
  if (rule.names) {
    const stats = await context.stats();
    // the fork can fail on its own, e.g. EAGAIN under memory pressure, and the NIC may be
    // mid-reset, so this round knows nothing about these counters
    return stats ? aggregate(rule, stats) : null;
  }
  if (rule.stat)
    return readFileCounter(`/sys/class/net/${context.nic}/statistics/${rule.stat}`);
  if (rule.path)
    return readFileCounter(`/sys/class/net/${context.nic}/${rule.path}`);
  if (rule.queues)
    return readQueueCounter(context.nic, rule.queues);
  return undefined;
}

// One counter of one NIC.
//   a number    what the port has counted since the driver last reset the counter
//   null        it could not be read this round, which says nothing about what the driver
//               supports. The caller must leave the stored total alone
//   undefined   this NIC cannot count it at all, which the caller stores as -1. A legacy
//               counter never answers this: it reads 0 where there is nothing to read, because
//               that is the 0 the cloud reads out of the checkin today
async function read(metric, context) {
  const value = await readRules(metric, context);
  return value === undefined && ETH_COUNTERS[metric].legacy ? 0 : value;
}

async function readRules(metric, context) {
  const rules = ETH_COUNTERS[metric].rules || [];
  if (rules.some(rule => rule.drivers)) {
    // without the driver there is no telling which rules apply, and a NIC that does support the
    // counter would look like one that does not
    const driver = await context.driver();
    if (!driver)
      return null;
    for (const rule of rules) {
      if (rule.drivers && !rule.drivers.includes(driver))
        continue;
      const value = await evaluate(context, rule);
      if (value !== undefined)
        return value;
    }
    return undefined;
  }
  for (const rule of rules) {
    const value = await evaluate(context, rule);
    if (value !== undefined)
      return value;
  }
  return undefined;
}

// whether a counter is kept for this NIC at all: the error and pause counters are about the
// box's own ethernet ports, the link counters are kept for every NIC the platform lists
function appliesTo(metric, isEthernet) {
  return ETH_COUNTERS[metric].scope === 'all' || isEthernet;
}

// What the app sees: the lifetime total minus what Reset Stats put aside for that port, see
// HostManager.resetNicCounters. A port that cannot count the metric keeps its -1, and a total
// that somehow sits below its own baseline reads 0 rather than a negative count
function sinceReset(total, baseline) {
  if (!(total >= 0))
    return total;
  const base = Number(baseline);
  if (baseline === undefined || baseline === null || isNaN(base))
    return total;
  return Math.max(total - base, 0);
}

module.exports = {
  ETH_COUNTERS,
  STATS_SINCE,
  appliesTo,
  nicContext,
  read,
  sinceReset,
  // exported for the tests, which feed captured `ethtool -S` outputs through them without
  // needing an actual NIC
  parseEthtoolStats,
  resolve,
  ruleFor,
};
