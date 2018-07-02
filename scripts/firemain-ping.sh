#!/bin/bash
# -----------------------------------------
# This is a watch dog function for firemain.
# In case firemain hangs, need to restart it.
# -----------------------------------------

TOTAL_RETRIES=3
SLEEP_TIMEOUT=10

# there should be updated logs in log file
MMIN="-10"

FILE=/dev/shm/main.touch

firemain_ping() {
	RESULT=$(find $FILE -mmin ${MMIN})
  if [[ "x$RESULT" == "x" ]]; then
		return 1
	else
		return 0
	fi
}

retry=1
ping_ok=0
while (($retry <= $TOTAL_RETRIES)); do
	if firemain_ping; then
		ping_ok=1
		break
	fi
	sleep $SLEEP_TIMEOUT
	((retry++))
done

if [[ $ping_ok -ne 1 ]]; then
	/home/pi/firewalla/scripts/firelog -t cloud -m "FireMain ping FAILED, restart FireMain now"
	sudo systemctl restart firemain
fi
