#!/bin/bash

# shared by apt-get.sh and the apt cron scripts, sourced

# keeps the lists on /log compressed; apt reads them either way
APT_UPDATE_OPTS="-o Acquire::GzipIndexes=true"

apt_cleanup() {
  sudo apt clean
  # another apt (the app's apt-get, system-updates) still holds the lists lock: removing its
  # files, lock included, would let a second apt run next to it
  sudo fuser -s /var/lib/apt/lists/lock 2>/dev/null && return 0
  sudo rm -rf /log/apt/lib/lists/*
}

APT_STAMP_DIR=/data/apt_stamps

# a stamp holds the epoch the job is next due; missing, unreadable or more than one
# interval ahead (the clock was ahead when it was written) means due now
apt_due() {
  local due now=$(date +%s)
  due=$(cat "$APT_STAMP_DIR/$1" 2>/dev/null) && (( due > now && due <= now + $2 )) && return 1
  return 0
}

apt_defer() {
  sudo mkdir -p "$APT_STAMP_DIR" && echo $(( $(date +%s) + $2 )) | sudo tee "$APT_STAMP_DIR/$1" >/dev/null
}

# one lock for all apt jobs, held until the script exits, so one job's cleanup can't remove the
# lists under another's apt; locks the stamp dir, which no upgrade replaces and both root and
# pi can open. /data unavailable: runs unlocked, as the stamps fail open
apt_lock() {
  sudo mkdir -p "$APT_STAMP_DIR" && exec {APT_LOCK_FD}<"$APT_STAMP_DIR" || return 0
  flock -n $APT_LOCK_FD
}
