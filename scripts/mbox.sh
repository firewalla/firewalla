#!/bin/bash

CMD=$(basename $0)
DATE_FORMAT='[%Y-%m-%d %H:%M:%S]'
LOG_QUIET=0
LOG_ERROR=1
LOG_WARN=2
LOG_INFO=3
LOG_DEBUG=4

: ${LOGLEVEL:=$LOG_INFO}


REDIS_CHANNEL='sys:trace'
: ${SLACK_WEBHOOK:=''}
SLACK_CHANNEL='box-trace'
BOX_NAME=$(redis-cli get groupName)

mylog() {
    echo "$(date +"$DATE_FORMAT")$@"
}
mylogn() {
    echo -n "$(date +"$DATE_FORMAT")$@"
}

logdebug() {
    test $LOGLEVEL -ge $LOG_DEBUG || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[DEBUG] $@" >&2
    else
        mylog "[DEBUG] $@" >&2
    fi
}

loginfo() {
    test $LOGLEVEL -ge $LOG_INFO || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[INFO] $@"
    else
        mylog "[INFO] $@"
    fi
}

logwarn() {
    test $LOGLEVEL -ge $LOG_WARN || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[WARN] $@" >&2
    else
        mylog "[WARN] $@" >&2
    fi
}

logerror() {
    test $LOGLEVEL -ge $LOG_ERROR || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[ERROR] $@" >&2
    else
        mylog "[ERROR] $@" >&2
    fi
}

notify_slack() {
    json_data=$(echo "$1" | jq ".box=\"$BOX_NAME\"" | jq -sR '"```"+.+"```"')
    # data=$(echo "$1" | jq -R .)
    logdebug "json_data: $json_data"
    payload=$(cat <<EOS
payload={ \
    "channel" : "$SLACK_CHANNEL", \
    "user" : "$BOX_NAME", \
    "blocks": [ { "type": "section", "text": { "type": "mrkdwn", "text": $json_data } } ] \
}
EOS
#"text": $json_data \
#"text": "$REDIS_CHANNEL action detected", \
    )
    logdebug "payload: $payload"
    curl --retry 10 --retry-delay 3 -s -o /dev/null -X POST --data-urlencode "$payload" $SLACK_WEBHOOK || {
        logerror "failed to notify slack with payload: $payload"
    }
}

# MAIN goes here

test -n "$SLACK_WEBHOOK" || {
    logerror "Slack webhook is required"
    exit 1
}

LOCK_FILE=/var/lock/${CMD/.sh/.lock}
exec {lock_fd}> $LOCK_FILE
flock -x -n $lock_fd || {
    logerror "Another instance of $CMD is already running, abort"
    exit 1
}
echo $$ > $LOCK_FILE

trap "rm -f $LOCK_FILE" EXIT INT STOP

stdbuf -oL redis-cli subscribe $REDIS_CHANNEL | while read x
do
    case $x in
        message)
             read channel
             if [[ $channel == $REDIS_CHANNEL ]]; then
                 read resp
                 notify_slack "$resp"
             fi
             ;;
        *) logdebug "ignore input: $x" ;;
    esac
done
