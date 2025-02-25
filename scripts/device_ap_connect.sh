#!/bin/bash

TS_WIDTH=22
AP_WIDTH=22

local_fwapc_get () {
    curl -s -H 'Content-Type: application/json' -XGET http://127.0.0.1:8841/$1
}

lase () {
    local_fwapc_get "v1/event_history/$1?format=text" | jq -r '.[]'
}

hdr() {
  printf "%-${TS_WIDTH}s" TS/$mac
  for ap in $aps
  do
    printf "%${AP_WIDTH}s" "$(echo $ap | sed -e 's/2[0-9]:6D:31://g')"
  done
  echo
}

pad() {
  width=$(( $(echo $aps|wc -w) * AP_WIDTH + TS_WIDTH ))
  printf '%*s\n' $width "" | tr ' ' '-'
}

displaytime() {
    ${FORMAT_TIME:-true} || {
        echo "$1"
        return 0
    }
    local T=$1
    local D=$((T/60/60/24))
    local H=$((T/60/60%24))
    local M=$((T/60%60))
    local S=$((T%60))
    (( D > 0 )) && printf '%02dd' $D
    (( H > 0 )) && printf '%02dh' $H
    (( D == 0 )) && {
      (( M > 0 )) && printf '%02dm' $M
      (( H == 0 )) && printf '%02ds\n' $S
    }
}

record() {
  hdr; pad
  declare -a conns
  conns=()
  while read ts device dev_mac conn to SSID ssid on AP ap_mac rest
  do
    ts=${ts//[\[\]]}
    printf "%-${TS_WIDTH}s" $ts
    i=0
    for ap in $aps; do
      if [[ $ap == $ap_mac ]]; then
        case $conn in
          connected) conns[$i]=$ts ;;
          disconnected)
            if [[ -n "${conns[$i]}" ]]; then
              tof=$(( $(date -u +%s -d $ts)  - $(date -u +%s -d ${conns[$i]}) ))
              conn="$conn($(displaytime $tof))"
            fi
            ;;
        esac
        printf "%${AP_WIDTH}s" $conn
      else
        printf "%${AP_WIDTH}s" '-'
      fi
      let i++
    done
    echo
  done
  pad;hdr
}

if [[ $# -gt 0 ]]; then
  mac=$1
else
  read -p "Please provide Device MAC:" mac
fi
if [[ -t 0 ]]; then
  input=$(lase $mac | tac| fgrep connected)
else
  input=$(cat|fgrep connected)
fi
aps=$(echo "$input"|awk '{print $10}'|sort -u)
echo "$input" | record
aps=$(echo "$input"|awk '{print $10}'|sort -u)
