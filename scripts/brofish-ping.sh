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

# there should be updated logs in log file
MMIN="-15"

FILE=/blog/current/conn.log

brofish_ping() {
  local RESULT=$(find $FILE -mmin ${MMIN} 2>/dev/null)
  if [[ -e $FILE && -n "$RESULT" ]]; then
    return 0
  else
    return 1
  fi
}

brofish_cmd() {
  brofish_pid=$(pidof ${BRO_PROC_NAME})
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
  # there may be multiple bro/zeek processes, need to find out the max rss 
  brss=$(ps -eo rss,cmd | awk "\$2~/${BRO_PROC_NAME}\$/ {print \$1}" | sort -k 1 -rn | head -n 1)
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



ping_ok=false
brocpu=
brorss=
for ((retry=0; retry<$TOTAL_RETRIES; retry++)); do
  brocpu=$(brofish_cpu) && brocpu_ok=true || brocpu_ok=false
  brorss=$(brofish_rss) && brorss_ok=true || brorss_ok=false
  if brofish_ping && $brocpu_ok && $brorss_ok; then
    ping_ok=true
    break
  fi
  sleep $SLEEP_TIMEOUT
done

$ping_ok || {

  /home/pi/firewalla/scripts/firelog -t cloud -m "brofish ping failed, restart brofish now"

  ( cd $FIREWALLA_HOME
    msg=$(cat <<EOM
    { "msg": "brofish-ping failed", "broCPU": ${brocpu}, "broRSS": ${brorss} }
EOM
    )
    bin/node scripts/diag_log.js --data "$msg"
  )
  sudo systemctl restart brofish
}
