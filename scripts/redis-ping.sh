#!/bin/bash
# -----------------------------------------
# This is a watch dog function for redis.
# In case redis hangs, need to restart it.
# -----------------------------------------

TOTAL_RETRIES=5
SLEEP_TIMEOUT=10

redis_ping() {
	RESULT=$(redis-cli ping 2>/dev/null)
  if [[ "$RESULT" == "PONG" ]]; then
		return 0
	else
		return 1
	fi
}

retry=1
ping_ok=0
while ((retry <= TOTAL_RETRIES)); do
	if redis_ping; then
		ping_ok=1
		break
	fi
	sleep $SLEEP_TIMEOUT
	((retry++))
done

if [[ $ping_ok -ne 1 ]]; then
	/home/pi/firewalla/scripts/firelog -t cloud -m "Redis ping FAILED, restart Redis now"
	sudo systemctl restart redis-server
fi
