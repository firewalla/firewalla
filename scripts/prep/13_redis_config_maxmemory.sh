#!/bin/bash

exit 0

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

# hide script normal output to log, only show error
exec > /tmp/13_redis_config_maxmemory.log

redis_run() {
    su - redis -s /bin/bash -c "$@"
}
redis_run "redis-cli config set maxmemory ${REDIS_MAXMEMORY:-0}"
redis_run "redis-cli config rewrite"
redis_run "redis-cli config get maxmemory"
