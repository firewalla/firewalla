#!/bin/bash

DIR="$( cd "$( dirname "$0" )" && pwd )"

NAME=$1
source $DIR/ss_client.${NAME}.rc

: ${FW_SS_CONFIG_PATH:="${HOME}/.firewalla/run/ss_client.${NAME}.config.json"}

: ${FW_SS_REDIR_BINARY:="${DIR}/bin.$(uname -m)/fw_ss_redir"}
: ${FW_SS_REDIR_PID_FILE:="${HOME}/.firewalla/run/ss_client.redir.pid"}
: ${FW_SS_REDIR_PORT:=8820}
: ${FW_SS_REDIR_ADDRESS:="0.0.0.0"}

: ${FW_SS_CLIENT_BINARY:="${DIR}/bin.$(uname -m)/fw_ss_client"}
: ${FW_SS_CLIENT_PORT:=8822}
: ${FW_SS_CLIENT_PID_FILE:="${HOME}/.firewalla/run/ss_client.client.pid"}
: ${FW_SS_CLIENT_ADDRESS:="0.0.0.0"}

: ${FW_OVERTURE_BINARY:="${DIR}/bin.$(uname -m)/overture"}
: ${FW_OVERTURE_CONFIG:="${DIR}/overture.config.json"}

# redirection
# /home/pi/firewalla/extension/ss_client/fw_ss_redir
#  -c /home/pi/.firewalla/config/ss_client.config.json
#  -l 8820
#  -f /home/pi/.firewalla/run/ss_client.redir.pid
#  -b 0.0.0.0
$FW_SS_REDIR_BINARY -c $FW_SS_CONFIG_PATH -l $FW_SS_REDIR_PORT -f $FW_SS_REDIR_PID_FILE -b $FW_SS_REDIR_ADDRESS

# ss_client
# /home/pi/firewalla/extension/ss_client/fw_ss_client
#  -c /home/pi/.firewalla/config/ss_client.config.json
#  -l 8822
#  -f /home/pi/.firewalla/run/ss_client.pid
#  -b 0.0.0.0
$FW_SS_CLIENT_BINARY -c $FW_SS_CONFIG_PATH -l $FW_SS_CLIENT_PORT -f $FW_SS_CLIENT_PID_FILE -b $FW_SS_CLIENT_ADDRESS

# overture
$FW_OVERTURE_BINARY -c $FW_OVERTURE_CONFIG
