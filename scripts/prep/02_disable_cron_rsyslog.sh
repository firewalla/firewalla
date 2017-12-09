#!/bin/bash

RSYSLOG_CONF=/etc/rsyslog.d/50-default.conf

if fgrep -q '*.*;auth,' $RSYSLOG_CONF
then
    sed -ie 's/\*\.\*;auth,/*.*;cron,auth,/' $RSYSLOG_CONF
    systemctl restart rsyslog
fi

