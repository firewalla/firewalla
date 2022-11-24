#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

# hide script normal output to log, only show error
exec > /tmp/13_redis_config_maxmemory.log

redis_run() {
    su - redis -s /bin/bash -c "$@"
}

CUR_VALUE=$(redis-cli config get maxmemory | tail -n 1)

# reset to 0 if already set to none-zero by previous legacy code
if [[ "$CUR_VALUE" -ne 0 ]]; then
  redis_run "redis-cli config set maxmemory 0"
fi

exit 0

redis_run "redis-cli config set maxmemory ${REDIS_MAXMEMORY:-0}"
redis_run "redis-cli config rewrite"
redis_run "redis-cli config get maxmemory"
