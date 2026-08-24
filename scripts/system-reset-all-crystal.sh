#!/bin/bash
# Factory reset for Crystal
set -u

HOME_RW=/media/home-rw
FIREWALLA_HOME=/home/pi/firewalla
: ${FIREWALLA_POST_RESET_OP:='reboot'}
: ${FIREWALLA_RESET_DELAY:=10}

TRACE=/data/fw-reset.log
log(){
  local m="[fw-reset $(date -Is 2>/dev/null || date)] $*"
  logger -t fw-reset -- "$*"
  echo "$m"
  echo "$m" | sudo tee -a "$TRACE" >/dev/null 2>&1 || true
}

check_layout(){
  local d
  for d in "$HOME_RW/overlay" "$HOME_RW/overlay-work"; do
    [ -d "$d" ] || { log "ERROR $d is missing, this is not a Crystal overlay layout"; return 1; }
  done
  grep -q " $HOME_RW " /proc/mounts || { log "ERROR $HOME_RW is not mounted"; return 1; }
  return 0
}

if [ "${1:-}" = "--check" ]; then
  check_layout
  exit $?
fi

SELF=$(readlink -f "$0")
RUNNER="/dev/shm/.$(basename "$SELF")"
if [[ "$SELF" != /dev/shm/* ]]; then
  cp -f "$SELF" "$RUNNER" || { log "ERROR failed to stage $RUNNER"; exit 1; }
  chmod 755 "$RUNNER"
  exec env FIREWALLA_POST_RESET_OP="$FIREWALLA_POST_RESET_OP" \
           FIREWALLA_RESET_DELAY="$FIREWALLA_RESET_DELAY" "$RUNNER"
fi

check_layout || exit 1

log "reset scheduled, wiping in ${FIREWALLA_RESET_DELAY}s, post op $FIREWALLA_POST_RESET_OP"
sleep "$FIREWALLA_RESET_DELAY"

timeout 60 $FIREWALLA_HOME/scripts/store_support.sh || log "store_support failed, continuing"
timeout 60 $FIREWALLA_HOME/scripts/fire-stop || log "fire-stop failed, continuing"

redis-cli flushall || log "redis flushall failed, continuing"
sudo systemctl stop redis-server
sudo rm -f /data/redis/dump.rdb

sudo rm -fr /log/{system,blog,firewalla,redis,forever}/*

sudo rm -fr "$HOME_RW/overlay.bak" "$HOME_RW/overlay-work.bak"
sudo mv "$HOME_RW/overlay" "$HOME_RW/overlay.bak" || { log "ERROR failed to rename overlay"; exit 1; }
sudo mv "$HOME_RW/overlay-work" "$HOME_RW/overlay-work.bak" || log "failed to rename overlay-work"
sudo mkdir -p "$HOME_RW/overlay" "$HOME_RW/overlay-work"
sudo chmod 755 "$HOME_RW/overlay" "$HOME_RW/overlay-work"

sync
sync
log "wipe done, $FIREWALLA_POST_RESET_OP now"

if [[ $FIREWALLA_POST_RESET_OP == 'shutdown' ]]; then
  logger "SHUTDOWN: factory reset"
  sudo /sbin/shutdown -h now
else
  logger "REBOOT: factory reset"
  sudo /sbin/reboot
fi
