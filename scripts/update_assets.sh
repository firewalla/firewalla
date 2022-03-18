#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh
source ~/.fwrc

ASSETSD_PATH=${FIREWALLA_HIDDEN}/run/assets.d/

if [[ ! -d $ASSETSD_PATH ]]; then
  echo "assets.d folder doesn't exist, exit"
  exit 0
fi

ASSETS_PREFIX=$(get_assets_prefix)


cd $ASSETSD_PATH
# unify lists under assets.d/, keeps one entry for each file only
# list with lower prefix number got fetched earlier but list with bigger prefix number has higher priority
cat -n * | sort -r | sort -ub --key=2,2 | sort -n | cut -f2- |
while IFS= read -r line; do
  line=$(eval 'for param in '$line'; do echo $param; done')
  IFS=$'\n' read -rd '' -a params <<< "$line"
  file_path=${params[0]}
  bin_url="${ASSETS_PREFIX}${params[1]}"
  hash_url="${ASSETS_PREFIX}${params[2]}"
  perm=${params[3]}
  exec_pre=${params[4]}
  exec_post=${params[5]}
  expected_hash=$(curl $hash_url --no-progress-meter)
  if [[ $? -ne 0 ]]; then
    echo "Failed to get hash of $file_path from $hash_url"
    continue
  fi
  if [ ${#expected_hash} != 64 ]; then
    echo "Invalid hash from $hash_url"
    continue
  fi
  current_hash=""
  if [[ -f $file_path ]]; then
    current_hash=$(sha256sum $file_path | awk '{print $1}')
  fi
  changed=""
  if [[ $expected_hash != $current_hash ]]; then
    echo "Hash of $file_path mismatches with $hash_url, will fetch latest file from $bin_url"
    if [[ -n $exec_pre ]]; then
      eval "$exec_pre"
      # if [ $? -ne 0 ]; then
      #   echo "Pre-script failed, skipping.."
      #   continue; # skip if command fails
      # fi
    fi
    sudo mkdir -p $(dirname "${file_path}")
    sudo wget $bin_url -O $file_path
    changed="1"
  else
    echo "Hash of $file_path matches with $hash_url"
  fi
  if [[ -f $file_path ]]; then
    sudo chmod $perm $file_path
  fi
  if [[ -n $exec_post && $changed == "1" ]]; then
    eval "$exec_post"
  fi
done
