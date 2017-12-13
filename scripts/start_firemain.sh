#!/bin/bash

: ${FIREWALLA_HOME:='/home/pi/firewalla'}
. $FIREWALLA_HOME/scripts/common.sh

# -----------------
#  MAIN goes here
# -----------------

rc=0

update_firewalla || rc=1
update_node_modules || rc=1

$FIREWALLA_HOME/bin/node \
    --expose-gc \
    -max-old-space-size=256 \
    main.js

exit $rc
