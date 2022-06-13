#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh
source ~/.fwrc

logger "FIREWALLA:UPDATE_ASSETS:START"

ASSETSD_PATH=${FIREWALLA_HIDDEN}/config/assets.d/

if [[ ! -d $ASSETSD_PATH ]]; then
  echo "assets.d folder doesn't exist, exit"
  exit 0
fi

ASSETS_PREFIX=$(get_assets_prefix)
RELEASE_TYPE=$(get_release_type)

### can set VERIFY_SIGNATURE to "false" in dev to bypass signature check
if [ -z "$VERIFY_SIGNATURE" -o "$RELEASE_TYPE" = "alpha" -o "$RELEASE_TYPE" = "beta" -o "$RELEASE_TYPE" = "prod" ]; then
  VERIFY_SIGNATURE=true
fi

ASSETS_PUBLIC_KEY=/home/pi/firewalla/etc/keys/assets.key
TEMP_DIR=$(mktemp -d)
trap 'rm -fr "$TEMP_DIR"' EXIT

cd $ASSETSD_PATH
# unify lists under assets.d/, keeps one entry for each file only
# list with lower prefix number got fetched earlier but list with bigger prefix number has higher priority
cat -n * | sort -r | sort -ub --key=2,2 | sort -n | cut -f2- |
while IFS= read -r line; do
  line=$(eval 'for param in '$line'; do echo $param; done')
  IFS=$'\n' read -rd '' -a params <<< "$line"
  file_path=${params[0]}
  s3_path=${params[1]}
  bin_url="${ASSETS_PREFIX}${s3_path}"
  hash_url="${bin_url}.sha256"
  signature_url="${bin_url}.sig"
  perm=${params[2]}
  exec_pre=${params[3]}
  exec_post=${params[4]}
  expected_hash=$(curl $hash_url -s)
  if [[ $? -ne 0 ]]; then
    echo "Failed to get hash of $file_path from $hash_url"
    continue
  fi
  if [ ${#expected_hash} != 64 ]; then
    echo "Invalid hash from $hash_url"
    continue
  fi

  # verify signature
  if [ "$VERIFY_SIGNATURE" = "true" ]; then
    signature_file="$TEMP_DIR"/$(cat /dev/urandom | tr -dc '[:alpha:]' |  head -c 20)
    wget -qO "$signature_file" "$signature_url"
    if [ "$?" != 0 ]; then
      echo "No signature file found: $signature_url"
      continue
    fi
    SIGNED_TEXT="$expected_hash,${s3_path}"
    echo -n "$SIGNED_TEXT" | openssl dgst -verify "$ASSETS_PUBLIC_KEY" -keyform PEM -sha256 -signature "$signature_file" > /dev/null
    if [ "$?" != 0 ]; then
      echo "Error signature: ${s3_path}"
      continue
    fi
  fi

  current_hash=""
  if [[ -f $file_path ]]; then
    current_hash=$(sha256sum $file_path | awk '{print $1}')
  fi
  changed=""
  if [[ $expected_hash != $current_hash ]]; then
    echo "Hash of $file_path mismatches with $hash_url, will fetch latest file from $bin_url"

    sudo mkdir -p $(dirname "${file_path}")
    temp_file="$file_path".download
    sudo wget "$bin_url" -O "$temp_file"
    verify_hash=$(sha256sum $temp_file | awk '{print $1}')
    if [[ "$verify_hash" != "$expected_hash" ]]; then
      echo "Incomplete file downloaded"
      continue
    fi

    if [[ -n $exec_pre ]]; then
      eval "$exec_pre"
      # if [ $? -ne 0 ]; then
      #   echo "Pre-script failed, skipping.."
      #   continue; # skip if command fails
      # fi
    fi

    sudo mv "$temp_file" "$file_path"
    changed="1"
  else
    echo "Hash of $file_path matches with $hash_url"
  fi
  if [[ -f $file_path ]]; then
    sudo chown pi:pi $file_path
    sudo chmod $perm $file_path
  fi
  if [[ -n $exec_post && $changed == "1" ]]; then
    eval "$exec_post"
  fi
done

$FIREWALLA_HOME/scripts/patch_system.sh 2>&1 | tee -a /home/pi/.forever/patch_system.log

logger "FIREWALLA:UPDATE_ASSETS:DONE"
