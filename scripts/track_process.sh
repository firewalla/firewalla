#!/bin/bash

track_process() {
  PROCESS_NAME=$1
  REDIS_KEY_NAME_MEM=$2
  REDIS_KEY_NAME_CPU=$3

  MEM=$(pgrep -x $PROCESS_NAME | xargs ps -h -o rss -p 2>/dev/null)
  CPU=$(pgrep -x $PROCESS_NAME | xargs ps -h -o pcpu -p 2>/dev/null)

  UTS=$(date +%s)
  UTS_EXPIRE=$(date +%s --date="10 days ago")

  if [[ -z $MEM || -z $UTS || -z $UTS_EXPIRE || -z $CPU ]]; then
    echo > /dev/null
  else
    redis-cli zadd $REDIS_KEY_NAME_MEM $UTS $MEM &>/dev/null
    redis-cli ZREMRANGEBYSCORE $REDIS_KEY_NAME_MEM -inf $UTS_EXPIRE &>/dev/null
    redis-cli zadd $REDIS_KEY_NAME_CPU $UTS $CPU &>/dev/null
    redis-cli ZREMRANGEBYSCORE $REDIS_KEY_NAME_CPU -inf $UTS_EXPIRE &>/dev/null
  fi
}

if [[ $(cat /tmp/REPO_BRANCH) != "master" ]]; then
  exit 0
fi

track_process FireMain memory_firemain cpu_firemain
track_process FireApi memory_fireapi cpu_fireapi
track_process FireMon memory_firemon cpu_firemon