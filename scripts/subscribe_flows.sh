#!/bin/bash

# subscribe_flows.sh
# Usage:
#   ./subscribe_flows.sh -o /home/pi/bak/flows
#   ./subscribe_flows.sh -o /home/pi/bak/flows -m "6C:1F:F7:23:39:CB,00:1A:7D:DA:71:13"
#   ./subscribe_flows.sh -o /home/pi/bak/flows --debug
#   nohup ./subscribe_flows.sh -t -o /home/pi/bak/flows-0819 -m "6C:1F:F7:23:39:CB,00:1A:7D:DA:71:13" > /tmp/subscribe_flows.log 2>&1 &
#   nohup ./subscribe_flows.sh -t -o /home/pi/bak/flows-0819 -m "5E:39:71:B9:3B:B8,2C:CA:16:61:8E:27,52:32:59:38:B0:B5,C4:35:D9:98:3F:13,0E:0F:B6:05:F8:A9" > /tmp/subscribe_flows.log 2>&1 &
#

output_dir=""
allowed_macs=""
debug=false
add_timestamp=false
target_time=""

# ====================== parse arguments ======================
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output-dir)
      output_dir="$2"
      shift 2
      ;;
    -m|--allowed-macs)
      allowed_macs="$2"
      shift 2
      ;;
    -d|--debug)
      debug=true
      shift
      ;;
    -t|--add-timestamp)
      add_timestamp=true
      shift
      ;;
    -T|--target-time)
      target_time="$2"
      shift 2
      ;;
    *)
      echo "Usage: $0 -o <output_dir> [-t] [-m <mac1,mac2,...>] [--debug] [-T <target_time>(HH:MM)]" >&2
      exit 1
      ;;
  esac
done

log() {
  local level="$1"
  shift
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*" >&2
}

log_debug() {
  if [ "$debug" = true ]; then
    log "DEBUG" "$@"
  fi
}

# ====================== check target time ======================
check_target_time() {
  if [ -z "$target_time" ]; then
    return
  fi
 
  local current_time=$(date +%H:%M:%S)
  local current_date=$(date +%Y-%m-%d)
  local current_epoch=$(date +%s)
 
  local target_epoch=$(date -d "$current_date $target_time" +%s 2>/dev/null)
  if [ $? -ne 0 ]; then
    log "ERROR" "Failed to parse target time: $current_date $target_time"
    return 1
  fi
 
  if [[ "$current_time" > "$target_time" ]]; then
    log "INFO" "Current time ($current_time) > target time ($target_time), skipping wait."
    return 0
  fi
  local sleep_seconds=$((target_epoch - current_epoch))
  if [ $sleep_seconds -le 0 ]; then
    log "WARN" "Calculated sleep time is non-positive ($sleep_seconds seconds), skipping wait."
    return 0
  fi
 
  local wait_time=$(date -u -d "@$sleep_seconds" +%H:%M:%S)
  log "INFO" "Waiting $wait_time until $target_time (local time)..."

  sleep $sleep_seconds
  log "INFO" "Reached target time: $target_time, continuing execution."
}

check_target_time

# ====================== check arguments ======================
if [ -z "$output_dir" ]; then
  echo "Error: -o/--output-dir is required." >&2
  echo "Usage: $0 -o <output_dir> [-t] [-m <mac1,mac2,...>] [--debug]" >&2
  exit 1
fi

# ====================== open and close flow switch ======================
open_flow_switch() {
  curl -X POST --header 'Content-Type: application/json' \
  --header 'Accept: application/json' -d \
  '{ "featureName": "record_activity_flow" }' \
  'http://127.0.0.1:8834/v1/encipher/simple?command=cmd&item=enableFeature&target=0.0.0.0' | jq . > /dev/null 2>&1
}

close_flow_switch() {
  curl -X POST --header 'Content-Type: application/json' \
  --header 'Accept: application/json' -d \
  '{ "featureName": "record_activity_flow" }' \
  'http://127.0.0.1:8834/v1/encipher/simple?command=cmd&item=disableFeature&target=0.0.0.0' | jq . > /dev/null 2>&1
}

open_flow_switch

# ====================== single instance lock ======================
LOCKFILE="/tmp/subscribe_flows.lock"
if [ -f "$LOCKFILE" ]; then
  echo "Error: script is already running (PID $(cat "$LOCKFILE")). Exiting." >&2
  exit 1
fi
echo $$ > "$LOCKFILE"

# ====================== trap handler ======================
trap_handler() {
    log "INFO" "will exit..."
    local exit_status=$?
    close_flow_switch 2>/dev/null || true
    rm -f "$LOCKFILE" 2>/dev/null  || true
    exit $exit_status
}
trap trap_handler INT TERM EXIT

# ====================== initialize ======================
mkdir -p "$output_dir"
rm -rf "$output_dir"/*

# ====================== initialize MAC filter list ======================
if [ -n "$allowed_macs" ]; then
  IFS=',' read -ra mac_array <<< "$allowed_macs"
  log_debug "Allowed MACs: ${allowed_macs}"
else
  log_debug "Allowed MACs: none (allow all)"
fi

# ====================== main loop ======================
while true; do
  log "INFO" "Subscribing to Redis channel 'internet.activity.flow'..."

  redis-cli --raw subscribe internet.activity.flow 2>/dev/null | while read -r line; do
    if [[ "$line" == "message" ]]; then
      read -r channel
      read -r msg

      # clean JSON format (handle escaped quotes)
      clean_json=$(echo "$msg" | sed 's/\\"/"/g')
      
      # extract MAC address
      current_mac=$(echo "$clean_json" | jq -r '.flow.mac // empty')

      # MAC filter check
      if [ -n "$allowed_macs" ]; then
        match=0
        for mac in "${mac_array[@]}"; do
          if [[ "$current_mac" == "$mac" ]]; then
            match=1
            break
          fi
        done
        if [[ $match -eq 0 ]]; then
          log_debug "Skipped MAC (not allowed): ${current_mac:-"N/A"}"
          continue
        fi
      fi

      # generate filename (replace colons with underscores in MAC address)
      if [ -z "$current_mac" ]; then
        filename="flows"
      else
        filename=$(echo "$current_mac" | sed 's/:/_/g')
      fi

      if [ "$add_timestamp" = true ]; then
        timestamp=$(date +%Y%m%d)
        filename="${filename}-${timestamp}"
      fi

      # write to file (append mode)
      echo "$clean_json" >> "$output_dir/$filename.json"
      log_debug "Recorded flow for MAC: ${current_mac:-"N/A"}"
    fi
  done

  log "WARN" "Redis connection lost, retrying in 2 seconds..."
  sleep 2
done