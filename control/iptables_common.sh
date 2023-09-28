#!/bin/bash

: "${FIREWALLA_HOME:=/home/pi/firewalla}"
: "${FIREWALLA_HIDDEN:=/home/pi/.firewalla}"

# shellcheck source=../platform/platform.sh
source "${FIREWALLA_HOME}/platform/platform.sh"

BLUE_HOLE_IP="198.51.100.100"

: "${FW_PROBABILITY:=0.9}"
: "${FW_QOS_PROBABILITY:=0.999}"

sudo which ipset &>/dev/null || sudo apt-get install -y ipset

mkdir -p "${FIREWALLA_HIDDEN}"/run/iptables

ipset4_file=${FIREWALLA_HIDDEN}/run/iptables/ipset4
ipset_file=${FIREWALLA_HIDDEN}/run/iptables/ipset

reset_ipset() {
cat << EOF > "$ipset4_file"
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

{
cat << EOF
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

cat "$ipset4_file"

# v4 specific entries
cat << EOF
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
sed -E "s/_(ip|domain|net)_set/_\1_set6/" "$ipset4_file" |
  sed "s/ inet / inet6 /"

# v6 specific entries
cat << EOF
create monitored_ip_set6 hash:ip family inet6 hashsize 1024 maxelem 65536
create match_all_set6 hash:net family inet6 maxelem 16

flush match_all_set6
add match_all_set6 ::/1
add match_all_set6 8000::/1

flush monitored_ip_set6

EOF
} > "$ipset_file"

sudo ipset restore -! --file "$ipset_file"
}


reset_ip_rules() {
  for fam in "-4" "-6"; do
    ip rule list |
      grep -vE "^(499|500|501|1001|2001|3000|3001|4001|5001|5002|5999|6001|7001|8001|9001|10001):" |
      cut -d: -f2- |
      while IFS= read -r line; do
        sudo ip $fam rule del $line
      done

    sudo ip $fam rule add pref 0 from all lookup local
    sudo ip $fam rule add pref 32766 from all lookup main
    sudo ip $fam rule add pref 32767 from all lookup default
  done
}


iptables_file=${FIREWALLA_HIDDEN}/run/iptables/iptables
ip6tables_file=${FIREWALLA_HIDDEN}/run/iptables/ip6tables

# ============= filter =============
filter_file=${FIREWALLA_HIDDEN}/run/iptables/filter

create_filter_table() {
cat << EOF > "$filter_file"
-N FW_OUTPUT
-A OUTPUT -j FW_OUTPUT

-N FW_FORWARD
-A FORWARD -j FW_FORWARD

# INPUT chain protection
-N FW_INPUT_ACCEPT
-A INPUT -j FW_INPUT_ACCEPT

-N FW_INPUT_DROP
-A INPUT -j FW_INPUT_DROP

-N FW_PLAIN_DROP
-A FW_PLAIN_DROP -p tcp -j REJECT --reject-with tcp-reset
-A FW_PLAIN_DROP -j CONNMARK --set-xmark 0x0/0x80000000
-A FW_PLAIN_DROP -j DROP

# alarm and drop, this should only be hit when rate limit is exceeded
-N FW_RATE_EXCEEDED_DROP
-A FW_RATE_EXCEEDED_DROP -m hashlimit --hashlimit-upto 1/minute --hashlimit-mode srcip --hashlimit-name fw_rate_exceeded_drop -j LOG --log-prefix "[FW_ALM]SEC=1 "
-A FW_RATE_EXCEEDED_DROP -j FW_PLAIN_DROP

# drop log chain
-N FW_DROP_LOG
-N FW_RATE_LIMITED_DROP
-A FW_RATE_LIMITED_DROP -j FW_DROP_LOG
-A FW_RATE_LIMITED_DROP -j FW_PLAIN_DROP
# multi protocol block chain
-N FW_DROP
# do not apply ACL enforcement for outbound connections of acl off devices/networks
-A FW_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
-A FW_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
-A FW_DROP -m hashlimit --hashlimit-upto 1000/second --hashlimit-mode srcip --hashlimit-name fw_drop -j FW_RATE_LIMITED_DROP
-A FW_DROP -j FW_RATE_EXCEEDED_DROP

# security drop log chain
-N FW_SEC_DROP_LOG
-N FW_SEC_RATE_LIMITED_DROP
-A FW_SEC_RATE_LIMITED_DROP -j FW_SEC_DROP_LOG
-A FW_SEC_RATE_LIMITED_DROP -j FW_PLAIN_DROP
# multi protocol block chain
-N FW_SEC_DROP
# do not apply ACL enforcement for outbound connections of acl off devices/networks
-A FW_SEC_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
-A FW_SEC_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
-A FW_SEC_DROP -m hashlimit --hashlimit-upto 1000/second --hashlimit-mode srcip --hashlimit-name fw_drop -j FW_SEC_RATE_LIMITED_DROP
-A FW_SEC_DROP -j FW_RATE_EXCEEDED_DROP

# tls drop log chain
-N FW_TLS_DROP_LOG
-N FW_TLS_RATE_LIMITED_DROP
-A FW_TLS_RATE_LIMITED_DROP -j FW_TLS_DROP_LOG
-A FW_TLS_RATE_LIMITED_DROP -j FW_PLAIN_DROP
# multi protocol block chain
-N FW_TLS_DROP
# do not apply ACL enforcement for outbound connections of acl off devices/networks
-A FW_TLS_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
-A FW_TLS_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
-A FW_TLS_DROP -m hashlimit --hashlimit-upto 1000/second --hashlimit-mode srcip --hashlimit-name fw_drop -j FW_TLS_RATE_LIMITED_DROP
-A FW_TLS_DROP -j FW_RATE_EXCEEDED_DROP

# security tls drop log chain
-N FW_SEC_TLS_DROP_LOG
-N FW_SEC_TLS_RATE_LIMITED_DROP
-A FW_SEC_TLS_RATE_LIMITED_DROP -j FW_SEC_TLS_DROP_LOG
-A FW_SEC_TLS_RATE_LIMITED_DROP -j FW_PLAIN_DROP
# multi protocol block chain
-N FW_SEC_TLS_DROP
# do not apply ACL enforcement for outbound connections of acl off devices/networks
-A FW_SEC_TLS_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
-A FW_SEC_TLS_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
-A FW_SEC_TLS_DROP -m hashlimit --hashlimit-upto 1000/second --hashlimit-mode srcip --hashlimit-name fw_drop -j FW_SEC_TLS_RATE_LIMITED_DROP
-A FW_SEC_TLS_DROP -j FW_RATE_EXCEEDED_DROP

# WAN inbound drop log chain
-N FW_WAN_IN_DROP_LOG
# WAN inbound drop chain
-N FW_WAN_IN_DROP
-A FW_WAN_IN_DROP -m limit --limit 1000/second -j FW_WAN_IN_DROP_LOG
-A FW_WAN_IN_DROP -j DROP

# log allow rule
-N FW_ACCEPT_LOG
-A FW_ACCEPT_LOG -m set --match-set monitored_net_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j LOG --log-prefix "[FW_ADT]A=A D=O CD=O "
-A FW_ACCEPT_LOG -m set ! --match-set monitored_net_set src,src -m set --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j LOG --log-prefix "[FW_ADT]A=A D=I CD=O "
-A FW_ACCEPT_LOG -m set --match-set monitored_net_set src,src -m set --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j LOG --log-prefix "[FW_ADT]A=A D=L CD=O "

# accept allow rules
-N FW_ACCEPT
-A FW_ACCEPT -m conntrack --ctstate NEW -m hashlimit --hashlimit-upto 1000/second --hashlimit-mode srcip --hashlimit-name fw_accept -j FW_ACCEPT_LOG
-A FW_ACCEPT -j CONNMARK --set-xmark 0x80000000/0x80000000
-A FW_ACCEPT -m conntrack --ctstate NEW --ctdir ORIGINAL -m set --match-set monitored_net_set src,src -m set ! --match-set monitored_net_set dst,dst -j LOG --log-prefix "[FW_ADT]A=C "
-A FW_ACCEPT -m conntrack --ctstate NEW --ctdir ORIGINAL -m set ! --match-set monitored_net_set src,src -m set --match-set monitored_net_set dst,dst -j LOG --log-prefix "[FW_ADT]A=C "
# match if FIN/RST flag is set, this is a complement in case TCP SYN is not matched during service restart
-A FW_ACCEPT -p tcp -m tcp ! --tcp-flags RST,FIN NONE -m conntrack --ctdir ORIGINAL -m set --match-set monitored_net_set src,src -m set ! --match-set monitored_net_set dst,dst -j LOG --log-prefix "[FW_ADT]A=C "
-A FW_ACCEPT -p tcp -m tcp ! --tcp-flags RST,FIN NONE -m conntrack --ctdir ORIGINAL -m set ! --match-set monitored_net_set src,src -m set --match-set monitored_net_set dst,dst -j LOG --log-prefix "[FW_ADT]A=C "
-A FW_ACCEPT -j ACCEPT

# add FW_ACCEPT_DEFAULT to the end of FORWARD chain
-N FW_ACCEPT_DEFAULT
-A FW_ACCEPT_DEFAULT -j CONNMARK --set-xmark 0x80000000/0x80000000
-A FW_ACCEPT_DEFAULT -m conntrack --ctstate NEW --ctdir ORIGINAL -m set --match-set monitored_net_set src,src -m set ! --match-set monitored_net_set dst,dst -j LOG --log-prefix "[FW_ADT]A=C "
-A FW_ACCEPT_DEFAULT -m conntrack --ctstate NEW --ctdir ORIGINAL -m set ! --match-set monitored_net_set src,src -m set --match-set monitored_net_set dst,dst -j LOG --log-prefix "[FW_ADT]A=C "
# match if FIN/RST flag is set, this is a complement in case TCP SYN is not matched during service restart
-A FW_ACCEPT -p tcp -m tcp ! --tcp-flags RST,FIN NONE -m conntrack --ctdir ORIGINAL -m set --match-set monitored_net_set src,src -m set ! --match-set monitored_net_set dst,dst -j LOG --log-prefix "[FW_ADT]A=C "
-A FW_ACCEPT -p tcp -m tcp ! --tcp-flags RST,FIN NONE -m conntrack --ctdir ORIGINAL -m set ! --match-set monitored_net_set src,src -m set --match-set monitored_net_set dst,dst -j LOG --log-prefix "[FW_ADT]A=C "
-A FW_ACCEPT_DEFAULT -j ACCEPT
-A FORWARD -j FW_ACCEPT_DEFAULT

# WAN outgoing INVALID state check
-N FW_WAN_INVALID_DROP

# drop INVALID packets
-A FW_FORWARD -m conntrack --ctstate INVALID -m set --match-set c_lan_set src,src -j FW_WAN_INVALID_DROP
# high percentage to bypass firewall rules if the packet belongs to an accepted flow
# set the highest bit in connmark by default, if the connection is blocked, the bit will be cleared before DROP
-A FW_FORWARD -m connbytes --connbytes 10 --connbytes-dir original --connbytes-mode packets -m connmark --mark 0x80000000/0x80000000 -m statistic --mode random --probability ${FW_PROBABILITY} -j ACCEPT
# only set once for NEW connection, for packets that may not fall into FW_ACCEPT_DEFAULT, this rule will set the bit, e.g., rules in FW_UPNP_ACCEPT created by miniupnpd
-A FW_FORWARD -m conntrack --ctstate NEW -j CONNMARK --set-xmark 0x80000000/0x80000000
# do not check reply packets of a inbound connection, this is mainly for upnp allow rule implementation, which only accepts packets in original direction
-A FW_FORWARD -m conntrack --ctdir REPLY -m set --match-set monitored_net_set src,src -m set ! --match-set monitored_net_set dst,dst -j ACCEPT

# initialize alarm chain
-N FW_ALARM
-A FW_FORWARD -m conntrack --ctdir ORIGINAL -j FW_ALARM
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
  echo '-A OUTPUT -j FW_BLOCK' >> "$filter_file"
fi

{
# save entries doesn't start with "FW_" first
sudo iptables-save -t filter | grep -vE "^:FW_| FW_|^COMMIT"
cat "$filter_file"

cat << EOF
# accept packet to DHCP client, sometimes the reply is a unicast packet and will not be considered as a reply packet of the original broadcast packet by conntrack module
-A FW_INPUT_ACCEPT -p udp --dport 68 --sport 67:68 -j ACCEPT
-A FW_INPUT_ACCEPT -p tcp --dport 68 --sport 67:68 -j ACCEPT

EOF
} > "$iptables_file"

{
sudo ip6tables-save -t filter | grep -vE "^:FW_| FW_|^COMMIT"

# not replacing monitored_net_set
sed -E '/monitored_net_set/!s/_(ip|domain|net)_set/_\1_set6/' "$filter_file"

cat << EOF
# accept traffic to DHCPv6 client, sometimes the reply is a unicast packet and will not be considered as a reply packet of the original broadcast packet by conntrack module
-A FW_INPUT_ACCEPT -p udp --dport 546 --sport 546:547 -j ACCEPT
-A FW_INPUT_ACCEPT -p tcp --dport 546 --sport 546:547 -j ACCEPT
# accept neighbor discovery packets
-A FW_INPUT_ACCEPT -p icmpv6 --icmpv6-type neighbour-solicitation -j ACCEPT
-A FW_INPUT_ACCEPT -p icmpv6 --icmpv6-type neighbour-advertisement -j ACCEPT
-A FW_INPUT_ACCEPT -p icmpv6 --icmpv6-type router-advertisement -j ACCEPT

EOF
} > "$ip6tables_file"

if [[ $XT_TLS_SUPPORTED == "yes" ]]; then
# these sets are not ipset and contain only domain names, use same set for both v4 & v6
# check /proc/net/xt_tls/hostset/sec_block_domain_set
cat << EOF >> "$iptables_file"
-A FW_FIREWALL_GLOBAL_BLOCK_HI -p tcp -m tls --tls-hostset sec_block_domain_set -j FW_SEC_TLS_DROP
-A FW_FIREWALL_GLOBAL_ALLOW -p tcp -m tls --tls-hostset allow_domain_set -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_BLOCK -p tcp -m tls --tls-hostset block_domain_set -j FW_TLS_DROP

EOF
cat << EOF >> "$ip6tables_file"
-A FW_FIREWALL_GLOBAL_BLOCK_HI -p tcp -m tls --tls-hostset sec_block_domain_set -j FW_SEC_TLS_DROP
-A FW_FIREWALL_GLOBAL_ALLOW -p tcp -m tls --tls-hostset allow_domain_set -j FW_ACCEPT
-A FW_FIREWALL_GLOBAL_BLOCK -p tcp -m tls --tls-hostset block_domain_set -j FW_TLS_DROP

EOF
fi


echo 'COMMIT' >> "$iptables_file"
echo 'COMMIT' >> "$ip6tables_file"
}



# ============= mangle =============
route_file=${FIREWALLA_HIDDEN}/run/iptables/route

create_route_chains() {
{
cat << EOF
# route chain
-N FW_RT

# route prefilter
-N FW_RT_FILTER

# only for outbound traffic marking
-A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -j FW_RT_FILTER

# filter out multicast, broadcast and non-DNS local packet,
-A FW_RT_FILTER -m pkttype --pkt-type broadcast -j RETURN
-A FW_RT_FILTER -m pkttype --pkt-type multicast -j RETURN
-A FW_RT_FILTER -p udp -m udp --dport 53 -m addrtype --dst-type LOCAL -j FW_RT
-A FW_RT_FILTER -p tcp -m tcp --dport 53 -m addrtype --dst-type LOCAL -j FW_RT
-A FW_RT_FILTER -m addrtype --dst-type LOCAL -j RETURN
-A FW_RT_FILTER -m addrtype --dst-type MULTICAST -j RETURN
-A FW_RT_FILTER -j FW_RT

EOF

for tag in "DEVICE" "TAG_DEVICE" "NETWORK" "TAG_NETWORK" "GLOBAL"; do
  echo "# $tag route chain"
  echo "-N FW_RT_$tag"
  for pri in {1..5}; do
    cat << EOF
-N FW_SRT_${tag}_$pri
-A FW_RT_${tag} -j FW_SRT_${tag}_$pri
-A FW_RT_${tag} -m mark ! --mark 0x0/0xffff -j RETURN
-N FW_RT_${tag}_$pri
-A FW_RT_${tag} -j FW_RT_${tag}_$pri
EOF
    if [[ $pri -ne 5 ]]; then
      echo "-A FW_RT_${tag} -m mark ! --mark 0x0/0xffff -j RETURN"
    fi
  done
  echo "-A FW_RT -j FW_RT_$tag"
  if [[ $tag != "GLOBAL" ]]; then
    echo "-A FW_RT -m mark ! --mark 0x0/0xffff -j RETURN"
  fi
done

echo ""
} > "$route_file"
}

qos_file=${FIREWALLA_HIDDEN}/run/iptables/qos

create_qos_chains() {
{
cat << EOF
# do not repeatedly traverse the FW_FORWARD chain in mangle table if the connection is already established before
-A FW_FORWARD -m connbytes --connbytes 4 --connbytes-dir original --connbytes-mode packets -m statistic --mode random --probability $FW_QOS_PROBABILITY -j RETURN

-N FW_QOS_SWITCH
-A FW_FORWARD -j FW_QOS_SWITCH
# bit 16 - 29 in connmark indicates if packet should be mirrored to ifb device in tc filter.
# the packet will be mirrored to ifb only if these bits are non-zero
-A FW_QOS_SWITCH -m set --match-set qos_off_set src,src -j CONNMARK --set-xmark 0x00000000/0x3fff0000
-A FW_QOS_SWITCH -m set --match-set qos_off_set dst,dst -j CONNMARK --set-xmark 0x00000000/0x3fff0000
# disable local to local qos
-A FW_QOS_SWITCH -m set --match-set c_lan_set src,src -m set --match-set c_lan_set dst,dst -j CONNMARK --set-xmark 0x00000000/0x3fff0000
-A FW_QOS_SWITCH -m set --match-set c_lan_set src,src -m set --match-set c_lan_set dst,dst -j RETURN

-N FW_QOS
-A FW_QOS_SWITCH -m set ! --match-set qos_off_set src,src -m set ! --match-set qos_off_set dst,dst -j FW_QOS

-N FW_QOS_GLOBAL_FALLBACK
-A FW_QOS -j FW_QOS_GLOBAL_FALLBACK

# look into the first reply packet, it should contain both upload and download QoS conntrack mark.
-N FW_QOS_LOG
# tentatively disable qos iptables log as it is not used for now
# -A FW_FORWARD -m connmark ! --mark 0x00000000/0x3fff0000 -m conntrack --ctdir REPLY -m connbytes --connbytes 1:1 --connbytes-dir reply --connbytes-mode packets -m hashlimit --hashlimit-upto 1000/second --hashlimit-mode srcip --hashlimit-name fw_qos -j FW_QOS_LOG

EOF

for tag in "GLOBAL" "NET_G" "NET" "DEV_G" "DEV"; do
  cat << EOF
# $tag qos connmark chain
-N FW_QOS_$tag
-A FW_QOS -j FW_QOS_$tag
EOF
  for pri in {5..1}; do
    cat << EOF
-N FW_QOS_${tag}_$pri
-A FW_QOS_${tag} -j FW_QOS_${tag}_$pri
EOF
  done
done

echo ""
} > "$qos_file"
}


create_tc_rules() {
  # ifb module is for QoS
  if [[ $IFB_SUPPORTED == "yes" ]]; then
    sudo modprobe ifb &> /dev/null || true
  else
    sudo rmmod ifb &> /dev/null || true
  fi

  if ip link show dev ifb0; then
    sudo tc filter delete dev ifb0 &> /dev/null || true
    sudo tc qdisc delete dev ifb0 root &> /dev/null || true
    sudo ip link set ifb0 up
    sudo tc filter del dev ifb0
    sudo tc qdisc replace dev ifb0 root handle 1: prio bands 9 priomap 4 7 7 7 4 7 1 1 4 4 4 4 4 4 4 4
    sudo tc qdisc add dev ifb0 parent 1:1 handle 2: htb # htb tree for high priority rate limit upload rules
    sudo tc qdisc add dev ifb0 parent 1:2 fq_codel
    sudo tc qdisc add dev ifb0 parent 1:3 cake unlimited triple-isolate no-split-gso conservative
    sudo tc qdisc add dev ifb0 parent 1:4 handle 3: htb # htb tree for regular priority rate limit upload rules
    sudo tc qdisc add dev ifb0 parent 1:5 fq_codel
    sudo tc qdisc add dev ifb0 parent 1:6 cake unlimited triple-isolate no-split-gso conservative
    sudo tc qdisc add dev ifb0 parent 1:7 handle 4: htb # htb tree for low priority rate limit upload rules
    sudo tc qdisc add dev ifb0 parent 1:8 fq_codel
    sudo tc qdisc add dev ifb0 parent 1:9 cake unlimited triple-isolate no-split-gso conservative
  fi

  if ip link show dev ifb1; then
    sudo tc filter delete dev ifb1 &> /dev/null || true
    sudo tc qdisc delete dev ifb1 root &> /dev/null || true
    sudo ip link set ifb1 up
    sudo tc filter del dev ifb1
    sudo tc qdisc replace dev ifb1 root handle 1: prio bands 9 priomap 4 7 7 7 4 7 1 1 4 4 4 4 4 4 4 4
    sudo tc qdisc add dev ifb1 parent 1:1 handle 2: htb # htb tree for high priority rate limit download rules
    sudo tc qdisc add dev ifb1 parent 1:2 fq_codel
    sudo tc qdisc add dev ifb1 parent 1:3 cake unlimited triple-isolate no-split-gso conservative
    sudo tc qdisc add dev ifb1 parent 1:4 handle 3: htb # htb tree for regular priority rate limit download rules
    sudo tc qdisc add dev ifb1 parent 1:5 fq_codel
    sudo tc qdisc add dev ifb1 parent 1:6 cake unlimited triple-isolate no-split-gso conservative
    sudo tc qdisc add dev ifb1 parent 1:7 handle 4: htb # htb tree for low priority rate limit download rules
    sudo tc qdisc add dev ifb1 parent 1:8 fq_codel
    sudo tc qdisc add dev ifb1 parent 1:9 cake unlimited triple-isolate no-split-gso conservative
  fi
}
