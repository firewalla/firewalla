#!/bin/bash
set -u
set -o pipefail

HOME_RW=/media/home-rw
FIREWALLA_HOME=/home/pi/firewalla
: ${FIREWALLA_POST_RESET_OP:='reboot'}
: ${FIREWALLA_RESET_DELAY:=10}

TRACE=/data/fw-reset.log
WIPE_ERR=0
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

redis-cli flushall || log "ERROR redis flushall failed"
sudo systemctl stop redis-server || log "systemctl stop redis-server failed"
for i in 1 2 3 4 5; do
  redis-cli ping >/dev/null 2>&1 || break
  sleep 1
done
if redis-cli ping >/dev/null 2>&1; then
  log "redis still up after stop, killing it"
  sudo pkill -9 -x redis-server
  sleep 1
fi
if redis-cli ping >/dev/null 2>&1; then
  log "ERROR redis could not be stopped, its database may survive the reset"
  WIPE_ERR=1
else
  sudo rm -f /data/redis/dump.rdb || { log "ERROR failed to remove dump.rdb"; WIPE_ERR=1; }
fi

sudo rm -fr /log/{system,blog,firewalla,redis,forever}/* || log "log cleanup incomplete"

sudo rm -fr "$HOME_RW/overlay.bak" "$HOME_RW/overlay-work.bak"
sudo mv "$HOME_RW/overlay" "$HOME_RW/overlay.bak" || { log "ERROR failed to rename overlay, nothing wiped"; exit 1; }
if ! sudo mv "$HOME_RW/overlay-work" "$HOME_RW/overlay-work.bak"; then
  log "failed to rename overlay-work, clearing it in place"
  sudo rm -fr "$HOME_RW/overlay-work"/* "$HOME_RW/overlay-work"/.[!.]* 2>/dev/null
fi
sudo mkdir -p "$HOME_RW/overlay" "$HOME_RW/overlay-work" || { log "ERROR failed to recreate overlay dirs"; WIPE_ERR=1; }
sudo chmod 755 "$HOME_RW/overlay" "$HOME_RW/overlay-work" || { log "ERROR failed to chmod overlay dirs"; WIPE_ERR=1; }

[ -d "$HOME_RW/overlay.bak" ] || { log "ERROR overlay.bak is missing after rename"; WIPE_ERR=1; }
[ -z "$(sudo ls -A "$HOME_RW/overlay" 2>/dev/null)" ] || { log "ERROR new overlay is not empty"; WIPE_ERR=1; }
[ -z "$(sudo ls -A "$HOME_RW/overlay-work" 2>/dev/null)" ] || { log "ERROR new overlay-work is not empty"; WIPE_ERR=1; }

sync
sync
if [ "$WIPE_ERR" = "0" ]; then
  log "wipe done, $FIREWALLA_POST_RESET_OP now"
else
  log "wipe COMPLETED WITH ERRORS (see above), $FIREWALLA_POST_RESET_OP now"
fi

if [[ $FIREWALLA_POST_RESET_OP == 'shutdown' ]]; then
  logger "SHUTDOWN: factory reset"
  sudo /sbin/shutdown -h now
else
  logger "REBOOT: factory reset"
  sudo /sbin/reboot
fi
