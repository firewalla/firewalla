#!/bin/bash
# -----------------------------------------
# This is a watch dog function for bitbridge7.
# In case of redis connection loss, 
# need to restart bitbridge7.
# -----------------------------------------

bitbridge7_ping () {
    RESULT=$(sudo netstat -anlp | grep bitbridge7 | grep 6379 | grep ESTABLISHED || pgrep bitbridge7)
    ret=$?
    if [[ $? != 0 ]]; then
        return 1
    else
        return 0
    fi
}

if bitbridge7_ping; then
    exit 0
else
    # binary is bitbridge7, however service name is bitbridge4...
    sudo systemctl restart bitbridge4
fi