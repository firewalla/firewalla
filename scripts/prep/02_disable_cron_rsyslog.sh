#!/bin/bash

RSYSLOG_CONF=/etc/rsyslog.d/50-default.conf

if fgrep -q '*.*;auth,' $RSYSLOG_CONF
then
    sed -ie 's/\*\.\*;auth,/*.*;cron,auth,/' $RSYSLOG_CONF
    systemctl restart rsyslog
fi


RC_LOCAL=/etc/rc.local

if ! fgrep -q 'sudo -u pi /usr/bin/crontab -r' $RC_LOCAL
then
    # add 'sudo -u pi crontab -r' before exit 0
    sed -ie 's/^exit 0/sudo -u pi \/usr\/bin\/crontab -r\nexit 0/' /etc/rc.local
fi