#!/bin/bash

REGEX="([A-Z][a-z]+[[:space:]]+[0-9]+ [0-9]+:[0-9]+:[0-9]+).*FireApi Critical Memory Restart2 mon:([0-9]+),[[:space:]]*api:([0-9]+),[[:space:]]*main:([0-9]+),[[:space:]]*bro:([0-9]+),[[:space:]]*redis:([0-9]+),[[:space:]]*b7:([0-9]+),[[:space:]]*b6:([0-9]+),[[:space:]]*proc:([0-9]+),[[:space:]]*thread:([0-9]+)[[:space:]]*main_thread:[[:space:]]*([0-9]+)[[:space:]]*mon_threads:[[:space:]]*([0-9]+)[[:space:]]*mainfile:[[:space:]]*([0-9]+)[[:space:]]*monfile:([0-9]+)[[:space:]]*sys:(.*)"

echo '"Time","FireMain Memory","FireMon Memory","FireApi Memory","Bro Memory","Redis Memory","Bitbridge7 Memory","Bitbridge6 Memory","No. of Total Process","No. of Total Threads","No. of FireMain Threads","No. of FireMon Threads","FireMain Open Files","FireMon Open Files","Sys Open Files"'

ls -tr1 /var/log/syslog* | while read FILENAME; do
  if [[ "$FILENAME" == *.gz ]]
  then
    sudo cat $FILENAME | gunzip | grep 'Critical Memory Restart2' | while read LINE; do
      (if [[ $LINE =~ $REGEX ]]; then
        echo "${BASH_REMATCH[1]},${BASH_REMATCH[4]},${BASH_REMATCH[2]},${BASH_REMATCH[3]},${BASH_REMATCH[5]},${BASH_REMATCH[6]},${BASH_REMATCH[7]},${BASH_REMATCH[8]},${BASH_REMATCH[9]},${BASH_REMATCH[10]},${BASH_REMATCH[11]},${BASH_REMATCH[12]},${BASH_REMATCH[13]},${BASH_REMATCH[14]},${BASH_REMATCH[15]}"
      fi)
    done;
  else
    sudo cat $FILENAME | grep 'Critical Memory Restart2' | while read LINE; do
      (if [[ $LINE =~ $REGEX ]]; then
        echo "${BASH_REMATCH[1]},${BASH_REMATCH[4]},${BASH_REMATCH[2]},${BASH_REMATCH[3]},${BASH_REMATCH[5]},${BASH_REMATCH[6]},${BASH_REMATCH[7]},${BASH_REMATCH[8]},${BASH_REMATCH[9]},${BASH_REMATCH[10]},${BASH_REMATCH[11]},${BASH_REMATCH[12]},${BASH_REMATCH[13]},${BASH_REMATCH[14]},${BASH_REMATCH[15]}"
      fi)
    done;
  fi
done;
