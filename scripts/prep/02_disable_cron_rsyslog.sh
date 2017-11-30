#!/bin/bash

RSYSLOG_CONF=/etc/rsyslog.d/50-default.conf

sed -ie 's/\*\.\*;auth,/*.*;cron,auth,/' $RSYSLOG_CONF

systemctl restart rsyslog
