#!/bin/bash
# -----------------------------------------
# This is a watch dog function for bro.
# In case bro hangs, need to restart it.
# -----------------------------------------

shopt -s lastpipe

: ${FIREWALLA_HOME:='/home/pi/firewalla'}
source ${FIREWALLA_HOME}/platform/platform.sh

TOTAL_RETRIES=3
SLEEP_TIMEOUT=10
CPU_THRESHOLD=${FW_ZEEK_CPU_THRESHOLD:-80}

# there should be updated logs in log file
MMIN="-15"

FILE=/blog/current/conn.log

brofish_ping() {
  local RESULT=$(find $FILE -mmin ${MMIN} 2>/dev/null)
  if [[ ! -e $FILE || "x$RESULT" == "x" ]]; then
    return 1
  else
    return 0
  fi
}

brofish_cpu() {
  # Get CPU% from top
  top -bn1|grep $BRO_PROC_NAME|awk '{print $1 " " $9}'|
  while read PID CPU; do
    if [ ${CPU%%.*} -ge $CPU_THRESHOLD ]; then
      echo $CPU $(ps -p $PID -o args|grep $BRO_PROC_NAME)
      return 1
    fi
  done
  echo 'good'
  return 0
}

if brofish_ping; then
  exit
fi

retry=1
ping_ok=0
while (($retry <= $TOTAL_RETRIES)); do
  if brofish_ping && brofish_cpu; then
    ping_ok=1
    break
  fi
  sleep $SLEEP_TIMEOUT
  ((retry++))
done

if [[ $ping_ok -ne 1 ]]; then
  cpu=$(brofish_cpu)

  if [[ $cpu == 'good' ]]; then exit; fi

  /home/pi/firewalla/scripts/firelog -t cloud -m "brofish ping failed, restart brofish now, CPU $cpu"

  cd $FIREWALLA_HOME
  $FIREWALLA_HOME/bin/node scripts/diag_log.js \
    --data "{ \"msg\": \"brofish-ping failed\", \"broCPU\": ${cpu%% *} }"

  sudo systemctl restart brofish
fi
