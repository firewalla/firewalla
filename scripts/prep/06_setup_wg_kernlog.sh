#! /usr/bin/env bash
#
## Enable wireguard kernel log.
## 1. Set flags for wireguard in dynamic debug control.
## 2. Redirect wireguard kernel log to separated log files.

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}
## Redirect wireguard kernel logs

source ${FIREWALLA_HOME}/platform/platform.sh

DDC_WG_ENABLED=20
WG_PFLAG_COUNT=0

function err() {
    echo "[$(date +'%Y-%m-%dT%H:%M:%S%z')]: $*" >&2
}

function count_ddc_wg_flags() {
    WG_PFLAG_COUNT=$(sudo cat /sys/kernel/debug/dynamic_debug/control | grep wireguard | grep =p | wc -l)
}

function enable_ddc_wg_flags() {
    sudo sh -c  "echo 'file device.c func wg_newlink +p' > /sys/kernel/debug/dynamic_debug/control"
    sudo sh -c  "echo 'file device.c func wg_destruct +p' > /sys/kernel/debug/dynamic_debug/control"
    sudo sh -c  "echo 'file device.c func wg_xmit +p' > /sys/kernel/debug/dynamic_debug/control"
    sudo sh -c  "echo 'file timers.c func wg_expired_new_handshake +p' > /sys/kernel/debug/dynamic_debug/control"
    sudo sh -c  "echo 'file timers.c func wg_expired_retransmit_handshake +p' > /sys/kernel/debug/dynamic_debug/control"
    sudo sh -c  "echo 'file send.c +p' > /sys/kernel/debug/dynamic_debug/control"
    sudo sh -c  "echo 'file receive.c func wg_packet_receive +p' > /sys/kernel/debug/dynamic_debug/control"
    sudo sh -c  "echo 'file receive.c func wg_receive_handshake_packet +p' > /sys/kernel/debug/dynamic_debug/control"
}

function disable_dcc_wg_flags() {
    sudo sh -c  "echo 'module wireguard -p' > /sys/kernel/debug/dynamic_debug/control"
}

function setup_ddc_wg(){
    ## TODO: Check enabled flags by pattern
    count_ddc_wg_flags
    if [[ "${WG_PFLAG_COUNT}" -ge "${DDC_WG_ENABLED}" ]];then
        ## do nothing
        echo ${WG_PFLAG_COUNT} wireguard ddc flags already enabled, skip
        return;
    fi

    enable_ddc_wg_flags

    ## TODO: Check by pattern
    count_ddc_wg_flags
    if [[ "${WG_PFLAG_COUNT}" -lt "${DDC_WG_ENABLED}" ]];then
        err failed to set wireguard flags, ${WG_PFLAG_COUNT} enabled at now
    fi

    echo ${WG_PFLAG_COUNT} wireguard ddc flags enabled
    # sudo cat /sys/kernel/debug/dynamic_debug/control | grep wireguard | grep =p
}

function setup_rsyslog_wg(){
    if [[ ! -f "${FIREWALLA_HOME}/etc/rsyslog.d/41-wireguard.conf" ]];then
        err "wireguard rsyslog conf not found, skip"
        return
    fi

    if [[ -f "/etc/rsyslog.d/41-wireguard.conf" ]];then
        if cmp -s "${FIREWALLA_HOME}/etc/rsyslog.d/41-wireguard.conf" "/etc/rsyslog.d/41-wireguard.conf"; then
            return;
        fi
    fi

    sudo cp ${FIREWALLA_HOME}/etc/rsyslog.d/41-wireguard.conf /etc/rsyslog.d/
    sudo systemctl restart rsyslog
}

setup_ddc_wg

setup_rsyslog_wg
