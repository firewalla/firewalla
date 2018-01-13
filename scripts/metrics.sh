#!/bin/bash

CMD=$(basename $0)
: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_NM_HOME:=/home/pi/firewalla/node_modules}

err(){
    msg="$@"
    echo "ERROR: $msg" >&2
}

REDIS_KEYS=(
    'dns:ip:*' 
    'intel:ip:*' 
    'host:ip4:'
    'host:ip6:'
    'host:mac:*'
)

PERFSTAT_URL=http://localhost:8834/v1/system/perfstat

title() {
    cat <<EOT
# ----------------------------------------------------------------------------
# $@
# ----------------------------------------------------------------------------
EOT
}

redis_keys() {
    title Get metrics from Redis
    for x in ${REDIS_KEYS[@]}
    do
	echo "> redis-cli keys $x"
        redis-cli keys $x
    done
}


disk_usage() {
    title Disk Usage
    df -h
}

memory_usage() {
    title Memory Usage
    curl $PERFSTAT_URL
}

repo_hash() {
    ( cd $FIREWALLA_HOME
    title Firewalla repo hash
    git rev-parse HEAD
    )
}

node_module_hash() {
    ( cd /home/pi
    title Firewalla node module hash
    git rev-parse HEAD
    )
}


# ----
# MAIN
# ----

redis_keys

disk_usage

memory_usage

repo_hash

node_module_hash
