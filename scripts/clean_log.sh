#!/bin/bash


# this script should be executed when box starts up and executed periodically
# this script itself should not depends on any partition space, meaning it should be able to run with all disks full
# threshold
# soft: (/log is over 85%)
# remove
# /var/log/*.gz
# /log/blog//files.gz
# /log/forever/main.log
# /log/forever/main_last.log
# any files under /log/firewalla that is older than one day
# hard (/log is over 95%)
# remove
# all files under soft
# /var/log/syslog
# /log/apt/cache/*
# /log/forever/*
# /log/firewalla/*




# ----------------------------------------------------------------------------
# Functions
# ----------------------------------------------------------------------------
mylog() {
    echo "$(date -u): $@"
}

loginfo() {
    mylog "INFO: $@"
}

logerror() {
    mylog "ERROR: $@" >&2
}

soft_clean() {
    loginfo "do SOFT cleaning ..."
    sudo rm -f /var/log/*.gz
    sudo rm -f /log/blog/*/files.*.gz
    rm -f /log/forever/main_last.log
    : > /log/forever/main.log
    # any files under /log/firewalla that is older than one day
    find /log/firewalla -mtime +1 -delete
}

hard_clean() {
    loginfo "do HARD cleaning ..."
    : | sudo  tee /var/log/syslog
    sudo rm -rf /log/apt/cache/*
    sudo rm -f /log/blog/*/*.gz
    sudo chown pi:pi /log/forever/*
    ls /log/forever/* | xargs -r -I FILE sudo sh -c ': > FILE'
    ls /log/firewalla/* | xargs -r -I FILE sudo sh -c ': > FILE'
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

use_percent=$( df --output=pcent /log | tail -1 | tr -d ' %' )
loginfo "/log usage at ${use_percent}%"

if (( use_percent > 85 )); then
    soft_clean
    use_percent=$( df --output=pcent /log | tail -1 | tr -d ' %' )
    loginfo "/log usage at ${use_percent}%"
fi

if (( use_percent > 95 )) ; then
    hard_clean
    use_percent=$( df --output=pcent /log | tail -1 | tr -d ' %' )
    loginfo "/log usage at ${use_percent}%"
fi

exit $rc
