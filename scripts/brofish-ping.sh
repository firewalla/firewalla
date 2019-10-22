#!/bin/bash
# -----------------------------------------
# This is a watch dog function for bro.
# In case bro hangs, need to restart it.
# -----------------------------------------

TOTAL_RETRIES=5
SLEEP_TIMEOUT=10
CPU_THRESHOLD=99

# there should be updated logs in log file
MMIN="-10"

FILE=/blog/current/conn.log

brofish_ping() {
  RESULT=$(find $FILE -mmin ${MMIN} 2>/dev/null)
  if [[ -e $FILE && "x$RESULT" == "x" ]]; then
    return 1
  else
    return 0
  fi
}

brofish_cpu() {
  # Get CPU% from top
  RESULT=$(top -bn1 -p$(cat /blog/current/.pid) |grep bro|awk '{print $9}')

  if [[ ${RESULT%%.*} -ge $CPU_THRESHOLD ]]; then
    return 1
  else
    return 0
  fi
}

if brofish_ping; then
  /home/pi/firewalla/scripts/firelog -t cloud -m "brofish ping FAILED, restart brofish now"
  sudo systemctl restart brofish
  exit
fi

retry=1
ping_ok=0
while (($retry <= $TOTAL_RETRIES)); do
  if brofish_ping; then
    ping_ok=1
    break
  fi
  sleep $SLEEP_TIMEOUT
  ((retry++))
done

if [[ $ping_ok -ne 1 ]]; then
  /home/pi/firewalla/scripts/firelog -t cloud -m "brofish cpu too high, restart brofish now"
  sudo systemctl restart brofish
fi
