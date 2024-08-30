#!/bin/bash
# -----------------------------------------
# This is a watch dog function for bro.
# In case bro hangs, need to restart it.
# -----------------------------------------

: ${FIREWALLA_HOME:='/home/pi/firewalla'}
source ${FIREWALLA_HOME}/platform/platform.sh

TOTAL_RETRIES=10
SLEEP_TIMEOUT=3
CPU_THRESHOLD=${FW_ZEEK_CPU_THRESHOLD:-80}
RSS_THRESHOLD=${FW_ZEEK_RSS_THRESHOLD:-800000}
NOT_AVAILABLE='n/a'
FREEMEM_THRESHOLD=${FREEMEM_THRESHOLD:-60}

MMIN="15"

brofish_hb() {
  # zeek logs get rotated every 3 mins, checking archive folder as well here
  local RESULT=$(find /log/blog -follow -name 'heartbeat.*' -mmin -${MMIN} 2>/dev/null)
  if [[ -n "$RESULT" ]]; then
    return 0
  else
    /home/pi/firewalla/scripts/firelog -t cloud -m "brofish no heartbeat in last ${MMIN} minutes"
    return 1
  fi
}

brofish_cmd() {
  brofish_pid=$(pidof ${BRO_PROC_NAME} |awk '{print $1}')
  if [[ -n "$brofish_pid" ]]; then
    ps -p $brofish_pid -o cmd=
  else
    echo "$BRO_PROC_NAME not running"
  fi
}

brofish_cpu() {
  bcpu=$(top -bn1 | awk "\$12==\"$BRO_PROC_NAME\" {print \$9}" | sort -rn | head -n 1)
  if [[ -n "$bcpu" ]]; then
    echo $bcpu
    if [[ ${bcpu%%.*} -ge $CPU_THRESHOLD ]]; then
      /home/pi/firewalla/scripts/firelog -t cloud -m "brofish CPU%($bcpu) is over threshold($CPU_THRESHOLD): $(brofish_cmd)"
      return 1
    else
      return 0
    fi
  else
    /home/pi/firewalla/scripts/firelog -t cloud -m "cannot get brofish CPU%"
    echo $NOT_AVAILABLE
    return 1
  fi
}

get_free_memory() {
  swapmem=$(free -m | awk '/Swap:/{print $4}')
  realmem=$(free -m | awk '/Mem:/{print $7}')
  totalmem=$(( swapmem + realmem ))

  if [[ -n "$swapmem" && $swapmem -gt 0 ]]; then
    mem=$totalmem
  else
    mem=$realmem
  fi

  echo $mem
}

brofish_rss() {
  # Given heap is the most dynamic space taker in bro/zeek process,
  # we use it(Pss instead of whole Size for real memory) as benchmark for bro/zeek process memory consumption
  # And there may be multiple bro/zeek processes, so we need to sum up all values.
  brss=$(ps -eo pid,cmd |\
         awk "\$2~/${BRO_PROC_NAME}\$/ {print \$1}" |\
         xargs -I pid sudo grep -A7 heap /proc/pid/smaps |\
         awk '/Pss:/ {t+=$2} END{print t;}')
  if [[ -n "$brss" ]]; then
    echo $brss
    mem=$(get_free_memory)
    if [[ $brss -ge $RSS_THRESHOLD && $mem -le $FREEMEM_THRESHOLD ]]; then
      /home/pi/firewalla/scripts/firelog -t cloud -m "abnormal brofish RSS($brss >= $RSS_THRESHOLD) and free memory($mem <= $FREEMEM_THRESHOLD): $(brofish_cmd)"
      return 1
    else
      return 0
    fi
  else
    /home/pi/firewalla/scripts/firelog -t cloud -m "cannot get brofish RSS"
    echo $NOT_AVAILABLE
    return 1
  fi
}

brofish_worker_alive() {
  output=$(sudo /usr/local/${BRO_PROC_NAME}/bin/${BRO_PROC_NAME}ctl top 2>/dev/null | grep -w worker)
  while IFS= read -r line; do
    pid=$(echo "$line" | awk '{print $4}')
    if ! [[ $pid =~ ^[0-9]+$ ]]; then
      id=$(echo "$line" | awk '{print $1}')
      intf=$(cat /usr/local/${BRO_PROC_NAME}/etc/node.cfg | grep -F "[${id}]" -A 4 | awk '/interface=/' | awk -F= '{print $2}')
      if [[ -n "$intf" && -e /sys/class/net/${intf} ]]; then
        /home/pi/firewalla/scripts/firelog -t cloud -m "${BRO_PROC_NAME} worker on ${intf} is not running, will restart brofish ..."
        return 1
      fi
    fi
  done <<< "$output"
  return 0
}

ping_ok=true
result_hb="OK"
result_cpu="OK"
result_rss="OK"
result_worker="OK"
for ((retry=0; retry<$TOTAL_RETRIES; retry++)); do
  ping_ok=true
  brofish_hb && result_hb="OK" || { ping_ok=false; result_hb="fail"; }
  brofish_cpu && result_cpu="OK" || { ping_ok=false; result_cpu="fail"; }
  brofish_rss && result_rss="OK" || { ping_ok=false; result_rss="fail"; }
  brofish_worker_alive && result_worker="OK" || { ping_ok=false; result_worker="fail"; }
  $ping_ok && break
  [[ $result_worker == "OK" ]] || break
  sleep $SLEEP_TIMEOUT
done

$ping_ok || {
  /home/pi/firewalla/scripts/firelog -t cloud -m "brofish ping failed(HB:$result_hb, CPU:$result_cpu, RSS:$result_rss, Worker:$result_worker), restart brofish now"
#  sudo pkill -x ${BRO_PROC_NAME} # directly kill bro to speed up the process, also for memory saving
  sudo systemctl restart brofish
}
