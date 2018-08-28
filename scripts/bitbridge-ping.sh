#!/bin/bash
# -----------------------------------------
# This is a watch dog function for bitbridge7.
# In case of redis connection loss, 
# need to restart bitbridge7.
# -----------------------------------------

bitbridge7_ping () {
    RESULT=$(sudo netstat -anlp | grep bitbridge7 | grep 6379 | grep ESTABLISHED && pgrep bitbridge7)
    ret=$?
    if [[ $ret != 0 ]]; then
        return 1
    else
        return 0
    fi
}

is_spoof_mode () {
    MODE=$(redis-cli get mode)
    if [[ $MODE == "spoof" ]]; then
        return 0
    else
        return 1
    fi
}

is_bitbridge7_active () {
    RESULT=$(systemctl is-active bitbridge4)
    if [[ $RESULT == "active" ]]; then
        return 0
    else
        return 1
    fi
}

if is_spoof_mode && is_bitbridge7_active; then
    if bitbridge7_ping; then
        exit 0
    else
        # binary is bitbridge7, however service name is bitbridge4...
        sudo systemctl restart bitbridge4
    fi
fi
