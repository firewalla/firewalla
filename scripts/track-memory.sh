#!/bin/bash

track_process() {
  PROCESS_NAME=$1
  REDIS_KEY_NAME=$2
  
  MEM=$(pgrep -x $PROCESS_NAME | xargs ps -h -o rss -p 2>/dev/null)

  UTS=$(date +%s)
  UTS_EXPIRE=$(date +%s --date="10 days ago")

  if [[ -z $MEM || -z $UTS || -z $UTS_EXPIRE ]]; then
    echo > /dev/null
  else
    redis-cli zadd $REDIS_KEY_NAME $UTS $MEM &>/dev/null
    redis-cli ZREMRANGEBYSCORE $REDIS_KEY_NAME -inf $UTS_EXPIRE &>/dev/null
  fi  
}

if [[ $(cat /tmp/REPO_BRANCH) != "master" ]]; then
  exit 0
fi

track_process FireMain memory_firemain
track_process FireApi memory_fireapi
track_process FireMon memory_firemon