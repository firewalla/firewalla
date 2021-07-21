#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

ASSETS_FILE_PATH=$(get_dynamic_assets_list)

if [[ ! -f $ASSETS_FILE_PATH ]]; then
  exit 0
fi

while IFS= read -r line; do
  line=($line)
  file_path=${line[0]}
  bin_url=${line[1]}
  hash_url=${line[2]}
  perm=${line[3]}
  expected_hash=$(curl $hash_url)
  if [[ $? -ne 0 ]]; then
    echo "Failed to get hash of $file_path from $hash_url"
    continue
  fi
  current_hash=""
  if [[ -f $file_path ]]; then
    current_hash=$(sha256sum $file_path | awk '{print $1}')
  fi
  if [[ $expected_hash != $current_hash ]]; then
    echo "Hash of $file_path mismatches with $hash_url, will fetch latest file from $bin_url"
    wget $bin_url -O $file_path
  else
    echo "Hash of $file_path matches with $hash_url"
  fi
  chmod $perm $file_path
done < "$ASSETS_FILE_PATH"