#!/bin/bash

RSYSLOG_CONF=/etc/rsyslog.d/50-default.conf

if fgrep -q '*.*;auth,' $RSYSLOG_CONF
then
    sed -ie 's/\*\.\*;auth,/*.*;cron,auth,/' $RSYSLOG_CONF
    systemctl restart rsyslog
fi


RC_LOCAL=/etc/rc.local

if [[ -e $RC_LOCAL ]]; then
    if ! fgrep -q 'sudo -u pi /usr/bin/crontab -r' $RC_LOCAL
    then
    # add 'sudo -u pi crontab -r' before exit 0
    sed -ie 's/^exit 0/sudo -u pi \/usr\/bin\/crontab -r\nexit 0/' $RC_LOCAL
    fi
else
    echo "sudo -u pi /usr/bin/crontab -r " >> $RC_LOCAL
    echo "exit 0" >> $RC_LOCAL
    sudo chmod +x $RC_LOCAL
fi
