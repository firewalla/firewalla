#!/bin/bash

: "${FIREROUTER_HOME:=/home/pi/firerouter}"

cd $FIREROUTER_HOME

# commit fixes firerouter upgrade issue
git merge-base --is-ancestor 97a43b9faf0492b3a4a96628ea6c23246524fb90 HEAD || {
    logger 'FIREWALLA.ROUTERCHECK FireRouter is out dated, trying to update...'
    echo 'FIREWALLA.ROUTERCHECK FireRouter is out dated, trying to update...'
    git fetch
    git reset --hard origin/HEAD~1
    logger 'FIREWALLA.ROUTERCHECK Done, FireRouter should be updated in the next maintainance window'
    echo 'FIREWALLA.ROUTERCHECK Done, FireRouter should be updated in the next maintainance window'
}
