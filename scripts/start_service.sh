#!/bin/bash

: ${FIREWALLA_HOME:='/home/pi/firewalla'}
: ${UPGRADE_TIMEOUT:=1200}
: ${MAX_OLD_SPACE_SIZE:=256}
. $FIREWALLA_HOME/scripts/common.sh

# -----------------
#  MAIN goes here
# -----------------

rc=0
service=$1
extra_opts=''
debug_opts=''

case $service in
    FireMain)
        service_subdir=net2
        service_run=main.js
        dport=9227
        ;;
    FireApi)
        service_subdir=api
        service_run=bin/www
        dport=9228
        ;;
    FireMon)
        service_subdir=monitor
        service_run=MonitorMain.js
        dport=9229
        ;;
    FireKick)
        service_subdir=sys
        service_run=kickstart.js
        extra_opts='--config /encipher.config/netbot.config'
        ;;
esac

cd $FIREWALLA_HOME
branch=$(git rev-parse --abbrev-ref HEAD)
if [[ $branch == "master" && -f /home/pi/.firewalla/config/inspect_${service} ]]; then
  debug_opts="--inspect=0.0.0.0:$dport"
fi

# Only update firewalla and node_modules if service has been up for more than a
# given period of time in seconds
service_elapsed_seconds=$(ps axo cmd,etimes | awk "/^${service}/ {print \$2}")
if [[ -n "$service_elapsed_seconds" && $service_elapsed_seconds -gt $UPGRADE_TIMEOUT ]]
then
    # Do not enable this feature by now (Melvin)
    logger "UPDATE firewalla and node_modules after $service is up for $service_elapsed_seconds seconds"
    #update_firewalla || rc=1
    #update_node_modules || rc=1
fi

redis-cli HINCRBY "stats:systemd:restart" $service 1

jemalloc_so_path=$(readlink -f $(ldconfig -p | grep libjemalloc | awk -F '=> ' '{print $2}'))
if [[ -n "$jemalloc_so_path" ]]; then
  export LD_PRELOAD=$jemalloc_so_path
fi

# Crash guard for the upgraded Node, disabled for now (2026-09-29, not needed while on dev)
# node_bin=$(get_node_bin_path)
# SECONDS=0
( cd $FIREWALLA_HOME/$service_subdir

UV_THREADPOOL_SIZE=16 $FIREWALLA_HOME/bin/node \
    --expose-gc \
    $debug_opts \
    -max-old-space-size=$MAX_OLD_SPACE_SIZE \
    $service_run $extra_opts
)
# node_rc=$?
#
# # Reached only when node exits on its own (systemctl stop/restart kills this script too).
# # If the upgraded Node exits within 5 minutes 3 times in 30 minutes, latch its version into
# # config/.node_legacy so the next start falls back to the platform default Node
# if [[ $service =~ ^(FireMain|FireMon|FireApi)$ && $node_bin == $NODE_VERSIONS_DIR/* ]] && (( SECONDS < 300 )); then
#   exits_file=${FIREWALLA_HIDDEN:-/home/pi/.firewalla}/run/node_short_exits.$service
#   now=$(date +%s)
#   { awk -v t=$((now - 1800)) '$1 > t' $exits_file 2>/dev/null; echo $now; } > $exits_file.tmp && mv $exits_file.tmp $exits_file
#   if (( $(wc -l < $exits_file) >= 3 )); then
#     node_ver=${node_bin#$NODE_VERSIONS_DIR/}; node_ver=${node_ver%%/*}
#     echo $node_ver > ${FIREWALLA_HIDDEN:-/home/pi/.firewalla}/config/.node_legacy
#     rm -f ${exits_file%.*}.*   # every service's count: leftovers would roll a later version back early
#     logger "FIREWALLA:NODE_UPGRADE:ROLLBACK $service exited (rc=$node_rc) 3 times within 30min on $node_ver, falling back to default node"
#   fi
# fi

#    --inspect=0.0.0.0:$dport\
exit $rc
