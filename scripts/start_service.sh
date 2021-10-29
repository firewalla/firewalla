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

( cd $FIREWALLA_HOME/$service_subdir

UV_THREADPOOL_SIZE=16 $FIREWALLA_HOME/bin/node \
    --expose-gc \
    -max-old-space-size=$MAX_OLD_SPACE_SIZE \
    $service_run $extra_opts
)

#    --inspect=0.0.0.0:$dport\
exit $rc
