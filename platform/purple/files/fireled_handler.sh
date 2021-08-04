#!/bin/bash

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------
LED_PATH='/sys/devices/platform/leds/leds'
REDIS_CHANNEL_SYS_STATES='sys.states'
REDIS_KEY_SYS_STATES='sys:states'

# ----------------------------------------------------------------------------
# Functions
# ----------------------------------------------------------------------------
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

set_led() {
    type=$1
    state=$2
    c=
    s=
    case $type in
        error)  c='red'  ;;
        status) c='blue' ;;
        *) logerror "unknown type '$type'"; return 1 ;;
    esac
    case $state in
        on) s='default-on' ;;
        off) s='none' ;;
        blink) s='timer' ;;
        heartbeat) s='heartbeat' ;;
        *) logerror "unknown state '$state'"; return 1 ;;
    esac
    loginfo "set LED $c to $s"
    sudo bash -c "echo $s > $LED_PATH/$c/trigger"
}

set_leds() {
    loginfo "set LEDs with state $1"
    case $1 in
        critical)
          set_led error on
          set_led status off
          ;;
        error)
          set_led error blink
          set_led status off
          ;;
        notice)
          set_led error on
          set_led status on
          ;;
        info)
          set_led error off
          set_led status blink
          ;;
        *)
          set_led error off
          set_led status off
          ;;
    esac
}

get_sys_state() {
    redis-cli --raw hget $REDIS_KEY_SYS_STATES $1
}

CHECK_CRITICAL='firereset firerouter'
CHECK_ERROR='fireboot_network firerouter_network wan'

update_leds_display() {

    for comp in $CHECK_CRITICAL; do
        test "$(get_sys_state $comp)" == 'fail' && {
            set_leds critical
            return 0
        }
    done

    for comp in $CHECK_ERROR; do
        test "$(get_sys_state $comp)" == 'fail' && {
            set_leds error
            return 0
        }
    done

    ethernet_connected=$(get_sys_state ethernet_connected)
    boot_state=$(get_sys_state boot_state)
    if [[ "$ethernet_connected" == 'false' || "$boot_state" == 'ready4pairing' ]]
    then
        set_leds notice
        return 0
    elif [[ "$boot_state" == 'booting' ]]
    then
        set_leds info
        return 0
    else
        set_leds idle
        return 0
    fi
}

waiting_for_sys_states_update() {
    stdbuf -oL redis-cli --raw subscribe $REDIS_CHANNEL_SYS_STATES
}

update_sys_states_in_redis() {
    jq -r 'to_entries[]|[.key, .value]|@tsv' | while read k v; do redis-cli hset $REDIS_KEY_SYS_STATES $k $v; done
    if [[ $? -eq 0 ]]; then
        update_leds_display
    fi
}

update_led_with_current_sys_states() {
    redis-cli hgetall $REDIS_KEY_SYS_STATES
}

process_sys_states_update() {
    # initial response
    read subscribe; read channel; read rc
    # start processing
    while true; do
        read rcmd
        read channel
        read message
        if [[ $rcmd == 'message' && $channel == $REDIS_CHANNEL_SYS_STATES ]]; then
            echo "$message" | jq empty || {
                logerror "invalid JSON string"
                continue
            }
            echo "$message" | update_sys_states_in_redis
        fi
    done
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

set -x

waiting_for_sys_states_update | process_sys_states_update

