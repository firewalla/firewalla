#!/bin/bash

if [[ -e /.dockerenv ]]; then
    #Disable iptables in docker
    /home/pi/firewalla/scripts/flush_iptables.sh
    exit
fi

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

BLACK_HOLE_IP="0.0.0.0"
BLUE_HOLE_IP="198.51.100.100"

: ${FW_PROBABILITY:=0.9}
: ${FW_QOS_PROBABILITY:=0.999}

sudo which ipset &>/dev/null || sudo apt-get install -y ipset

mkdir -p ${FIREWALLA_HIDDEN}/run/iptables

cat << EOF > ${FIREWALLA_HIDDEN}/run/iptables/ipset4
# bidirection
create block_ip_set hash:ip family inet hashsize 16384 maxelem 65536
create block_domain_set hash:ip family inet hashsize 16384 maxelem 65536
create block_net_set hash:net family inet hashsize 4096 maxelem 65536
create sec_block_ip_set hash:ip family inet hashsize 16384 maxelem 65536
create sec_block_domain_set hash:ip family inet hashsize 16384 maxelem 65536
create sec_block_net_set hash:net family inet hashsize 4096 maxelem 65536
# inbound
create block_ib_ip_set hash:ip family inet hashsize 16384 maxelem 65536
create block_ib_domain_set hash:ip family inet hashsize 16384 maxelem 65536
create block_ib_net_set hash:net family inet hashsize 4096 maxelem 65536
# outbound
create block_ob_ip_set hash:ip family inet hashsize 16384 maxelem 65536
create block_ob_domain_set hash:ip family inet hashsize 16384 maxelem 65536
create block_ob_net_set hash:net family inet hashsize 4096 maxelem 65536

# bidirection
create allow_ip_set hash:ip family inet hashsize 16384 maxelem 65536
create allow_domain_set hash:ip family inet hashsize 16384 maxelem 65536
create allow_net_set hash:net family inet hashsize 4096 maxelem 65536
# inbound
create allow_ib_ip_set hash:ip family inet hashsize 16384 maxelem 65536
create allow_ib_domain_set hash:ip family inet hashsize 16384 maxelem 65536
create allow_ib_net_set hash:net family inet hashsize 4096 maxelem 65536
# outbound
create allow_ob_ip_set hash:ip family inet hashsize 16384 maxelem 65536
create allow_ob_domain_set hash:ip family inet hashsize 16384 maxelem 65536
create allow_ob_net_set hash:net family inet hashsize 4096 maxelem 65536

create monitored_ip_set hash:ip family inet hashsize 128 maxelem 65536

# This is to ensure all ipsets are empty when initializing
flush block_ip_set
flush block_domain_set
flush block_net_set
flush sec_block_ip_set
flush sec_block_domain_set
flush sec_block_net_set
flush block_ib_ip_set
flush block_ib_domain_set
flush block_ib_net_set
flush block_ob_ip_set
flush block_ob_domain_set
flush block_ob_net_set
flush allow_ip_set
flush allow_domain_set
flush allow_net_set
flush allow_ib_ip_set
flush allow_ib_domain_set
flush allow_ib_net_set
flush allow_ob_ip_set
flush allow_ob_domain_set
flush allow_ob_net_set

flush monitored_ip_set

EOF

cat << EOF > ${FIREWALLA_HIDDEN}/run/iptables/ipset
create acl_off_mac_set hash:mac
create acl_off_set list:set
create no_dns_caching_mac_set hash:mac
create no_dns_caching_set list:set
create monitored_net_set list:set

create qos_off_mac_set hash:mac
create qos_off_set list:set

create match_dns_port_set bitmap:port range 0-65535

flush acl_off_mac_set
flush acl_off_set
add acl_off_set acl_off_mac_set

flush no_dns_caching_mac_set
flush no_dns_caching_set
add no_dns_caching_set no_dns_caching_mac_set
flush monitored_net_set

flush qos_off_mac_set
flush qos_off_set
add qos_off_set qos_off_mac_set

EOF

cat ${FIREWALLA_HIDDEN}/run/iptables/ipset4 >> ${FIREWALLA_HIDDEN}/run/iptables/ipset

# v4 specific entries
cat << EOF >> ${FIREWALLA_HIDDEN}/run/iptables/ipset
create match_all_set4 hash:net maxelem 16
flush match_all_set4
add match_all_set4 0.0.0.0/1
add match_all_set4 128.0.0.0/1
add match_dns_port_set 53

add block_ip_set ${BLUE_HOLE_IP}

# create a list of set which stores net set of lan networks
create c_lan_set list:set
flush c_lan_set

# create a list of set which stores net set of lan networks
create c_lan_set list:set
flush c_lan_set

EOF

# dupe common entries from v4 to v6
cat ${FIREWALLA_HIDDEN}/run/iptables/ipset4 |
sed s/_ip_set/_ip_set6/ |
sed s/_domain_set/_domain_set6/ |
sed s/_net_set/_net_set6/ |
sed s/inet/inet6/ >> ${FIREWALLA_HIDDEN}/run/iptables/ipset

# v6 specific entries
cat << EOF >> ${FIREWALLA_HIDDEN}/run/iptables/ipset
create monitored_ip_set6 hash:ip family inet6 hashsize 1024 maxelem 65536
create match_all_set6 hash:net family inet6 maxelem 16

flush match_all_set6
add match_all_set6 ::/1
add match_all_set6 8000::/1

flush monitored_ip_set6

EOF

sudo ipset restore -! --file ${FIREWALLA_HIDDEN}/run/iptables/ipset

if [[ $MANAGED_BY_FIREROUTER != "yes" ]]; then
  sudo iptables -w -F FORWARD
  sudo iptables -w -t nat -F PREROUTING
  sudo ip6tables -w -F FORWARD
  sudo ip6tables -w -t nat -F PREROUTING
fi

# ifb module is for QoS
if [[ $IFB_SUPPORTED == "yes" ]]; then
  sudo modprobe ifb &> /dev/null || true
else
  sudo rmmod ifb &> /dev/null || true
fi

ip rule list |
grep -v -e "^\(501\|1001\|2001\|3000\|3001\|4001\|5001\|5002\|6001\|7001\|8001\|9001\|10001\):" |
cut -d: -f2- |
xargs -i sudo ip rule del {}

sudo ip rule add pref 0 from all lookup local
sudo ip rule add pref 32766 from all lookup main
sudo ip rule add pref 32767 from all lookup default

# ============= filter =============
touch ${FIREWALLA_HIDDEN}/run/iptables/filter
cat << EOF > ${FIREWALLA_HIDDEN}/run/iptables/filter
-N FW_FORWARD
-A FORWARD -j FW_FORWARD

# INPUT chain protection
-N FW_INPUT_ACCEPT
-A INPUT -j FW_INPUT_ACCEPT

-N FW_INPUT_DROP
-A INPUT -j FW_INPUT_DROP

# drop log chain
-N FW_DROP_LOG
# multi protocol block chain
-N FW_DROP
# do not apply ACL enforcement for outbound connections of acl off devices/networks
-A FW_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
-A FW_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
-A FW_DROP -j FW_DROP_LOG
-A FW_DROP -p tcp -j REJECT --reject-with tcp-reset
-A FW_DROP -j DROP

# security drop log chain
-N FW_SEC_DROP_LOG
# multi protocol block chain
-N FW_SEC_DROP
# do not apply ACL enforcement for outbound connections of acl off devices/networks
-A FW_SEC_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
-A FW_SEC_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
-A FW_SEC_DROP -j FW_SEC_DROP_LOG
-A FW_SEC_DROP -p tcp -j REJECT --reject-with tcp-reset
-A FW_SEC_DROP -j DROP

# tls drop log chain
-N FW_TLS_DROP_LOG
# multi protocol block chain
-N FW_TLS_DROP
# do not apply ACL enforcement for outbound connections of acl off devices/networks
-A FW_TLS_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
-A FW_TLS_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
-A FW_TLS_DROP -j FW_TLS_DROP_LOG
-A FW_TLS_DROP -p tcp -j REJECT --reject-with tcp-reset
-A FW_TLS_DROP -j DROP

# security tls drop log chain
-N FW_SEC_TLS_DROP_LOG
# multi protocol block chain
-N FW_SEC_TLS_DROP
# do not apply ACL enforcement for outbound connections of acl off devices/networks
-A FW_SEC_TLS_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
-A FW_SEC_TLS_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
-A FW_SEC_TLS_DROP -j FW_SEC_TLS_DROP_LOG
-A FW_SEC_TLS_DROP -p tcp -j REJECT --reject-with tcp-reset
-A FW_SEC_TLS_DROP -j DROP

# WAN inbound drop log chain
-N FW_WAN_IN_DROP_LOG
# WAN inbound drop chain
-N FW_WAN_IN_DROP
-A FW_WAN_IN_DROP -j FW_WAN_IN_DROP_LOG
-A FW_WAN_IN_DROP -j DROP

# log allow rule
-N FW_ACCEPT_LOG
-A FW_ACCEPT_LOG -m set --match-set monitored_net_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j LOG --log-prefix "[FW_ADT]A=A D=O CD=O "
-A FW_ACCEPT_LOG -m set ! --match-set monitored_net_set src,src -m set --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j LOG --log-prefix "[FW_ADT]A=A D=I CD=O "
-A FW_ACCEPT_LOG -m set --match-set monitored_net_set src,src -m set --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j LOG --log-prefix "[FW_ADT]A=A D=L CD=O "

# accept allow rules
-N FW_ACCEPT
-A FW_ACCEPT -m conntrack --ctstate NEW -j FW_ACCEPT_LOG
-A FW_ACCEPT -j CONNMARK --set-xmark 0x80000000/0x80000000
-A FW_ACCEPT -j ACCEPT

# add FW_ACCEPT_DEFAULT to the end of FORWARD chain
-N FW_ACCEPT_DEFAULT
-A FW_ACCEPT_DEFAULT -j CONNMARK --set-xmark 0x80000000/0x80000000
-A FW_ACCEPT_DEFAULT -j ACCEPT
-A FORWARD -j FW_ACCEPT_DEFAULT

# high percentage to bypass firewall rules if the packet belongs to a previously accepted flow
-A FW_FORWARD -m connmark --mark 0x80000000/0x80000000 -m connbytes --connbytes 4 --connbytes-dir original --connbytes-mode packets -m statistic --mode random --probability ${FW_PROBABILITY} -j ACCEPT
-A FW_FORWARD -j CONNMARK --set-xmark 0x00000000/0x80000000
# do not check packets in the reverse direction of the connection, this is mainly for upnp allow rule implementation, which only accepts packets in original direction
-A FW_FORWARD -m conntrack --ctdir REPLY -j ACCEPT

# initialize alarm chain
-N FW_ALARM
-A FW_FORWARD -j FW_ALARM
-N FW_ALARM_DEV
-A FW_ALARM -j FW_ALARM_DEV
-N FW_ALARM_DEV_G
-A FW_ALARM -j FW_ALARM_DEV_G
-N FW_ALARM_NET
-A FW_ALARM -j FW_ALARM_NET
-N FW_ALARM_NET_G
-A FW_ALARM -j FW_ALARM_NET_G
-N FW_ALARM_GLOBAL
-A FW_ALARM -j FW_ALARM_GLOBAL

# initialize vpn client kill switch chain
-N FW_VPN_CLIENT
-A FW_FORWARD -j FW_VPN_CLIENT

# initialize firewall high priority chain
-N FW_FIREWALL_HI
-A FW_FORWARD -j FW_FIREWALL_HI
# device high priority block/allow chains
-A FW_FIREWALL_HI -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_ALLOW_HI
-A FW_FIREWALL_HI -j FW_FIREWALL_DEV_ALLOW_HI
-A FW_FIREWALL_HI -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL_HI -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_BLOCK_HI
-A FW_FIREWALL_HI -j FW_FIREWALL_DEV_BLOCK_HI
-A FW_FIREWALL_HI -m mark ! --mark 0x0/0xffff -j FW_DROP
# device group high priority block/allow chains
-A FW_FIREWALL_HI -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_G_ALLOW_HI
-A FW_FIREWALL_HI -j FW_FIREWALL_DEV_G_ALLOW_HI
-A FW_FIREWALL_HI -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL_HI -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_G_BLOCK_HI
-A FW_FIREWALL_HI -j FW_FIREWALL_DEV_G_BLOCK_HI
-A FW_FIREWALL_HI -m mark ! --mark 0x0/0xffff -j FW_DROP
# network high priority block/allow chains
-A FW_FIREWALL_HI -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_ALLOW_HI
-A FW_FIREWALL_HI -j FW_FIREWALL_NET_ALLOW_HI
-A FW_FIREWALL_HI -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL_HI -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_BLOCK_HI
-A FW_FIREWALL_HI -j FW_FIREWALL_NET_BLOCK_HI
-A FW_FIREWALL_HI -m mark ! --mark 0x0/0xffff -j FW_DROP
# network group high priority block/allow chains
-A FW_FIREWALL_HI -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_G_ALLOW_HI
-A FW_FIREWALL_HI -j FW_FIREWALL_NET_G_ALLOW_HI
-A FW_FIREWALL_HI -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL_HI -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_G_BLOCK_HI
-A FW_FIREWALL_HI -j FW_FIREWALL_NET_G_BLOCK_HI
-A FW_FIREWALL_HI -m mark ! --mark 0x0/0xffff -j FW_DROP
# global high priority block/allow chains
-A FW_FIREWALL_HI -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_GLOBAL_ALLOW_HI
-A FW_FIREWALL_HI -j FW_FIREWALL_GLOBAL_ALLOW_HI
-A FW_FIREWALL_HI -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL_HI -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_GLOBAL_BLOCK_HI
-A FW_FIREWALL_HI -j FW_FIREWALL_GLOBAL_BLOCK_HI
-A FW_FIREWALL_HI -m mark ! --mark 0x0/0xffff -j FW_DROP
# security block ipset in global high priority chain
-A FW_FIREWALL_GLOBAL_BLOCK_HI -m set --match-set sec_block_ip_set src -j FW_SEC_DROP
-A FW_FIREWALL_GLOBAL_BLOCK_HI -m set --match-set sec_block_ip_set dst -j FW_SEC_DROP
-A FW_FIREWALL_GLOBAL_BLOCK_HI -m set --match-set sec_block_domain_set src -j FW_SEC_DROP
-A FW_FIREWALL_GLOBAL_BLOCK_HI -m set --match-set sec_block_domain_set dst -j FW_SEC_DROP
-A FW_FIREWALL_GLOBAL_BLOCK_HI -m set --match-set sec_block_net_set src -j FW_SEC_DROP
-A FW_FIREWALL_GLOBAL_BLOCK_HI -m set --match-set sec_block_net_set dst -j FW_SEC_DROP

# initialize firewall regular chain
-N FW_FIREWALL
-A FW_FORWARD -j FW_FIREWALL
# device block/allow chains
-A FW_FIREWALL -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_ALLOW
-A FW_FIREWALL -j FW_FIREWALL_DEV_ALLOW
-A FW_FIREWALL -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_BLOCK
-A FW_FIREWALL -j FW_FIREWALL_DEV_BLOCK
-A FW_FIREWALL -m mark ! --mark 0x0/0xffff -j FW_DROP
# device group block/allow chains
-A FW_FIREWALL -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_G_ALLOW
-A FW_FIREWALL -j FW_FIREWALL_DEV_G_ALLOW
-A FW_FIREWALL -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_G_BLOCK
-A FW_FIREWALL -j FW_FIREWALL_DEV_G_BLOCK
-A FW_FIREWALL -m mark ! --mark 0x0/0xffff -j FW_DROP
# network block/allow chains
-A FW_FIREWALL -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_ALLOW
-A FW_FIREWALL -j FW_FIREWALL_NET_ALLOW
-A FW_FIREWALL -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_BLOCK
-A FW_FIREWALL -j FW_FIREWALL_NET_BLOCK
-A FW_FIREWALL -m mark ! --mark 0x0/0xffff -j FW_DROP
# network group block/allow chains
-A FW_FIREWALL -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_G_ALLOW
-A FW_FIREWALL -j FW_FIREWALL_NET_G_ALLOW
-A FW_FIREWALL -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_G_BLOCK
-A FW_FIREWALL -j FW_FIREWALL_NET_G_BLOCK
-A FW_FIREWALL -m mark ! --mark 0x0/0xffff -j FW_DROP
# global block/allow chains
-A FW_FIREWALL -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_GLOBAL_ALLOW
-A FW_FIREWALL -j FW_FIREWALL_GLOBAL_ALLOW
-A FW_FIREWALL -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_GLOBAL_BLOCK
-A FW_FIREWALL -j FW_FIREWALL_GLOBAL_BLOCK
-A FW_FIREWALL -m mark ! --mark 0x0/0xffff -j FW_DROP

# bidirection
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ip_set src -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ip_set dst -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_domain_set src -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_domain_set dst -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_net_set src -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_net_set dst -j FW_ACCEPT
# inbound
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_ip_set src -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_ip_set dst -m conntrack --ctdir REPLY -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_domain_set src -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_domain_set dst -m conntrack --ctdir REPLY -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_net_set src -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_net_set dst -m conntrack --ctdir REPLY -j FW_ACCEPT
# outbound
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_ip_set src -m conntrack --ctdir REPLY -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_ip_set dst -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_domain_set src -m conntrack --ctdir REPLY -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_domain_set dst -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_net_set src -m conntrack --ctdir REPLY -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_net_set dst -m conntrack --ctdir ORIGINAL -j FW_ACCEPT

# bidirection
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ip_set src -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ip_set dst -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_domain_set src -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_domain_set dst -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_net_set src -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_net_set dst -j FW_DROP
# inbound
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_ip_set src -m conntrack --ctdir ORIGINAL -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_ip_set dst -m conntrack --ctdir REPLY -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_domain_set src -m conntrack --ctdir ORIGINAL -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_domain_set dst -m conntrack --ctdir REPLY -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_net_set src -m conntrack --ctdir ORIGINAL -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_net_set dst -m conntrack --ctdir REPLY -j FW_DROP
# outbound
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_ip_set src -m conntrack --ctdir REPLY -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_ip_set dst -m conntrack --ctdir ORIGINAL -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_domain_set src -m conntrack --ctdir REPLY -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_domain_set dst -m conntrack --ctdir ORIGINAL -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_net_set src -m conntrack --ctdir REPLY -j FW_DROP
-A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_net_set dst -m conntrack --ctdir ORIGINAL -j FW_DROP

# initialize firewall low priority chain
-N FW_FIREWALL_LO
-A FW_FORWARD -j FW_FIREWALL_LO
# device low priority block/allow chains
-A FW_FIREWALL_LO -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_ALLOW_LO
-A FW_FIREWALL_LO -j FW_FIREWALL_DEV_ALLOW_LO
-A FW_FIREWALL_LO -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL_LO -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_BLOCK_LO
-A FW_FIREWALL_LO -j FW_FIREWALL_DEV_BLOCK_LO
-A FW_FIREWALL_LO -m mark ! --mark 0x0/0xffff -j FW_DROP
# device group low priority block/allow chains
-A FW_FIREWALL_LO -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_G_ALLOW_LO
-A FW_FIREWALL_LO -j FW_FIREWALL_DEV_G_ALLOW_LO
-A FW_FIREWALL_LO -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL_LO -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_DEV_G_BLOCK_LO
-A FW_FIREWALL_LO -j FW_FIREWALL_DEV_G_BLOCK_LO
-A FW_FIREWALL_LO -m mark ! --mark 0x0/0xffff -j FW_DROP
# network low priority block/allow chains
-A FW_FIREWALL_LO -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_ALLOW_LO
-A FW_FIREWALL_LO -j FW_FIREWALL_NET_ALLOW_LO
-A FW_FIREWALL_LO -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL_LO -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_BLOCK_LO
-A FW_FIREWALL_LO -j FW_FIREWALL_NET_BLOCK_LO
-A FW_FIREWALL_LO -m mark ! --mark 0x0/0xffff -j FW_DROP
# network group low priority block/allow chains
-A FW_FIREWALL_LO -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_G_ALLOW_LO
-A FW_FIREWALL_LO -j FW_FIREWALL_NET_G_ALLOW_LO
-A FW_FIREWALL_LO -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL_LO -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_NET_G_BLOCK_LO
-A FW_FIREWALL_LO -j FW_FIREWALL_NET_G_BLOCK_LO
-A FW_FIREWALL_LO -m mark ! --mark 0x0/0xffff -j FW_DROP
# global low priority block/allow chains
-A FW_FIREWALL_LO -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_GLOBAL_ALLOW_LO
-A FW_FIREWALL_LO -j FW_FIREWALL_GLOBAL_ALLOW_LO
-A FW_FIREWALL_LO -m mark ! --mark 0x0/0xffff -j FW_ACCEPT
-A FW_FIREWALL_LO -j MARK --set-xmark 0x0/0xffff
-N FW_FIREWALL_GLOBAL_BLOCK_LO
-A FW_FIREWALL_LO -j FW_FIREWALL_GLOBAL_BLOCK_LO
-A FW_FIREWALL_LO -m mark ! --mark 0x0/0xffff -j FW_DROP
EOF

if [[ -e /.dockerenv ]]; then
  echo '-A OUTPUT -j FW_BLOCK' >> ${FIREWALLA_HIDDEN}/run/iptables/filter
fi

# save entries doesn't start with "FW_" first
sudo iptables-save -t filter | grep -v ":FW_\| FW_\|^COMMIT" | tee ${FIREWALLA_HIDDEN}/run/iptables/iptables
cat ${FIREWALLA_HIDDEN}/run/iptables/filter >> ${FIREWALLA_HIDDEN}/run/iptables/iptables

cat << EOF >> ${FIREWALLA_HIDDEN}/run/iptables/iptables
# accept packet to DHCP client, sometimes the reply is a unicast packet and will not be considered as a reply packet of the original broadcast packet by conntrack module
-A FW_INPUT_ACCEPT -p udp --dport 68 --sport 67:68 -j ACCEPT
-A FW_INPUT_ACCEPT -p tcp --dport 68 --sport 67:68 -j ACCEPT

EOF

sudo ip6tables-save -t filter | grep -v ":FW_\| FW_\|COMMIT" | tee ${FIREWALLA_HIDDEN}/run/iptables/ip6tables
cat ${FIREWALLA_HIDDEN}/run/iptables/filter |
sed s/_ip_set/_ip_set6/ |
sed s/_domain_set/_domain_set6/ |
# not replacing monitored_net_set
sed -e '/monitored_net_set/!s/_net_set/_net_set6/' >> ${FIREWALLA_HIDDEN}/run/iptables/ip6tables

cat << EOF >> ${FIREWALLA_HIDDEN}/run/iptables/ip6tables
# accept traffic to DHCPv6 client, sometimes the reply is a unicast packet and will not be considered as a reply packet of the original broadcast packet by conntrack module
-A FW_INPUT_ACCEPT -p udp --dport 546 --sport 546:547 -j ACCEPT
-A FW_INPUT_ACCEPT -p tcp --dport 546 --sport 546:547 -j ACCEPT
# accept neighbor discovery packets
-A FW_INPUT_ACCEPT -p icmpv6 --icmpv6-type neighbour-solicitation -j ACCEPT
-A FW_INPUT_ACCEPT -p icmpv6 --icmpv6-type neighbour-advertisement -j ACCEPT
-A FW_INPUT_ACCEPT -p icmpv6 --icmpv6-type router-advertisement -j ACCEPT

EOF

if [[ $XT_TLS_SUPPORTED == "yes" ]]; then
# these sets are not ipset and contain only domain names, use same set for both v4 & v6
# check /proc/net/xt_tls/hostset/sec_block_domain_set
cat << EOF >> ${FIREWALLA_HIDDEN}/run/iptables/iptables
-A FW_FIREWALL_GLOBAL_BLOCK_HI -p tcp -m tls --tls-hostset sec_block_domain_set -j FW_SEC_TLS_DROP
-A FW_FIREWALL_GLOBAL_ALLOW -p tcp -m tls --tls-hostset allow_domain_set -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_BLOCK -p tcp -m tls --tls-hostset block_domain_set -j FW_TLS_DROP

EOF
cat << EOF >> ${FIREWALLA_HIDDEN}/run/iptables/ip6tables
-A FW_FIREWALL_GLOBAL_BLOCK_HI -p tcp -m tls --tls-hostset sec_block_domain_set -j FW_SEC_TLS_DROP
-A FW_FIREWALL_GLOBAL_ALLOW -p tcp -m tls --tls-hostset allow_domain_set -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_BLOCK -p tcp -m tls --tls-hostset block_domain_set -j FW_TLS_DROP

EOF
fi


echo 'COMMIT' >> ${FIREWALLA_HIDDEN}/run/iptables/iptables
echo 'COMMIT' >> ${FIREWALLA_HIDDEN}/run/iptables/ip6tables


# ============= NAT =============
sudo iptables-save -t nat | grep -v ":FW_\| FW_\|COMMIT" | tee -a ${FIREWALLA_HIDDEN}/run/iptables/iptables

cat << EOF >> ${FIREWALLA_HIDDEN}/run/iptables/iptables
-N FW_PREROUTING
-A PREROUTING -j FW_PREROUTING

-N FW_POSTROUTING
-A POSTROUTING -j FW_POSTROUTING

# create POSTROUTING VPN chain
-N FW_POSTROUTING_OPENVPN
-A FW_POSTROUTING -j FW_POSTROUTING_OPENVPN

# create POSTROUTING WIREGUARD chain
-N FW_POSTROUTING_WIREGUARD
-A FW_POSTROUTING -j FW_POSTROUTING_WIREGUARD

# nat POSTROUTING port forward hairpin chain
-N FW_POSTROUTING_PORT_FORWARD
-A FW_POSTROUTING -m conntrack --ctstate DNAT -j FW_POSTROUTING_PORT_FORWARD
-N FW_POSTROUTING_HAIRPIN
# create POSTROUTING dmz host chain and add it to the end of port forward chain
-N FW_POSTROUTING_DMZ_HOST
-A FW_POSTROUTING_PORT_FORWARD -j FW_POSTROUTING_DMZ_HOST

# nat blackhole 8888
-N FW_NAT_HOLE
-A FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888
-A FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888
-A FW_NAT_HOLE -j RETURN


# a special chain mainly for red/blue to redirect VPN connection on overlay IP to primary IP if two subnets are the same
-N FW_PREROUTING_VPN_OVERLAY
-A FW_PREROUTING -j FW_PREROUTING_VPN_OVERLAY

# VPN client chain to mark VPN client inbound connection
-N FW_PREROUTING_VC_INBOUND
-A FW_PREROUTING -j FW_PREROUTING_VC_INBOUND

# DNAT related chain comes first
# create port forward chain in PREROUTING, this is used in ipv4 only
-N FW_PREROUTING_EXT_IP
-A FW_PREROUTING -j FW_PREROUTING_EXT_IP
-N FW_PREROUTING_PORT_FORWARD
# create dmz host chain, this is used in ipv4 only
-N FW_PREROUTING_DMZ_HOST
-A FW_PREROUTING_DMZ_HOST -p tcp -m multiport --dports 22,53,8853,8837,8833,8834,8835 -j RETURN
-A FW_PREROUTING_DMZ_HOST -p udp -m multiport --dports 53,8853 -j RETURN
# add dmz host chain to the end of port forward chain
-A FW_PREROUTING_PORT_FORWARD -j FW_PREROUTING_DMZ_HOST

# create vpn client dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN_CLIENT
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT

# initialize nat dns fallback chain, which is traversed if acl is off
-N FW_PREROUTING_DNS_FALLBACK

# initialize nat bypass chain after port forward and vpn client
-N FW_NAT_BYPASS
-A FW_PREROUTING -j FW_NAT_BYPASS
# jump to DNS_FALLBACK for acl off devices/networks
-A FW_NAT_BYPASS -m set --match-set acl_off_set src,src -j FW_PREROUTING_DNS_FALLBACK
# jump to DNS_FALLBACK for dns boost off devices/networks
-A FW_NAT_BYPASS -m set --match-set no_dns_caching_set src,src -j FW_PREROUTING_DNS_FALLBACK

# create regular dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
-N FW_PREROUTING_DNS_WG
-A FW_PREROUTING -j FW_PREROUTING_DNS_WG
-N FW_PREROUTING_DNS_DEFAULT
-A FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT
# traverse DNS fallback chain if default chain is not taken
-A FW_PREROUTING -j FW_PREROUTING_DNS_FALLBACK

# redirect blue hole ip 80/443 port to localhost
-A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 80 -j REDIRECT --to-ports 8880
-A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 443 -j REDIRECT --to-ports 8883
EOF

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  echo '-A FW_PREROUTING_DMZ_HOST -j FR_WIREGUARD' >> ${FIREWALLA_HIDDEN}/run/iptables/iptables
fi

echo 'COMMIT' >> ${FIREWALLA_HIDDEN}/run/iptables/iptables


sudo ip6tables-save -t nat | grep -v ":FW_\| FW_\|COMMIT" | tee -a ${FIREWALLA_HIDDEN}/run/iptables/ip6tables

cat << EOF >> ${FIREWALLA_HIDDEN}/run/iptables/ip6tables
-N FW_PREROUTING
-A PREROUTING -j FW_PREROUTING

-N FW_POSTROUTING
-A POSTROUTING -j FW_POSTROUTING

# nat blackhole 8888
-N FW_NAT_HOLE
-A FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888
-A FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888
-A FW_NAT_HOLE -j RETURN

# VPN client chain to mark VPN client inbound connection
-N FW_PREROUTING_VC_INBOUND
-A FW_PREROUTING -j FW_PREROUTING_VC_INBOUND

# create vpn client dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN_CLIENT
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT

# initialize nat dns fallback chain, which is traversed if acl is off
-N FW_PREROUTING_DNS_FALLBACK

# initialize nat bypass chain after vpn client
-N FW_NAT_BYPASS
-A FW_PREROUTING -j FW_NAT_BYPASS
# jump to DNS_FALLBACK for acl off devices/networks
-A FW_NAT_BYPASS -m set --match-set acl_off_set src,src -j FW_PREROUTING_DNS_FALLBACK
# jump to DNS_FALLBACK for dns boost off devices/networks
-A FW_NAT_BYPASS -m set --match-set no_dns_caching_set src,src -j FW_PREROUTING_DNS_FALLBACK

# create regular dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
-N FW_PREROUTING_DNS_WG
-A FW_PREROUTING -j FW_PREROUTING_DNS_WG
-N FW_PREROUTING_DNS_DEFAULT
-A FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT
# traverse DNS fallback chain if default chain is not taken
-A FW_PREROUTING -j FW_PREROUTING_DNS_FALLBACK

COMMIT
EOF


# ============= mangle =============
cat << EOF > ${FIREWALLA_HIDDEN}/run/iptables/mangle
-N FW_OUTPUT
-I OUTPUT -j FW_OUTPUT

# restore fwmark for reply packets of inbound connections
-A FW_OUTPUT -m connmark ! --mark 0x0/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff

# the sequence is important, higher priority rule is placed after lower priority rule
-N FW_PREROUTING
-I PREROUTING -j FW_PREROUTING

# do not change fwmark if it is an existing outbound connection, both for session sticky and reducing iptables overhead
-A FW_PREROUTING -m connmark ! --mark 0x0/0xffff -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff
# restore mark on a REPLY packet of an existing connection
-A FW_PREROUTING -m connmark ! --mark 0x0/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff
-A FW_PREROUTING -m mark ! --mark 0x0/0xffff -j RETURN
# always check first 4 original packets of an unmarked connection, this is mainly for tls match
-A FW_PREROUTING -m connmark --mark 0x80000000/0x80000000 -m connbytes --connbytes 4 --connbytes-dir original --connbytes-mode packets -j RETURN

# route chain
-N FW_RT
# only for outbound traffic marking
-A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -j FW_RT
# global route chain
-N FW_RT_GLOBAL
-N FW_RT_GLOBAL_1
-A FW_RT_GLOBAL -j FW_RT_GLOBAL_1
-A FW_RT_GLOBAL -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_GLOBAL_2
-A FW_RT_GLOBAL -j FW_RT_GLOBAL_2
-A FW_RT_GLOBAL -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_GLOBAL_3
-A FW_RT_GLOBAL -j FW_RT_GLOBAL_3
-A FW_RT_GLOBAL -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_GLOBAL_4
-A FW_RT_GLOBAL -j FW_RT_GLOBAL_4
-A FW_RT_GLOBAL -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_GLOBAL_5
-A FW_RT_GLOBAL -j FW_RT_GLOBAL_5
# network group route chain
-N FW_RT_TAG_NETWORK
-N FW_RT_TAG_NETWORK_1
-A FW_RT_TAG_NETWORK -j FW_RT_TAG_NETWORK_1
-A FW_RT_TAG_NETWORK -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_TAG_NETWORK_2
-A FW_RT_TAG_NETWORK -j FW_RT_TAG_NETWORK_2
-A FW_RT_TAG_NETWORK -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_TAG_NETWORK_3
-A FW_RT_TAG_NETWORK -j FW_RT_TAG_NETWORK_3
-A FW_RT_TAG_NETWORK -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_TAG_NETWORK_4
-A FW_RT_TAG_NETWORK -j FW_RT_TAG_NETWORK_4
-A FW_RT_TAG_NETWORK -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_TAG_NETWORK_5
-A FW_RT_TAG_NETWORK -j FW_RT_TAG_NETWORK_5
# network route chain
-N FW_RT_NETWORK
-N FW_RT_NETWORK_1
-A FW_RT_NETWORK -j FW_RT_NETWORK_1
-A FW_RT_NETWORK -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_NETWORK_2
-A FW_RT_NETWORK -j FW_RT_NETWORK_2
-A FW_RT_NETWORK -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_NETWORK_3
-A FW_RT_NETWORK -j FW_RT_NETWORK_3
-A FW_RT_NETWORK -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_NETWORK_4
-A FW_RT_NETWORK -j FW_RT_NETWORK_4
-A FW_RT_NETWORK -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_NETWORK_5
-A FW_RT_NETWORK -j FW_RT_NETWORK_5
# device group route chain
-N FW_RT_TAG_DEVICE
-N FW_RT_TAG_DEVICE_1
-A FW_RT_TAG_DEVICE -j FW_RT_TAG_DEVICE_1
-A FW_RT_TAG_DEVICE -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_TAG_DEVICE_2
-A FW_RT_TAG_DEVICE -j FW_RT_TAG_DEVICE_2
-A FW_RT_TAG_DEVICE -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_TAG_DEVICE_3
-A FW_RT_TAG_DEVICE -j FW_RT_TAG_DEVICE_3
-A FW_RT_TAG_DEVICE -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_TAG_DEVICE_4
-A FW_RT_TAG_DEVICE -j FW_RT_TAG_DEVICE_4
-A FW_RT_TAG_DEVICE -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_TAG_DEVICE_5
-A FW_RT_TAG_DEVICE -j FW_RT_TAG_DEVICE_5
# device route chain
-N FW_RT_DEVICE
-N FW_RT_DEVICE_1
-A FW_RT_DEVICE -j FW_RT_DEVICE_1
-A FW_RT_DEVICE -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_DEVICE_2
-A FW_RT_DEVICE -j FW_RT_DEVICE_2
-A FW_RT_DEVICE -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_DEVICE_3
-A FW_RT_DEVICE -j FW_RT_DEVICE_3
-A FW_RT_DEVICE -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_DEVICE_4
-A FW_RT_DEVICE -j FW_RT_DEVICE_4
-A FW_RT_DEVICE -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_DEVICE_5
-A FW_RT_DEVICE -j FW_RT_DEVICE_5

-A FW_RT -j FW_RT_DEVICE
-A FW_RT -m mark ! --mark 0x0/0xffff -j RETURN
-A FW_RT -j FW_RT_TAG_DEVICE
-A FW_RT -m mark ! --mark 0x0/0xffff -j RETURN
-A FW_RT -j FW_RT_NETWORK
-A FW_RT -m mark ! --mark 0x0/0xffff -j RETURN
-A FW_RT -j FW_RT_TAG_NETWORK
-A FW_RT -m mark ! --mark 0x0/0xffff -j RETURN
-A FW_RT -j FW_RT_GLOBAL

# save the nfmark to connmark, which will be restored for subsequent packets of this connection and reduce duplicate chain traversal
-A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -m mark ! --mark 0x0/0xffff -j CONNMARK --save-mark --nfmask 0xffff --ctmask 0xffff

-N FW_FORWARD
-I FORWARD -j FW_FORWARD

# do not repeatedly traverse the FW_FORWARD chain in mangle table if the connection is already accepted before
-A FW_FORWARD -m connmark --mark 0x80000000/0x80000000 -m connbytes --connbytes 4 --connbytes-dir original --connbytes-mode packets -m statistic --mode random --probability $FW_QOS_PROBABILITY -j RETURN

-N FW_QOS_SWITCH
-A FW_FORWARD -j FW_QOS_SWITCH
# second bit of 32-bit mark indicates if packet should be mirrored to ifb device in tc filter.
# the packet will be mirrored to ifb only if this bit is set
-A FW_QOS_SWITCH -m set --match-set qos_off_set src,src -j CONNMARK --set-xmark 0x00000000/0x40000000
-A FW_QOS_SWITCH -m set --match-set qos_off_set dst,dst -j CONNMARK --set-xmark 0x00000000/0x40000000
-A FW_QOS_SWITCH -m set ! --match-set qos_off_set src,src -m set ! --match-set qos_off_set dst,dst -j CONNMARK --set-xmark 0x40000000/0x40000000

-N FW_QOS
-A FW_FORWARD -m connmark --mark 0x40000000/0x40000000 -j FW_QOS

# look into the first reply packet, it should contain both upload and download QoS conntrack mark.
-N FW_QOS_LOG
-A FW_FORWARD -m connmark ! --mark 0x00000000/0x3fff0000 -m conntrack --ctdir REPLY -m connbytes --connbytes 1:1 --connbytes-dir reply --connbytes-mode packets -j FW_QOS_LOG
-A FW_QOS_LOG -j CONNMARK --restore-mark --mask 0x3fff0000
-A FW_QOS_LOG -m set --match-set monitored_net_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir REPLY -j LOG --log-prefix "[FW_ADT]A=Q D=I CD=R "
-A FW_QOS_LOG -m set ! --match-set monitored_net_set src,src -m set --match-set monitored_net_set dst,dst -m conntrack --ctdir REPLY -j LOG --log-prefix "[FW_ADT]A=Q D=O CD=R "
-A FW_QOS_LOG -m set --match-set monitored_net_set src,src -m set --match-set monitored_net_set dst,dst -m conntrack --ctdir REPLY -j LOG --log-prefix "[FW_ADT]A=Q D=L CD=R "

# global qos connmark chain
-N FW_QOS_GLOBAL
-A FW_QOS -j FW_QOS_GLOBAL
-N FW_QOS_GLOBAL_5
-A FW_QOS_GLOBAL -j FW_QOS_GLOBAL_5
-N FW_QOS_GLOBAL_4
-A FW_QOS_GLOBAL -j FW_QOS_GLOBAL_4
-N FW_QOS_GLOBAL_3
-A FW_QOS_GLOBAL -j FW_QOS_GLOBAL_3
-N FW_QOS_GLOBAL_2
-A FW_QOS_GLOBAL -j FW_QOS_GLOBAL_2
-N FW_QOS_GLOBAL_1
-A FW_QOS_GLOBAL -j FW_QOS_GLOBAL_1
# network group qos connmark chain
-N FW_QOS_NET_G
-A FW_QOS -j FW_QOS_NET_G
-N FW_QOS_NET_G_5
-A FW_QOS_NET_G -j FW_QOS_NET_G_5
-N FW_QOS_NET_G_4
-A FW_QOS_NET_G -j FW_QOS_NET_G_4
-N FW_QOS_NET_G_3
-A FW_QOS_NET_G -j FW_QOS_NET_G_3
-N FW_QOS_NET_G_2
-A FW_QOS_NET_G -j FW_QOS_NET_G_2
-N FW_QOS_NET_G_1
-A FW_QOS_NET_G -j FW_QOS_NET_G_1
# network qos connmark chain
-N FW_QOS_NET
-A FW_QOS -j FW_QOS_NET
-N FW_QOS_NET_5
-A FW_QOS_NET -j FW_QOS_NET_5
-N FW_QOS_NET_4
-A FW_QOS_NET -j FW_QOS_NET_4
-N FW_QOS_NET_3
-A FW_QOS_NET -j FW_QOS_NET_3
-N FW_QOS_NET_2
-A FW_QOS_NET -j FW_QOS_NET_2
-N FW_QOS_NET_1
-A FW_QOS_NET -j FW_QOS_NET_1
# device group qos connmark chain
-N FW_QOS_DEV_G
-A FW_QOS -j FW_QOS_DEV_G
-N FW_QOS_DEV_G_5
-A FW_QOS_DEV_G -j FW_QOS_DEV_G_5
-N FW_QOS_DEV_G_4
-A FW_QOS_DEV_G -j FW_QOS_DEV_G_4
-N FW_QOS_DEV_G_3
-A FW_QOS_DEV_G -j FW_QOS_DEV_G_3
-N FW_QOS_DEV_G_2
-A FW_QOS_DEV_G -j FW_QOS_DEV_G_2
-N FW_QOS_DEV_G_1
-A FW_QOS_DEV_G -j FW_QOS_DEV_G_1
# device qos connmark chain
-N FW_QOS_DEV
-A FW_QOS -j FW_QOS_DEV
-N FW_QOS_DEV_5
-A FW_QOS_DEV -j FW_QOS_DEV_5
-N FW_QOS_DEV_4
-A FW_QOS_DEV -j FW_QOS_DEV_4
-N FW_QOS_DEV_3
-A FW_QOS_DEV -j FW_QOS_DEV_3
-N FW_QOS_DEV_2
-A FW_QOS_DEV -j FW_QOS_DEV_2
-N FW_QOS_DEV_1
-A FW_QOS_DEV -j FW_QOS_DEV_1
EOF

sudo iptables-save -t mangle | grep -v ":FW_\| FW_\|COMMIT" | tee -a ${FIREWALLA_HIDDEN}/run/iptables/iptables
cat ${FIREWALLA_HIDDEN}/run/iptables/mangle >> ${FIREWALLA_HIDDEN}/run/iptables/iptables
echo 'COMMIT' >> ${FIREWALLA_HIDDEN}/run/iptables/iptables

sudo ip6tables-save -t mangle | grep -v ":FW_\| FW_\|COMMIT" | tee -a ${FIREWALLA_HIDDEN}/run/iptables/ip6tables
cat ${FIREWALLA_HIDDEN}/run/iptables/mangle >> ${FIREWALLA_HIDDEN}/run/iptables/ip6tables
echo 'COMMIT' >> ${FIREWALLA_HIDDEN}/run/iptables/ip6tables

if [[ $XT_TLS_SUPPORTED == "yes" ]]; then
  # existence of "-m tls" rules prevents kernel module from being updated, resotre with a tls-clean version first
  grep -v "\-m tls" ${FIREWALLA_HIDDEN}/run/iptables/iptables | sudo iptables-restore
  grep -v "\-m tls" ${FIREWALLA_HIDDEN}/run/iptables/ip6tables | sudo ip6tables-restore
  if lsmod | grep -w "xt_tls"; then
    sudo rmmod xt_tls
    if [[ $? -eq 0 ]]; then
      installTLSModule
    fi
  else
    installTLSModule
  fi
fi

sudo iptables-restore ${FIREWALLA_HIDDEN}/run/iptables/iptables
sudo ip6tables-restore ${FIREWALLA_HIDDEN}/run/iptables/ip6tables


# This will remove all customized ip sets that are not referred in iptables after initialization
for set in `sudo ipset list -name | egrep "^c_"`; do
  sudo ipset flush -! $set
done
# flush before destory, some ipsets may be referred in other ipsets and cannot be destroyed at the first run
for set in `sudo ipset list -name | egrep "^c_"`; do
  sudo ipset destroy -! $set
done

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  sudo iptables -w -N DOCKER-USER &>/dev/null
  sudo iptables -w -F DOCKER-USER
  sudo iptables -w -A DOCKER-USER -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
  sudo iptables -w -A DOCKER-USER -j RETURN
fi

if [[ $ALOG_SUPPORTED == "yes" ]]; then
  sudo mkdir -p /alog/
  sudo rm -r -f /alog/*
  sudo umount -l /alog
  sudo mount -t tmpfs -o size=20m tmpfs /alog
fi

if ip link show dev ifb0; then
  sudo tc filter delete dev ifb0 &> /dev/null || true
  sudo tc qdisc delete dev ifb0 root &> /dev/null || true
  sudo ip link set ifb0 up
  sudo tc filter del dev ifb0
  sudo tc qdisc replace dev ifb0 root handle 1: htb default 1
  # 50 is the default priority
  sudo tc class add dev ifb0 parent 1: classid 1:1 htb rate 3072mbit prio 4
  sudo tc qdisc replace dev ifb0 parent 1:1 fq_codel
fi

if ip link show dev ifb1; then
  sudo tc filter delete dev ifb1 &> /dev/null || true
  sudo tc qdisc delete dev ifb1 root &> /dev/null || true
  sudo ip link set ifb1 up
  sudo tc filter del dev ifb1
  sudo tc qdisc replace dev ifb1 root handle 1: htb default 1
  sudo tc class add dev ifb1 parent 1: classid 1:1 htb rate 3072mbit prio 4
  sudo tc qdisc replace dev ifb1 parent 1:1 fq_codel
fi

sudo ebtables -t nat --concurrent -N FW_PREROUTING -P RETURN &>/dev/null
sudo ebtables -t nat --concurrent -F FW_PREROUTING
sudo ebtables -t nat --concurrent -Lx PREROUTING | grep "^-j FW_PREROUTING" || sudo ebtables -t nat --concurrent -A PREROUTING -j FW_PREROUTING
