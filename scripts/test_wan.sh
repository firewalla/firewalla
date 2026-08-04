#!/usr/bin/env bash
#
# Usage:
#   sudo ./test_wan.sh <wan_name> <command...>
#
# Examples:
#   sudo ./test_wan.sh vpn_d7 curl -s -m 5 -o /dev/null -I -w '%{http_code}\n' https://1.1.1.1
#
# WAN_NAME can be:
#   - wan
#   - vpn client name (e.g. vpn_d7)
#   - virtual wan group uuid 10-char prefix
#
: "${FIREWALLA_HOME:=/home/pi/firewalla}"

set -u

source "${FIREWALLA_HOME}/platform/platform.sh"

if [ $# -lt 2 ]; then
  echo "Usage: sudo $0 <wan_name> <command...>"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)."
  exit 1
fi

WAN_NAME="$1"
shift
CMD="$*"

get_mark() {
  local wan="$1"
  local mark=""

  mark=$(ip rule list | grep fwmark | grep -w "vpn_client_${wan}" | grep -vw "iif lo" | awk '{print $5}' | awk -F/ '{print $1}')
  if [ -z "$mark" ]; then
    mark=$(ip rule list | grep fwmark | grep -w "vwg_${wan}" | grep -vw "iif lo" | awk '{print $5}' | awk -F/ '{print $1}')
  fi
  if [ -z "$mark" ]; then
    mark=$(ip rule list | grep fwmark | grep -w "lookup ${wan}_default" | grep -vw "iif lo" | awk '{print $5}' | awk -F/ '{print $1}')
  fi

  echo "$mark"
}

MARK="$(get_mark "$WAN_NAME")"
if [ -z "$MARK" ]; then
  echo "invalid WAN: $WAN_NAME"
  exit 2
fi

KMAJOR="$(uname -r | cut -d. -f1)"

# globals for cleanup
CGROUP_MNT=""
RULE_ADDED=0
USE_FALLBACK=0
CLASSID=""
IPTABLES_RULE=()

cleanup() {
  # fallback cleanup
  if [ "$RULE_ADDED" -eq 1 ] && [ ${#IPTABLES_RULE[@]} -gt 0 ]; then
    iptables -t mangle -D OUTPUT "${IPTABLES_RULE[@]}" >/dev/null 2>&1 || true
  fi

  # modern path cleanup
  if [ "$USE_FALLBACK" -eq 0 ] && [ -n "$CGROUP_MNT" ] && [ -n "${CGROUP_SOCK_MARK:-}" ] && [ -x "${CGROUP_SOCK_MARK:-/nonexistent}" ]; then
    "${CGROUP_SOCK_MARK}" -d "${CGROUP_MNT}" >/dev/null 2>&1 || true
  fi

  if [ -n "$CGROUP_MNT" ]; then
    rmdir "${CGROUP_MNT}" >/dev/null 2>&1 || true
  fi
}

trap 'cleanup; exit 1' INT TERM
trap 'cleanup' EXIT

run_modern() {
  # cgroup v2 + CGROUP_SOCK_MARK path
  CGROUP_MNT="/sys/fs/cgroup/cgroup-test-wan-${WAN_NAME}-${RANDOM}"
  mkdir -p "${CGROUP_MNT}" || return 3
  "${CGROUP_SOCK_MARK}" -m "${MARK}" "${CGROUP_MNT}" || return 4

  bash -c "echo \$\$ > '${CGROUP_MNT}/cgroup.procs'; ${CMD}"
  return $?
}

find_netcls_mount() {
  if [ -d /sys/fs/cgroup/net_cls ]; then
    echo "/sys/fs/cgroup/net_cls"
    return 0
  fi
  if [ -d /sys/fs/cgroup/net_cls,net_prio ]; then
    echo "/sys/fs/cgroup/net_cls,net_prio"
    return 0
  fi
  return 1
}

gen_classid() {
  # 0xAAAABBBB, avoid 0
  local hi lo
  hi=$(( (RANDOM % 65534) + 1 ))
  lo=$(( (RANDOM % 65534) + 1 ))
  printf "0x%04x%04x" "$hi" "$lo"
}

run_fallback_kernel4() {
  USE_FALLBACK=1

  local netcls_root
  netcls_root="$(find_netcls_mount)" || {
    echo "net_cls cgroup is not available. Please mount net_cls cgroup first."
    return 5
  }

  # iptables cgroup match check
  iptables -m cgroup -h >/dev/null 2>&1 || {
    echo "iptables cgroup match is not available (xt_cgroup missing)."
    return 6
  }

  CLASSID="$(gen_classid)"
  CGROUP_MNT="${netcls_root}/cgroup-test-wan-${WAN_NAME}-${RANDOM}"

  mkdir -p "${CGROUP_MNT}" || return 3
  echo "${CLASSID}" > "${CGROUP_MNT}/net_cls.classid" || return 4

  # Match this classid and set fwmark for policy routing
  IPTABLES_RULE=(-m cgroup --cgroup "${CLASSID}" -j MARK --set-mark "${MARK}")
  iptables -t mangle -A OUTPUT "${IPTABLES_RULE[@]}" || return 4
  RULE_ADDED=1

  # Put the shell that runs CMD into net_cls cgroup
  bash -c "echo \$\$ > '${CGROUP_MNT}/tasks'; ${CMD}"
  return $?
}

# Decision:
# - kernel < 5 : fallback first
# - kernel >=5 : prefer modern path if CGROUP_SOCK_MARK exists, else fallback
RET=1
if [ "${KMAJOR}" -lt 5 ]; then
  run_fallback_kernel4
  RET=$?
else
  if [ -n "${CGROUP_SOCK_MARK:-}" ] && [ -x "${CGROUP_SOCK_MARK:-/nonexistent}" ]; then
    run_modern
    RET=$?
  else
    run_fallback_kernel4
    RET=$?
  fi
fi

exit "$RET"
