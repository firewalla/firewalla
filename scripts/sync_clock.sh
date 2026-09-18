#!/bin/bash
#
# Set the system clock from HTTP Date headers, for a box whose clock is wrong enough that TLS
# fails. Supersedes the three near-identical copies that lived in fire-time.sh, sync_time.sh and
# firerouter_upgrade.sh.
#
# Trust model: several sources are queried in parallel with caching defeated, and the clock is
# moved only when at least QUORUM of them agree within SPREAD seconds. An HTTP Date is truncated
# to the second and is generated before it crosses the network, so even a healthy reading runs a
# couple of seconds behind the true time - TOLERANCE is what keeps that from being written back as
# a correction on every run.
#
# Env:
#   FW_CLOCK_SITES        sources to query
#   FW_CLOCK_QUORUM       agreeing sources required (3)
#   FW_CLOCK_SPREAD       seconds the agreeing cluster may span (5)
#   FW_CLOCK_TOLERANCE    leave the clock alone while it is within this many seconds (30)
#   FW_CLOCK_FLOOR        reject any source reading older than this date (2026-09-15)
#   FW_CLOCK_HWCLOCK_FILE last-known-good time, raises the floor (/data/fake-hwclock.data)
#   FW_CLOCK_RETRY        attempts; 0 retries until it succeeds (1)
#   FW_CLOCK_RETRY_WAIT   seconds between attempts (60)
#   FW_CLOCK_RESTART_NTP  restart the NTP daemon when it is not running (false)
#
# Exit: 0 the clock is trustworthy (already within tolerance, was set, or NTP owns it);
#       1 no trustworthy reading could be established.

set -u

: ${FIREWALLA_HOME:=/home/pi/firewalla}

SITES="${FW_CLOCK_SITES:-cloudflare.com live.com bing.com microsoft.com amazon.com google.com facebook.com time.gov time.is}"
QUORUM="${FW_CLOCK_QUORUM:-3}"
SPREAD="${FW_CLOCK_SPREAD:-5}"
TOLERANCE="${FW_CLOCK_TOLERANCE:-30}"
RETRY="${FW_CLOCK_RETRY:-1}"
RETRY_WAIT="${FW_CLOCK_RETRY_WAIT:-60}"
RESTART_NTP="${FW_CLOCK_RESTART_NTP:-false}"

log(){ logger -t sync_clock "$*"; echo "$*"; }

# platform.sh is what knows whether this box runs ntp or chrony; it is not written to be sourced
# under `set -u`, and the script still has to work standalone.
if [ -f "$FIREWALLA_HOME/platform/platform.sh" ]; then
  set +u
  . "$FIREWALLA_HOME/platform/platform.sh" >/dev/null 2>&1 || true
  set -u
fi
NTP_SVC="${NTP_SVC:-ntp}"
NTP_STRATUM=""

# Never accept a source reading older than the release floor, nor older than the last time
# fake-hwclock saved - a source behind the box's own last known good time is wrong, not early.
# Note this cuts both ways: if the clock was far ahead when fake-hwclock last saved, the floor
# inherits that error and every source is rejected until the saved file is refreshed.
floor_ts() {
  local base saved
  base=$(date -d "${FW_CLOCK_FLOOR:-2026-09-15}" +%s 2>/dev/null) || base=0
  # fake-hwclock writes UTC, so it has to be read as UTC
  saved=$(date -u -d "$(cat "${FW_CLOCK_HWCLOCK_FILE:-/data/fake-hwclock.data}" 2>/dev/null)" +%s 2>/dev/null) || saved=0
  if [ "$saved" -gt "$base" ] 2>/dev/null; then base=$saved; fi
  echo "$base"
}

# The NTP daemon is configured with a local refclock at stratum 10 (ntp) / "local stratum 10"
# (chrony) so it keeps answering clients when no upstream is reachable. That makes every "are you
# synchronized" check true, so stratum is the only usable signal: a real upstream puts this box
# below 10, the local fallback sits at 10-11, and an unsynchronized daemon reports 16.
ntp_upstream_synced() {
  if [ "$NTP_SVC" = "chrony" ]; then
    NTP_STRATUM=$(chronyc -c tracking 2>/dev/null | cut -d, -f3)
  else
    NTP_STRATUM=$(ntpq -c "rv 0 stratum" 2>/dev/null | sed -n 's/.*stratum=\([0-9][0-9]*\).*/\1/p')
  fi
  [ -n "$NTP_STRATUM" ] && [ "$NTP_STRATUM" -lt 10 ] 2>/dev/null
}

# A dead daemon is a real problem on its own, and ntpd -gq / ntpdate step in either direction
# against a proper time source, which is a better correction than anything below can make.
ensure_ntp_running() {
  systemctl is-active --quiet "$NTP_SVC" && return 0
  log "$NTP_SVC not running, restarting"
  sudo systemctl stop "$NTP_SVC"
  if [ "$NTP_SVC" = "chrony" ]; then
    sudo timeout 30 chronyd -q "pool time.nist.gov iburst"
  else
    sudo timeout 30 ntpd -gq || sudo ntpdate -b -u -s time.nist.gov
  fi
  sudo systemctl start "$NTP_SVC"
}

attempt() {
  local tmp site d ts floor total n i j cnt sum best_n best_ts now diff
  local votes=() sorted=()
  floor=$(floor_ts)

  tmp=$(mktemp -d) || return 1
  for site in $SITES; do
    ( curl -ILsm5 -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' "$site" 2>/dev/null \
        | awk -F': ' '/^[Dd]ate: /{print $2}' | tail -1 > "$tmp/$site" ) &
  done
  wait
  for site in $SITES; do
    d=$(cat "$tmp/$site" 2>/dev/null)
    [ -z "$d" ] && continue
    ts=$(date -d "$d" +%s 2>/dev/null) || continue
    [ "$ts" -lt "$floor" ] && continue
    votes+=("$ts")
  done
  rm -rf "$tmp"

  total=$(echo $SITES | wc -w)
  if [ "${#votes[@]}" -lt "$QUORUM" ]; then
    log "only ${#votes[@]} of $total sources usable (required $QUORUM), clock untouched"
    return 1
  fi

  sorted=($(printf '%s\n' "${votes[@]}" | sort -n))
  n=${#sorted[@]}
  best_n=0
  best_ts=0
  for ((i = 0; i < n; i++)); do
    cnt=0
    sum=0
    for ((j = i; j < n; j++)); do
      [ $(( sorted[j] - sorted[i] )) -gt "$SPREAD" ] && break
      cnt=$(( cnt + 1 ))
      sum=$(( sum + sorted[j] ))
    done
    if [ "$cnt" -gt "$best_n" ]; then
      best_n=$cnt
      best_ts=$(( sum / cnt ))
    fi
  done

  if [ "$best_n" -lt "$QUORUM" ]; then
    log "no quorum: largest cluster is $best_n of $n within ${SPREAD}s (${sorted[*]}), clock untouched"
    return 1
  fi

  now=$(date +%s)
  diff=$(( best_ts - now ))
  if [ "${diff#-}" -le "$TOLERANCE" ]; then
    log "clock ok, ${diff}s off $best_n agreeing sources"
    return 0
  fi

  if ! sudo date +%s -s "@$best_ts" >/dev/null; then
    log "failed to set clock to $best_ts"
    return 1
  fi
  log "clock moved ${diff}s to $(date -Is) on $best_n agreeing sources"
  return 0
}

case "$RESTART_NTP" in
  true|yes|1) ensure_ntp_running ;;
esac

tries=0
while :; do
  tries=$(( tries + 1 ))
  # re-checked every round: on a slow boot the daemon may reach an upstream while we are retrying,
  # and once it has one it is a far better source than any HTTP header
  if ntp_upstream_synced; then
    log "$NTP_SVC synced upstream at stratum $NTP_STRATUM, leaving the clock to it"
    exit 0
  fi
  attempt && exit 0
  if [ "$RETRY" -ne 0 ] && [ "$tries" -ge "$RETRY" ]; then
    log "no trustworthy time after $tries attempt(s)"
    exit 1
  fi
  sleep "$RETRY_WAIT"
done
