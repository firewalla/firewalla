#!/bin/bash

set -e

: ${FIREWALLA_HOME:='/home/pi/firewalla'}
: ${FW_NODE_MODULES_PATH:='/home/pi/.node_modules'}

update_firewalla() {
    (
    cd $FIREWALLA_HOME
    git fetch origin $branch
    git reset --hard FETCH_HEAD   
    )
}

update_node_modules {
    cd $FIREWALLA_HOME
    branch=$(git rev-parse --abbrev-ref HEAD)
    if [[ $branch =~ release.* ]]; then
      # record production branch in redis
      redis-cli hset sys:config prod.branch $branch
      export FWPRODUCTION=$branch
    fi
    export FIREWALLA_NODE_MODULES_MODE=GIT
    CPU_PLATFORM=$(uname -m)

    if [[ $CPU_PLATFORM == "x86_64" ]]; then
        export NODE_MODULE_REPO=https://github.com/firewalla/firewalla_nodemodules.x86_64.git
    else
        export NODE_MODULE_REPO=https://github.com/firewalla/firewalla_nodemodules.git
    fi

    FW_NODE_MODULES_PATH=~/.node_modules
    if [[ "x$FIREWALLA_NODE_MODULES_MODE" == "xGIT" ]]; then
      sudo rm -f ~/.node_modules/.git/index.lock
      if [[ ! -d $FW_NODE_MODULES_PATH ]]; then
        cd
        # try again if failed, in case network issue
        git clone --recursive -b $branch --single-branch $NODE_MODULE_REPO $FW_NODE_MODULES_PATH || git clone --recursive -b $branch --single-branch $NODE_MODULE_REPO $FW_NODE_MODULES_PATH
        cd - &>/dev/null
      fi
      REVISION_FILE=$FIREWALLA_HOME/scripts/NODE_MODULES_REVISION.$CPU_PLATFORM

      NODE_VERSION=$($FIREWALLA_HOME/bin/node -v)

      RE_NODE4='^v4\..*$'      
      if [[ $NODE_VERSION =~ $RE_NODE4 ]]; then
        REVISION_FILE=$FIREWALLA_HOME/scripts/NODE_MODULES_REVISION.$CPU_PLATFORM.node4
      fi
      
      if [[ -d $FW_NODE_MODULES_PATH && -f $REVISION_FILE ]]; then
        cd $FW_NODE_MODULES_PATH

        EXPECTED_REVISION=$(cat $REVISION_FILE)
        CURRENT_REVISION=$(git log | head -n 1 | awk '{print $2}')

        # only reset head when there is new expected revision number
        # this is to reduce the freq of calling 'git reset'
        if [[ $EXPECTED_REVISION != $CURRENT_REVISION ]]; then
            git fetch origin  || git fetch origin
            git reset -q --hard `cat $REVISION_FILE`
            if [[ -n $FWPRODUCTION ]]; then
                git clean -xdf # clean up all untracking files in node modules repo
                # only clean untrack files in production mode
            fi
        fi
        cd - &>/dev/null
      fi
    fi
}


# -----------------
#  MAIN goes here
# -----------------

update_firewalla
update_node_modules

$FIREWALLA_HOME/bin/node \
    --expose-gc \
    -max-old-space-size=256 \
    main.js \
    >> /home/pi/.forever/main.log  2>&1'

exit 0
