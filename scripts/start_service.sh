#!/bin/bash

: ${FIREWALLA_HOME:='/home/pi/firewalla'}
: ${UPGRADE_TIMEOUT:=1200}
. $FIREWALLA_HOME/scripts/common.sh

# -----------------
#  MAIN goes here
# -----------------

service=$1
rc=0


case $service in
    FireMain)
        service_subdir=net2
        service_run=main.js
        ;;
    FireApi)
        service_subdir=api
        service_run=bin/www
        ;;
    FireMon)
        service_subdir=monitor
        service_run=MonitorMain.js
        ;;
esac

# Only update firewalla and node_modules if service has been up for more than a
# given period of time in seconds
service_elapsed_seconds=$(ps axo cmd,etimes | awk "/^${service}/ {print \$2}")
if [[ $service_elapsed_seconds -gt $UPGRADE_TIMEOUT ]]
then
    # Do not enable this feature by now (Melvin)
    logger "UPDATE firewalla and node_modules after $service is up for $service_elapsed_seconds seconds"
    #update_firewalla || rc=1
    #update_node_modules || rc=1
fi

( cd $FIREWALLA_HOME/$service_subdir

$FIREWALLA_HOME/bin/node \
    --expose-gc \
    -max-old-space-size=256 \
    $service_run
)

exit $rc
