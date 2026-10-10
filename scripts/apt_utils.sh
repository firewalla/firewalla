#!/bin/bash

# shared by the apt cron scripts, sourced

apt_cleanup() {
  sudo apt clean
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
