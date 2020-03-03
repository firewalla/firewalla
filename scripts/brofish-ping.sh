#!/bin/bash
# -----------------------------------------
# This is a watch dog function for bro.
# In case bro hangs, need to restart it.
# -----------------------------------------

: ${FIREWALLA_HOME:='/home/pi/firewalla'}
source ${FIREWALLA_HOME}/platform/platform.sh

TOTAL_RETRIES=3
SLEEP_TIMEOUT=10
CPU_THRESHOLD=80

# there should be updated logs in log file
MMIN="-15"

FILE=/blog/current/conn.log

brofish_ping() {
  RESULT=$(find $FILE -mmin ${MMIN} 2>/dev/null)
  if [[ ! -e $FILE || "x$RESULT" == "x" ]]; then
    return 1
  else
    return 0
  fi
}

brofish_cpu() {
  # Get CPU% from top
  RESULT=$(top -bn1 -p$(cat /blog/current/.pid) |grep $(bro_proc_name)|awk '{print $9}')

  if [[ ${RESULT%%.*} -ge $CPU_THRESHOLD ]]; then
    return ${RESULT%%.*}
  else
    return 0
  fi
}

if brofish_ping; then
  exit
fi

retry=1
ping_ok=0
while (($retry <= $TOTAL_RETRIES)); do
  if brofish_ping; then
    if brofish_cpu; then
      ping_ok=1
      break
    fi
  fi
  sleep $SLEEP_TIMEOUT
  ((retry++))
done

if [[ $ping_ok -ne 1 ]]; then
  cpu=$(brofish_cpu)

  /home/pi/firewalla/scripts/firelog -t cloud -m "brofish ping failed, cpu $cpu, restart brofish now"

  cd $FIREWALLA_HOME
  $FIREWALLA_HOME/bin/node scripts/diag_log.js \
    --data '{ "msg": "brofish-ping failed", "broCPU": '"$cpu"' }'

  sudo systemctl restart brofish
fi
