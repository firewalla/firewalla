#! /usr/bin/env bash

FWCANARY_FLAG="/home/pi/.firewalla/config/.no_upgrade_canary"
FWCANARY_FORCE="/home/pi/.firewalla/config/.force_upgrade_canary"

rm -f $FWCANARY_FLAG

logger "FIREWALLA:UPGRADE_CANARY:START"

if [[ -e $FWCANARY_FORCE ]]; then
  echo "======= FIREWALLA CANARY ALL UPGRADE BECAUSE OF FLAG $FWCANARY_FORCE ======="
  rm -f $FWCANARY_FORCE
  exit 0
fi

err() {
  echo "ERROR: $@" >&2
}

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

[ -s ~/.fwrc ] && source ~/.fwrc
[ -s ${FIREWALLA_HOME}/scripts/network_settings.sh ] && source ${FIREWALLA_HOME}/scripts/network_settings.sh

## CANARY DEPLOYMENT RATIO CONFIG PATH
pushd ${FIREWALLA_HOME}
sudo chown -R pi ${FIREWALLA_HOME}/.git
FW_BRANCH=$(git rev-parse --abbrev-ref HEAD)
popd

: ${FW_ENDPOINT:=$(get_cloud_endpoint)}
FW_VERSION=$(cat $FIREWALLA_HOME/net2/config.json | jq .version)
FW_URL="${FW_ENDPOINT}?type=box_update&model=${FIREWALLA_PLATFORM}&branch=${FW_BRANCH}&version=${FW_VERSION}"
FWACMD="curl -s --max-time 5 -H 'Authorization: Bearer $(redis-cli hget sys:ept token)' '$FW_URL' | jq '. | length' "
ratio=$(eval $FWACMD)
if [ "$ratio" == "0" ];
then
    echo "======= FIREWALLA CANARY NO UPGRADING FOR CLOUD DECISION (ratio=$ratio)======="
    echo $(date +%s) > ${FWCANARY_FLAG}
else
    echo "======= FIREWALLA CANARY UPGRADING (ratio=$ratio)======="
fi

logger "FIREWALLA:UPGRADE_CANARY:END"