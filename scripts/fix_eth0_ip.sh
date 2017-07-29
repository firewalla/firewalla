#!/bin/bash

ETH0_IP=$(ifconfig eth0 |grep 'inet addr'|awk '{print $2}' | awk -F: '{print $2}')

SAVED_IP_FILE=/var/run/saved_ip

if [[ -n "${ETH0_IP}" ]]
then
    /bin/rm -f ${SAVED_IP_FILE}
    echo $ETH0_IP > ${SAVED_IP_FILE}
    logger "IP for eth0 detected(${ETH0_IP}), saved in ${SAVED_IP_FILE}"
elif [[ -f "${SAVED_IP_FILE}" ]]
then
    /sbin/ifconfig eth0 $(cat ${SAVED_IP_FILE})
    logger "WARN:NO IP for eth0, set to saved IP - ${SAVED_IP}"
else
    logger "ERROR:NO IP for eth0, and NO saved IP."
fi
