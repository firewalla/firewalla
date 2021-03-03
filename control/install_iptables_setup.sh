#!/bin/bash

if [[ -e /.dockerenv ]]; then
    #Disable iptables in docker
    /home/pi/firewalla/scripts/flush_iptables.sh
    exit
fi

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

BLACK_HOLE_IP="0.0.0.0"
BLUE_HOLE_IP="198.51.100.100"

: ${FW_PROBABILITY:=0.9}

sudo which ipset &>/dev/null || sudo apt-get install -y ipset

# bidirection
sudo ipset create block_ip_set hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create block_domain_set hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create block_net_set hash:net family inet hashsize 4096 maxelem 65536 &>/dev/null
sudo ipset create sec_block_ip_set hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create sec_block_domain_set hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create sec_block_net_set hash:net family inet hashsize 4096 maxelem 65536 &>/dev/null
# inbound
sudo ipset create block_ib_ip_set hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create block_ib_domain_set hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create block_ib_net_set hash:net family inet hashsize 4096 maxelem 65536 &>/dev/null
# outbound
sudo ipset create block_ob_ip_set hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create block_ob_domain_set hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create block_ob_net_set hash:net family inet hashsize 4096 maxelem 65536 &>/dev/null

# bidirection
sudo ipset create allow_ip_set hash:ip family inet hashsize 16384 maxelem 65536 &> /dev/null
sudo ipset create allow_domain_set hash:ip family inet hashsize 16384 maxelem 65536 &> /dev/null
sudo ipset create allow_net_set hash:net family inet hashsize 4096 maxelem 65536 &> /dev/null
# inbound
sudo ipset create allow_ib_ip_set hash:ip family inet hashsize 16384 maxelem 65536 &> /dev/null
sudo ipset create allow_ib_domain_set hash:ip family inet hashsize 16384 maxelem 65536 &> /dev/null
sudo ipset create allow_ib_net_set hash:net family inet hashsize 4096 maxelem 65536 &> /dev/null
# outbound
sudo ipset create allow_ob_ip_set hash:ip family inet hashsize 16384 maxelem 65536 &> /dev/null
sudo ipset create allow_ob_domain_set hash:ip family inet hashsize 16384 maxelem 65536 &> /dev/null
sudo ipset create allow_ob_net_set hash:net family inet hashsize 4096 maxelem 65536 &> /dev/null

sudo ipset create acl_off_mac_set hash:mac &>/dev/null
sudo ipset create acl_off_set list:set &>/dev/null
sudo ipset create monitored_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create no_dns_caching_mac_set hash:mac &>/dev/null
sudo ipset create no_dns_caching_set list:set &>/dev/null
sudo ipset create monitored_net_set list:set &>/dev/null

sudo ipset create qos_off_mac_set hash:mac &>/dev/null
sudo ipset create qos_off_set list:set &>/dev/null

sudo ipset create match_all_set4 hash:net maxelem 16 &> /dev/null

# This is to ensure all ipsets are empty when initializing
sudo ipset flush block_ip_set
sudo ipset flush block_domain_set
sudo ipset flush block_net_set
sudo ipset flush sec_block_ip_set
sudo ipset flush sec_block_domain_set
sudo ipset flush sec_block_net_set
sudo ipset flush block_ib_ip_set
sudo ipset flush block_ib_domain_set
sudo ipset flush block_ib_net_set
sudo ipset flush block_ob_ip_set
sudo ipset flush block_ob_domain_set
sudo ipset flush block_ob_net_set
sudo ipset flush allow_ip_set
sudo ipset flush allow_domain_set
sudo ipset flush allow_net_set
sudo ipset flush allow_ib_ip_set
sudo ipset flush allow_ib_domain_set
sudo ipset flush allow_ib_net_set
sudo ipset flush allow_ob_ip_set
sudo ipset flush allow_ob_domain_set
sudo ipset flush allow_ob_net_set

sudo ipset flush acl_off_mac_set
sudo ipset flush acl_off_set
sudo ipset add -! acl_off_set acl_off_mac_set

sudo ipset flush monitored_ip_set

sudo ipset flush no_dns_caching_mac_set
sudo ipset flush no_dns_caching_set
sudo ipset add -! no_dns_caching_set no_dns_caching_mac_set
sudo ipset flush monitored_net_set

sudo ipset flush qos_off_mac_set
sudo ipset flush qos_off_set
sudo ipset add -! qos_off_set qos_off_mac_set

sudo ipset flush match_all_set4
sudo ipset add -! match_all_set4 0.0.0.0/1
sudo ipset add -! match_all_set4 128.0.0.0/1

sudo ipset add -! block_ip_set $BLUE_HOLE_IP

if [[ $(uname -m) != "x86_64" ]]; then
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

# destroy chains in previous version, these should be removed in next release
sudo iptables -w -F FW_BLOCK &>/dev/null && sudo iptables -w -X FW_BLOCK
sudo iptables -w -t nat -F FW_NAT_BLOCK &>/dev/null && sudo iptables -w -t nat -X FW_NAT_BLOCK
sudo iptables -w -F FW_WHITELIST_PREROUTE &>/dev/null && sudo iptables -w -X FW_WHITELIST_PREROUTE
sudo iptables -w -F FW_WHITELIST &>/dev/null && sudo iptables -w -X FW_WHITELIST
sudo iptables -w -t nat -F FW_NAT_WHITELIST_PREROUTE &>/dev/null && sudo iptables -w -t nat -X FW_NAT_WHITELIST_PREROUTE
sudo iptables -w -t nat -F FW_NAT_WHITELIST &>/dev/null && sudo iptables -w -t nat -X FW_NAT_WHITELIST
sudo ip6tables -w -F FW_BLOCK &>/dev/null && sudo ip6tables -w -X FW_BLOCK
sudo ip6tables -w -t nat -F FW_NAT_BLOCK &>/dev/null && sudo ip6tables -w -t nat -X FW_NAT_BLOCK
sudo ip6tables -w -F FW_WHITELIST_PREROUTE &>/dev/null && sudo ip6tables -w -X FW_WHITELIST_PREROUTE
sudo ip6tables -w -F FW_WHITELIST &>/dev/null && sudo ip6tables -w -X FW_WHITELIST
sudo ip6tables -w -t nat -F FW_NAT_WHITELIST_PREROUTE &>/dev/null && sudo ip6tables -w -t nat -X FW_NAT_WHITELIST_PREROUTE
sudo ip6tables -w -t nat -F FW_NAT_WHITELIST &>/dev/null && sudo ip6tables -w -t nat -X FW_NAT_WHITELIST


rules_to_remove=`ip rule list | grep -v -e "^501:" | grep -v -e "^1001:" | grep -v -e "^2001:" | grep -v -e "^3000:" | grep -v -e "^3001:" | grep -v -e "^4001:" | grep -v -e "^5001:" | grep -v -e "^5002:" | grep -v -e "^6001:" | grep -v -e "^7001:" | grep -v -e "^8001:" | grep -v -e "^9001:" | grep -v -e "^10001:" | cut -d: -f2-`;
while IFS= read -r line; do
  sudo ip rule del $line
done <<< "$rules_to_remove"
sudo ip rule add pref 0 from all lookup local
sudo ip rule add pref 32766 from all lookup main
sudo ip rule add pref 32767 from all lookup default

sudo iptables -w -N FW_FORWARD &>/dev/null

sudo iptables -w -C FORWARD -j FW_FORWARD &>/dev/null || sudo iptables -w -A FORWARD -j FW_FORWARD

# INPUT chain protection
sudo iptables -w -N FW_INPUT_ACCEPT &> /dev/null
sudo iptables -w -F FW_INPUT_ACCEPT
sudo iptables -w -C INPUT -j FW_INPUT_ACCEPT &>/dev/null || sudo iptables -w -A INPUT -j FW_INPUT_ACCEPT

# accept packet to DHCP client, sometimes the reply is a unicast packet and will not be considered as a reply packet of the original broadcast packet by conntrack module
sudo iptables -w -A FW_INPUT_ACCEPT -p udp --dport 68 --sport 67:68 -j ACCEPT
sudo iptables -w -A FW_INPUT_ACCEPT -p tcp --dport 68 --sport 67:68 -j ACCEPT

sudo iptables -w -N FW_INPUT_DROP &> /dev/null
sudo iptables -w -F FW_INPUT_DROP
sudo iptables -w -C INPUT -j FW_INPUT_DROP &>/dev/null || sudo iptables -w -A INPUT -j FW_INPUT_DROP

# multi protocol block chain
sudo iptables -w -N FW_DROP &>/dev/null
sudo iptables -w -F FW_DROP
# do not apply ACL enforcement for outbound connections of acl off devices/networks
sudo iptables -w -A FW_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
sudo iptables -w -A FW_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
sudo iptables -w -A FW_DROP -p tcp -j REJECT --reject-with tcp-reset
sudo iptables -w -A FW_DROP -j DROP

# multi protocol block chain
sudo iptables -w -N FW_SEC_DROP &>/dev/null
sudo iptables -w -F FW_SEC_DROP
# do not apply ACL enforcement for outbound connections of acl off devices/networks
sudo iptables -w -A FW_SEC_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
sudo iptables -w -A FW_SEC_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
sudo iptables -w -A FW_SEC_DROP -p tcp -j REJECT --reject-with tcp-reset
sudo iptables -w -A FW_SEC_DROP -j DROP

# add FW_ACCEPT to the end of FORWARD chain
sudo iptables -w -N FW_ACCEPT &>/dev/null
sudo iptables -w -F FW_ACCEPT
sudo iptables -w -A FW_ACCEPT -j CONNMARK --set-xmark 0x80000000/0x80000000
sudo iptables -w -A FW_ACCEPT -j ACCEPT
sudo iptables -w -C FORWARD -j FW_ACCEPT &>/dev/null || sudo iptables -w -A FORWARD -j FW_ACCEPT

# initialize vpn client kill switch chain
sudo iptables -w -N FW_VPN_CLIENT &>/dev/null
sudo iptables -w -F FW_VPN_CLIENT
# randomly bypass vpn client kill switch check for previous accepted connection to reduce softirq overhead
sudo iptables -w -A FW_VPN_CLIENT -m connmark --mark 0x80000000/0x80000000 -m statistic --mode random --probability $FW_PROBABILITY -j RETURN
sudo iptable -w -C FW_FORWARD -j FW_VPN_CLIENT &> /dev/null || sudo iptables -w -A FW_FORWARD -j FW_VPN_CLIENT

# initialize firewall high priority chain
sudo iptables -w -N FW_FIREWALL_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_HI
sudo iptables -w -C FW_FORWARD -j FW_FIREWALL_HI &>/dev/null || sudo iptables -w -A FW_FORWARD -j FW_FIREWALL_HI
# 90 percent to bypass firewall if the packet belongs to a previously accepted flow
sudo iptables -w -A FW_FIREWALL_HI -m connmark --mark 0x80000000/0x80000000 -m statistic --mode random --probability $FW_PROBABILITY -j ACCEPT
sudo iptables -w -A FW_FIREWALL_HI -j CONNMARK --set-xmark 0x00000000/0x80000000
# device high priority block/allow chains
sudo iptables -w -N FW_FIREWALL_DEV_ALLOW_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_DEV_ALLOW_HI
sudo iptables -w -A FW_FIREWALL_HI -j FW_FIREWALL_DEV_ALLOW_HI
sudo iptables -w -N FW_FIREWALL_DEV_BLOCK_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_DEV_BLOCK_HI
sudo iptables -w -A FW_FIREWALL_HI -j FW_FIREWALL_DEV_BLOCK_HI
# device group high priority block/allow chains
sudo iptables -w -N FW_FIREWALL_DEV_G_ALLOW_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_DEV_G_ALLOW_HI
sudo iptables -w -A FW_FIREWALL_HI -j FW_FIREWALL_DEV_G_ALLOW_HI
sudo iptables -w -N FW_FIREWALL_DEV_G_BLOCK_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_DEV_G_BLOCK_HI
sudo iptables -w -A FW_FIREWALL_HI -j FW_FIREWALL_DEV_G_BLOCK_HI
# network high priority block/allow chains
sudo iptables -w -N FW_FIREWALL_NET_ALLOW_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_NET_ALLOW_HI
sudo iptables -w -A FW_FIREWALL_HI -j FW_FIREWALL_NET_ALLOW_HI
sudo iptables -w -N FW_FIREWALL_NET_BLOCK_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_NET_BLOCK_HI
sudo iptables -w -A FW_FIREWALL_HI -j FW_FIREWALL_NET_BLOCK_HI
# network group high priority block/allow chains
sudo iptables -w -N FW_FIREWALL_NET_G_ALLOW_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_NET_G_ALLOW_HI
sudo iptables -w -A FW_FIREWALL_HI -j FW_FIREWALL_NET_G_ALLOW_HI
sudo iptables -w -N FW_FIREWALL_NET_G_BLOCK_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_NET_G_BLOCK_HI
sudo iptables -w -A FW_FIREWALL_HI -j FW_FIREWALL_NET_G_BLOCK_HI
# global high priority block/allow chains
sudo iptables -w -N FW_FIREWALL_GLOBAL_ALLOW_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_GLOBAL_ALLOW_HI
sudo iptables -w -A FW_FIREWALL_HI -j FW_FIREWALL_GLOBAL_ALLOW_HI
sudo iptables -w -N FW_FIREWALL_GLOBAL_BLOCK_HI &> /dev/null
sudo iptables -w -F FW_FIREWALL_GLOBAL_BLOCK_HI
sudo iptables -w -A FW_FIREWALL_HI -j FW_FIREWALL_GLOBAL_BLOCK_HI

# initialize firewall regular chain
sudo iptables -w -N FW_FIREWALL &> /dev/null
sudo iptables -w -F FW_FIREWALL
sudo iptables -w -C FW_FORWARD -j FW_FIREWALL &>/dev/null || sudo iptables -w -A FW_FORWARD -j FW_FIREWALL
# 90 percent to bypass firewall if the packet belongs to a previously accepted flow
sudo iptables -w -A FW_FIREWALL -m connmark --mark 0x80000000/0x80000000 -m statistic --mode random --probability $FW_PROBABILITY -j ACCEPT
sudo iptables -w -A FW_FIREWALL -j CONNMARK --set-xmark 0x00000000/0x80000000
# device block/allow chains
sudo iptables -w -N FW_FIREWALL_DEV_ALLOW &> /dev/null
sudo iptables -w -F FW_FIREWALL_DEV_ALLOW
sudo iptables -w -A FW_FIREWALL -j FW_FIREWALL_DEV_ALLOW
sudo iptables -w -N FW_FIREWALL_DEV_BLOCK &> /dev/null
sudo iptables -w -F FW_FIREWALL_DEV_BLOCK
sudo iptables -w -A FW_FIREWALL -j FW_FIREWALL_DEV_BLOCK
# device group block/allow chains
sudo iptables -w -N FW_FIREWALL_DEV_G_ALLOW &> /dev/null
sudo iptables -w -F FW_FIREWALL_DEV_G_ALLOW
sudo iptables -w -A FW_FIREWALL -j FW_FIREWALL_DEV_G_ALLOW
sudo iptables -w -N FW_FIREWALL_DEV_G_BLOCK &> /dev/null
sudo iptables -w -F FW_FIREWALL_DEV_G_BLOCK
sudo iptables -w -A FW_FIREWALL -j FW_FIREWALL_DEV_G_BLOCK
# network block/allow chains
sudo iptables -w -N FW_FIREWALL_NET_ALLOW &> /dev/null
sudo iptables -w -F FW_FIREWALL_NET_ALLOW
sudo iptables -w -A FW_FIREWALL -j FW_FIREWALL_NET_ALLOW
sudo iptables -w -N FW_FIREWALL_NET_BLOCK &> /dev/null
sudo iptables -w -F FW_FIREWALL_NET_BLOCK
sudo iptables -w -A FW_FIREWALL -j FW_FIREWALL_NET_BLOCK
# network group block/allow chains
sudo iptables -w -N FW_FIREWALL_NET_G_ALLOW &> /dev/null
sudo iptables -w -F FW_FIREWALL_NET_G_ALLOW
sudo iptables -w -A FW_FIREWALL -j FW_FIREWALL_NET_G_ALLOW
sudo iptables -w -N FW_FIREWALL_NET_G_BLOCK &> /dev/null
sudo iptables -w -F FW_FIREWALL_NET_G_BLOCK
sudo iptables -w -A FW_FIREWALL -j FW_FIREWALL_NET_G_BLOCK
# global block/allow chains
sudo iptables -w -N FW_FIREWALL_GLOBAL_ALLOW &> /dev/null
sudo iptables -w -F FW_FIREWALL_GLOBAL_ALLOW
sudo iptables -w -A FW_FIREWALL -j FW_FIREWALL_GLOBAL_ALLOW
sudo iptables -w -N FW_FIREWALL_GLOBAL_BLOCK &> /dev/null
sudo iptables -w -F FW_FIREWALL_GLOBAL_BLOCK
sudo iptables -w -A FW_FIREWALL -j FW_FIREWALL_GLOBAL_BLOCK

# bidirection
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ip_set src -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ip_set dst -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_domain_set src -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_domain_set dst -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_net_set src -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_net_set dst -j FW_ACCEPT
# inbound
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_ip_set src -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_ip_set dst -m conntrack --ctdir REPLY -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_domain_set src -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_domain_set dst -m conntrack --ctdir REPLY -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_net_set src -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_net_set dst -m conntrack --ctdir REPLY -j FW_ACCEPT
# outbound
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_ip_set src -m conntrack --ctdir REPLY -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_ip_set dst -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_domain_set src -m conntrack --ctdir REPLY -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_domain_set dst -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_net_set src -m conntrack --ctdir REPLY -j FW_ACCEPT
sudo iptables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_net_set dst -m conntrack --ctdir ORIGINAL -j FW_ACCEPT

# bidirection
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ip_set src -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ip_set dst -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_domain_set src -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_domain_set dst -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_net_set src -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_net_set dst -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_ip_set src -j FW_SEC_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_ip_set dst -j FW_SEC_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_domain_set src -j FW_SEC_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_domain_set dst -j FW_SEC_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_net_set src -j FW_SEC_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_net_set dst -j FW_SEC_DROP
# inbound
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_ip_set src -m conntrack --ctdir ORIGINAL -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_ip_set dst -m conntrack --ctdir REPLY -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_domain_set src -m conntrack --ctdir ORIGINAL -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_domain_set dst -m conntrack --ctdir REPLY -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_net_set src -m conntrack --ctdir ORIGINAL -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_net_set dst -m conntrack --ctdir REPLY -j FW_DROP
# outbound
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_ip_set src -m conntrack --ctdir REPLY -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_ip_set dst -m conntrack --ctdir ORIGINAL -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_domain_set src -m conntrack --ctdir REPLY -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_domain_set dst -m conntrack --ctdir ORIGINAL -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_net_set src -m conntrack --ctdir REPLY -j FW_DROP
sudo iptables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_net_set dst -m conntrack --ctdir ORIGINAL -j FW_DROP

sudo iptables -w -t nat -N FW_PREROUTING &> /dev/null

sudo iptables -w -t nat -C PREROUTING -j FW_PREROUTING &>/dev/null || sudo iptables -w -t nat -A PREROUTING -j FW_PREROUTING

sudo iptables -w -t nat -N FW_POSTROUTING &> /dev/null

sudo iptables -w -t nat -C POSTROUTING -j FW_POSTROUTING &>/dev/null || sudo iptables -w -t nat -A POSTROUTING -j FW_POSTROUTING

# create POSTROUTING VPN chain
sudo iptables -w -t nat -N FW_POSTROUTING_OPENVPN &> /dev/null
sudo iptables -w -t nat -F FW_POSTROUTING_OPENVPN
sudo iptables -w -t nat -C FW_POSTROUTING -j FW_POSTROUTING_OPENVPN &> /dev/null || sudo iptables -w -t nat -A FW_POSTROUTING -j FW_POSTROUTING_OPENVPN

# create POSTROUTING WIREGUARD chain
sudo iptables -w -t nat -N FW_POSTROUTING_WIREGUARD &> /dev/null
sudo iptables -w -t nat -F FW_POSTROUTING_WIREGUARD
sudo iptables -w -t nat -C FW_POSTROUTING -j FW_POSTROUTING_WIREGUARD &> /dev/null || sudo iptables -w -t nat -A FW_POSTROUTING -j FW_POSTROUTING_WIREGUARD

# nat POSTROUTING port forward hairpin chain
sudo iptables -w -t nat -N FW_POSTROUTING_PORT_FORWARD &> /dev/null
sudo iptables -w -t nat -F FW_POSTROUTING_PORT_FORWARD
sudo iptables -w -t nat -C FW_POSTROUTING -m conntrack --ctstate DNAT -j FW_POSTROUTING_PORT_FORWARD &> /dev/null || sudo iptables -w -t nat -A FW_POSTROUTING -m conntrack --ctstate DNAT -j FW_POSTROUTING_PORT_FORWARD
sudo iptables -w -t nat -N FW_POSTROUTING_HAIRPIN &> /dev/null
sudo iptables -w -t nat -F FW_POSTROUTING_HAIRPIN
# create POSTROUTING dmz host chain and add it to the end of port forward chain
sudo iptables -w -t nat -N FW_POSTROUTING_DMZ_HOST &> /dev/null
sudo iptables -w -t nat -F FW_POSTROUTING_DMZ_HOST
sudo iptables -w -t nat -A FW_POSTROUTING_PORT_FORWARD -j FW_POSTROUTING_DMZ_HOST

# nat blackhole 8888
sudo iptables -w -t nat -N FW_NAT_HOLE &>/dev/null
sudo iptables -w -t nat -F FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -A FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -A FW_NAT_HOLE -j RETURN


# a special chain mainly for red/blue to redirect VPN connection on overlay IP to primary IP if two subnets are the same
sudo iptables -w -t nat -N FW_PREROUTING_VPN_OVERLAY &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_VPN_OVERLAY
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_VPN_OVERLAY &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_VPN_OVERLAY

# VPN client chain to mark VPN client inbound connection
sudo iptables -w -t nat -N FW_PREROUTING_VC_INBOUND &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_VC_INBOUND &> /dev/null
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_VC_INBOUND &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_VC_INBOUND

# DNAT related chain comes first
# create port forward chain in PREROUTING, this is used in ipv4 only
sudo iptables -w -t nat -N FW_PREROUTING_EXT_IP &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_EXT_IP
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_EXT_IP &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_EXT_IP
sudo iptables -w -t nat -N FW_PREROUTING_PORT_FORWARD &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_PORT_FORWARD
# create dmz host chain, this is used in ipv4 only
sudo iptables -w -t nat -N FW_PREROUTING_DMZ_HOST &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DMZ_HOST
sudo iptables -w -t nat -A FW_PREROUTING_DMZ_HOST -p tcp -m multiport --dports 22,53,8853,8837,8833,8834,8835 -j RETURN
sudo iptables -w -t nat -A FW_PREROUTING_DMZ_HOST -p udp -m multiport --dports 53,8853 -j RETURN
# add dmz host chain to the end of port forward chain
sudo iptables -w -t nat -A FW_PREROUTING_PORT_FORWARD -j FW_PREROUTING_DMZ_HOST

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  sudo iptables -w -t nat -A FW_PREROUTING_DMZ_HOST -j FR_WIREGUARD &> /dev/null || true
fi

# create vpn client dns redirect chain in FW_PREROUTING
sudo iptables -w -t nat -N FW_PREROUTING_DNS_VPN_CLIENT &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_VPN_CLIENT
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT

# initialize nat dns fallback chain, which is traversed if acl is off
sudo iptables -w -t nat -N FW_PREROUTING_DNS_FALLBACK &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_FALLBACK

# initialize nat bypass chain after port forward and vpn client
sudo iptables -w -t nat -N FW_NAT_BYPASS &> /dev/null
sudo iptables -w -t nat -F FW_NAT_BYPASS
sudo iptables -w -t nat -C FW_PREROUTING -j FW_NAT_BYPASS &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_NAT_BYPASS
# jump to DNS_FALLBACK for acl off devices/networks
sudo iptables -w -t nat -A FW_NAT_BYPASS -m set --match-set acl_off_set src,src -j FW_PREROUTING_DNS_FALLBACK
# jump to DNS_FALLBACK for dns boost off devices/networks
sudo iptables -w -t nat -A FW_NAT_BYPASS -m set --match-set no_dns_caching_set src,src -j FW_PREROUTING_DNS_FALLBACK

# create regular dns redirect chain in FW_PREROUTING
sudo iptables -w -t nat -N FW_PREROUTING_DNS_VPN &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_VPN
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
sudo iptables -w -t nat -N FW_PREROUTING_DNS_WG &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_WG
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_WG &> /dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_WG
sudo iptables -w -t nat -N FW_PREROUTING_DNS_DEFAULT &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_DEFAULT
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT
# traverse DNS fallback chain if default chain is not taken
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_FALLBACK &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_FALLBACK


if [[ -e /.dockerenv ]]; then
  sudo iptables -w -C OUTPUT -j FW_BLOCK &>/dev/null || sudo iptables -w -A OUTPUT -j FW_BLOCK
fi

if [[ -e /sbin/ip6tables ]]; then
  # bidirection
  sudo ipset create block_ip_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create block_domain_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create block_net_set6 hash:net family inet6 hashsize 4096 maxelem 65536 &>/dev/null
  sudo ipset create sec_block_ip_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create sec_block_domain_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create sec_block_net_set6 hash:net family inet6 hashsize 4096 maxelem 65536 &>/dev/null
  # inbound
  sudo ipset create block_ib_ip_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create block_ib_domain_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create block_ib_net_set6 hash:net family inet6 hashsize 4096 maxelem 65536 &>/dev/null
  # outbound
  sudo ipset create block_ob_ip_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create block_ob_domain_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create block_ob_net_set6 hash:net family inet6 hashsize 4096 maxelem 65536 &>/dev/null

  # bidirection
  sudo ipset create allow_ip_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create allow_domain_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create allow_net_set6 hash:net family inet6 hashsize 4096 maxelem 65536 &>/dev/null
  # inbound
  sudo ipset create allow_ib_ip_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create allow_ib_domain_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create allow_ib_net_set6 hash:net family inet6 hashsize 4096 maxelem 65536 &>/dev/null
  # outbound
  sudo ipset create allow_ob_ip_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create allow_ob_domain_set6 hash:ip family inet6 hashsize 16384 maxelem 65536 &>/dev/null
  sudo ipset create allow_ob_net_set6 hash:net family inet6 hashsize 4096 maxelem 65536 &>/dev/null

  sudo ipset create monitored_ip_set6 hash:ip family inet6 hashsize 1024 maxelem 65536 &>/dev/null

  sudo ipset create match_all_set6 hash:net family inet6 maxelem 16 &> /dev/null

  sudo ipset flush block_ip_set6
  sudo ipset flush block_domain_set6
  sudo ipset flush block_net_set6
  sudo ipset flush sec_block_ip_set6
  sudo ipset flush sec_block_domain_set6
  sudo ipset flush sec_block_net_set6
  sudo ipset flush block_ib_ip_set6
  sudo ipset flush block_ib_domain_set6
  sudo ipset flush block_ib_net_set6
  sudo ipset flush block_ob_ip_set6
  sudo ipset flush block_ob_domain_set6
  sudo ipset flush block_ob_net_set6
  sudo ipset flush allow_ip_set6
  sudo ipset flush allow_domain_set6
  sudo ipset flush allow_net_set6
  sudo ipset flush allow_ib_ip_set6
  sudo ipset flush allow_ib_domain_set6
  sudo ipset flush allow_ib_net_set6
  sudo ipset flush allow_ob_ip_set6
  sudo ipset flush allow_ob_domain_set6
  sudo ipset flush allow_ob_net_set6

  sudo ipset flush match_all_set6
  sudo ipset add -! match_all_set6 ::/1
  sudo ipset add -! match_all_set6 8000::/1

  sudo ipset flush monitored_ip_set6

  sudo ip6tables -w -N FW_FORWARD &>/dev/null
  
  sudo ip6tables -w -C FORWARD -j FW_FORWARD &>/dev/null || sudo ip6tables -w -A FORWARD -j FW_FORWARD

  # INPUT chain protection
  sudo ip6tables -w -N FW_INPUT_ACCEPT &> /dev/null
  sudo ip6tables -w -F FW_INPUT_ACCEPT
  sudo ip6tables -w -C INPUT -j FW_INPUT_ACCEPT &>/dev/null || sudo ip6tables -w -A INPUT -j FW_INPUT_ACCEPT

  # accept traffic to DHCPv6 client, sometimes the reply is a unicast packet and will not be considered as a reply packet of the original broadcast packet by conntrack module
  sudo ip6tables -w -A FW_INPUT_ACCEPT -p udp --dport 546 --sport 546:547 -j ACCEPT
  sudo ip6tables -w -A FW_INPUT_ACCEPT -p tcp --dport 546 --sport 546:547 -j ACCEPT
  # accept neighbor discovery packets
  sudo ip6tables -w -A FW_INPUT_ACCEPT -p icmpv6 --icmpv6-type neighbour-solicitation -j ACCEPT
  sudo ip6tables -w -A FW_INPUT_ACCEPT -p icmpv6 --icmpv6-type neighbour-advertisement -j ACCEPT
  sudo ip6tables -w -A FW_INPUT_ACCEPT -p icmpv6 --icmpv6-type router-advertisement -j ACCEPT

  sudo ip6tables -w -N FW_INPUT_DROP &> /dev/null
  sudo ip6tables -w -F FW_INPUT_DROP
  sudo ip6tables -w -C INPUT -j FW_INPUT_DROP &>/dev/null || sudo ip6tables -w -A INPUT -j FW_INPUT_DROP

  # multi protocol block chain
  sudo ip6tables -w -N FW_DROP &>/dev/null
  sudo ip6tables -w -F FW_DROP
  # do not apply ACL enforcement for outbound connections of acl off devices/networks
  sudo ip6tables -w -A FW_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
  sudo ip6tables -w -A FW_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
  sudo ip6tables -w -A FW_DROP -p tcp -j REJECT --reject-with tcp-reset
  sudo ip6tables -w -A FW_DROP -j DROP

  sudo ip6tables -w -N FW_SEC_DROP &>/dev/null
  sudo ip6tables -w -F FW_SEC_DROP
  # do not apply ACL enforcement for outbound connections of acl off devices/networks
  sudo ip6tables -w -A FW_SEC_DROP -m set --match-set acl_off_set src,src -m set ! --match-set monitored_net_set dst,dst -m conntrack --ctdir ORIGINAL -j RETURN
  sudo ip6tables -w -A FW_SEC_DROP -m set --match-set acl_off_set dst,dst -m set ! --match-set monitored_net_set src,src -m conntrack --ctdir REPLY -j RETURN
  sudo ip6tables -w -A FW_SEC_DROP -p tcp -j REJECT --reject-with tcp-reset
  sudo ip6tables -w -A FW_SEC_DROP -j DROP

  # add FW_ACCEPT to the end of FORWARD chain
  sudo ip6tables -w -N FW_ACCEPT &>/dev/null
  sudo ip6tables -w -F FW_ACCEPT
  sudo ip6tables -w -A FW_ACCEPT -j CONNMARK --set-xmark 0x80000000/0x80000000
  sudo ip6tables -w -A FW_ACCEPT -j ACCEPT
  sudo ip6tables -w -C FORWARD -j FW_ACCEPT &>/dev/null || sudo ip6tables -w -A FORWARD -j FW_ACCEPT

  # initialize firewall high priority chain
  sudo ip6tables -w -N FW_FIREWALL_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_HI
  sudo ip6tables -w -C FW_FORWARD -j FW_FIREWALL_HI &>/dev/null || sudo ip6tables -w -A FW_FORWARD -j FW_FIREWALL_HI
  # 90 percent to bypass firewall if the packet belongs to a previously accepted flow
  sudo ip6tables -w -A FW_FIREWALL_HI -m connmark --mark 0x80000000/0x80000000 -m statistic --mode random --probability $FW_PROBABILITY -j ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_HI -j CONNMARK --set-xmark 0x00000000/0x80000000
  # device high priority block/allow chains
  sudo ip6tables -w -N FW_FIREWALL_DEV_ALLOW_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_DEV_ALLOW_HI
  sudo ip6tables -w -A FW_FIREWALL_HI -j FW_FIREWALL_DEV_ALLOW_HI
  sudo ip6tables -w -N FW_FIREWALL_DEV_BLOCK_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_DEV_BLOCK_HI
  sudo ip6tables -w -A FW_FIREWALL_HI -j FW_FIREWALL_DEV_BLOCK_HI
  # device group high priority block/allow chains
  sudo ip6tables -w -N FW_FIREWALL_DEV_G_ALLOW_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_DEV_G_ALLOW_HI
  sudo ip6tables -w -A FW_FIREWALL_HI -j FW_FIREWALL_DEV_G_ALLOW_HI
  sudo ip6tables -w -N FW_FIREWALL_DEV_G_BLOCK_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_DEV_G_BLOCK_HI
  sudo ip6tables -w -A FW_FIREWALL_HI -j FW_FIREWALL_DEV_G_BLOCK_HI
  # network high priority block/allow chains
  sudo ip6tables -w -N FW_FIREWALL_NET_ALLOW_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_NET_ALLOW_HI
  sudo ip6tables -w -A FW_FIREWALL_HI -j FW_FIREWALL_NET_ALLOW_HI
  sudo ip6tables -w -N FW_FIREWALL_NET_BLOCK_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_NET_BLOCK_HI
  sudo ip6tables -w -A FW_FIREWALL_HI -j FW_FIREWALL_NET_BLOCK_HI
  # network group high priority block/allow chains
  sudo ip6tables -w -N FW_FIREWALL_NET_G_ALLOW_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_NET_G_ALLOW_HI
  sudo ip6tables -w -A FW_FIREWALL_HI -j FW_FIREWALL_NET_G_ALLOW_HI
  sudo ip6tables -w -N FW_FIREWALL_NET_G_BLOCK_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_NET_G_BLOCK_HI
  sudo ip6tables -w -A FW_FIREWALL_HI -j FW_FIREWALL_NET_G_BLOCK_HI
  # global high priority block/allow chains
  sudo ip6tables -w -N FW_FIREWALL_GLOBAL_ALLOW_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_GLOBAL_ALLOW_HI
  sudo ip6tables -w -A FW_FIREWALL_HI -j FW_FIREWALL_GLOBAL_ALLOW_HI
  sudo ip6tables -w -N FW_FIREWALL_GLOBAL_BLOCK_HI &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_GLOBAL_BLOCK_HI
  sudo ip6tables -w -A FW_FIREWALL_HI -j FW_FIREWALL_GLOBAL_BLOCK_HI

  # initialize regular firewall chain
  sudo ip6tables -w -N FW_FIREWALL &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL
  sudo ip6tables -w -C FW_FORWARD -j FW_FIREWALL &>/dev/null || sudo ip6tables -w -A FW_FORWARD -j FW_FIREWALL
  # 90 percent to bypass firewall if the packet belongs to a previously accepted flow
  sudo ip6tables -w -A FW_FIREWALL -m connmark --mark 0x80000000/0x80000000 -m statistic --mode random --probability $FW_PROBABILITY -j ACCEPT
  sudo ip6tables -w -A FW_FIREWALL -j CONNMARK --set-xmark 0x00000000/0x80000000
  # device block/allow chains
  sudo ip6tables -w -N FW_FIREWALL_DEV_ALLOW &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_DEV_ALLOW
  sudo ip6tables -w -A FW_FIREWALL -j FW_FIREWALL_DEV_ALLOW
  sudo ip6tables -w -N FW_FIREWALL_DEV_BLOCK &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_DEV_BLOCK
  sudo ip6tables -w -A FW_FIREWALL -j FW_FIREWALL_DEV_BLOCK
  # device group block/allow chains
  sudo ip6tables -w -N FW_FIREWALL_DEV_G_ALLOW &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_DEV_G_ALLOW
  sudo ip6tables -w -A FW_FIREWALL -j FW_FIREWALL_DEV_G_ALLOW
  sudo ip6tables -w -N FW_FIREWALL_DEV_G_BLOCK &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_DEV_G_BLOCK
  sudo ip6tables -w -A FW_FIREWALL -j FW_FIREWALL_DEV_G_BLOCK
  # network block/allow chains
  sudo ip6tables -w -N FW_FIREWALL_NET_ALLOW &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_NET_ALLOW
  sudo ip6tables -w -A FW_FIREWALL -j FW_FIREWALL_NET_ALLOW
  sudo ip6tables -w -N FW_FIREWALL_NET_BLOCK &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_NET_BLOCK
  sudo ip6tables -w -A FW_FIREWALL -j FW_FIREWALL_NET_BLOCK
  # network group block/allow chains
  sudo ip6tables -w -N FW_FIREWALL_NET_G_ALLOW &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_NET_G_ALLOW
  sudo ip6tables -w -A FW_FIREWALL -j FW_FIREWALL_NET_G_ALLOW
  sudo ip6tables -w -N FW_FIREWALL_NET_G_BLOCK &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_NET_G_BLOCK
  sudo ip6tables -w -A FW_FIREWALL -j FW_FIREWALL_NET_G_BLOCK
  # global block/allow chains
  sudo ip6tables -w -N FW_FIREWALL_GLOBAL_ALLOW &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_GLOBAL_ALLOW
  sudo ip6tables -w -A FW_FIREWALL -j FW_FIREWALL_GLOBAL_ALLOW
  sudo ip6tables -w -N FW_FIREWALL_GLOBAL_BLOCK &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL_GLOBAL_BLOCK
  sudo ip6tables -w -A FW_FIREWALL -j FW_FIREWALL_GLOBAL_BLOCK

  # bidirection
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ip_set6 src -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ip_set6 dst -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_domain_set6 src -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_domain_set6 dst -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_net_set6 src -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_net_set6 dst -j FW_ACCEPT
  # inbound
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_ip_set6 src -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_ip_set6 dst -m conntrack --ctdir REPLY -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_domain_set6 src -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_domain_set6 dst -m conntrack --ctdir REPLY -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_net_set6 src -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_net_set6 dst -m conntrack --ctdir REPLY -j FW_ACCEPT
  # outbound
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_ip_set6 src -m conntrack --ctdir REPLY -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_ip_set6 dst -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_domain_set6 src -m conntrack --ctdir REPLY -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_domain_set6 dst -m conntrack --ctdir ORIGINAL -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_net_set6 src -m conntrack --ctdir REPLY -j FW_ACCEPT
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_net_set6 dst -m conntrack --ctdir ORIGINAL -j FW_ACCEPT

  # bidirection
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ip_set6 src -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ip_set6 dst -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_domain_set6 src -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_domain_set6 dst -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_net_set6 src -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_net_set6 dst -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_ip_set6 src -j FW_SEC_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_ip_set6 dst -j FW_SEC_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_domain_set6 src -j FW_SEC_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_domain_set6 dst -j FW_SEC_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_net_set6 src -j FW_SEC_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set sec_block_net_set6 dst -j FW_SEC_DROP
  # inbound
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_ip_set6 src -m conntrack --ctdir ORIGINAL -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_ip_set6 dst -m conntrack --ctdir REPLY -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_domain_set6 src -m conntrack --ctdir ORIGINAL -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_domain_set6 dst -m conntrack --ctdir REPLY -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_net_set6 src -m conntrack --ctdir ORIGINAL -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_net_set6 dst -m conntrack --ctdir REPLY -j FW_DROP
  # outbound
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_ip_set6 src -m conntrack --ctdir REPLY -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_ip_set6 dst -m conntrack --ctdir ORIGINAL -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_domain_set6 src -m conntrack --ctdir REPLY -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_domain_set6 dst -m conntrack --ctdir ORIGINAL -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_net_set6 src -m conntrack --ctdir REPLY -j FW_DROP
  sudo ip6tables -w -A FW_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_net_set6 dst -m conntrack --ctdir ORIGINAL -j FW_DROP


  sudo ip6tables -w -t nat -N FW_PREROUTING &> /dev/null

  sudo ip6tables -w -t nat -C PREROUTING -j FW_PREROUTING &>/dev/null || sudo ip6tables -w -t nat -A PREROUTING -j FW_PREROUTING

  sudo ip6tables -w -t nat -N FW_POSTROUTING &> /dev/null

  sudo ip6tables -w -t nat -C POSTROUTING -j FW_POSTROUTING &>/dev/null || sudo ip6tables -w -t nat -A POSTROUTING -j FW_POSTROUTING

  # nat blackhole 8888
  sudo ip6tables -w -t nat -N FW_NAT_HOLE &>/dev/null
  sudo ip6tables -w -t nat -F FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -A FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -A FW_NAT_HOLE -j RETURN

  # VPN client chain to mark VPN client inbound connection
  sudo ip6tables -w -t nat -N FW_PREROUTING_VC_INBOUND &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_VC_INBOUND &> /dev/null
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_VC_INBOUND &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_VC_INBOUND

  # create vpn client dns redirect chain in FW_PREROUTING
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_VPN_CLIENT &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_VPN_CLIENT
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT

  # initialize nat dns fallback chain, which is traversed if acl is off
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_FALLBACK &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_FALLBACK

  # initialize nat bypass chain after vpn client
  sudo ip6tables -w -t nat -N FW_NAT_BYPASS &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_BYPASS
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_NAT_BYPASS &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_NAT_BYPASS
  # jump to DNS_FALLBACK for acl off devices/networks
  sudo ip6tables -w -t nat -A FW_NAT_BYPASS -m set --match-set acl_off_set src,src -j FW_PREROUTING_DNS_FALLBACK
  # jump to DNS_FALLBACK for dns boost off devices/networks
  sudo ip6tables -w -t nat -A FW_NAT_BYPASS -m set --match-set no_dns_caching_set src,src -j FW_PREROUTING_DNS_FALLBACK

  # create regular dns redirect chain in FW_PREROUTING
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_VPN &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_VPN
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_WG &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_WG
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_WG &> /dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_WG
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_DEFAULT &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_DEFAULT
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT
  # traverse DNS fallback chain if default chain is not taken
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_FALLBACK &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_FALLBACK

fi

# redirect blue hole ip 80/443 port to localhost
sudo iptables -t nat -A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 80 -j REDIRECT --to-ports 8880
sudo iptables -t nat -A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 443 -j REDIRECT --to-ports 8883

# create a list of set which stores net set of lan networks
sudo ipset create -! c_lan_set list:set
sudo ipset flush -! c_lan_set
# create several list of sets with skbinfo extension which store tag/network/device customized wan and skbmark
sudo ipset create -! c_vpn_client_n_set list:set skbinfo
sudo ipset flush -! c_vpn_client_n_set
sudo ipset create -! c_vpn_client_tag_m_set list:set skbinfo
sudo ipset flush -! c_vpn_client_tag_m_set
sudo ipset create -! c_vpn_client_m_set hash:mac skbinfo
sudo ipset flush -! c_vpn_client_m_set

sudo iptables -w -t mangle -N FW_OUTPUT &> /dev/null
sudo iptables -w -t mangle -F FW_OUTPUT
sudo iptables -w -t mangle -C OUTPUT -j FW_OUTPUT &>/dev/null && sudo iptables -w -t mangle -D OUTPUT -j FW_OUTPUT
sudo iptables -w -t mangle -I OUTPUT -j FW_OUTPUT

# restore fwmark for reply packets of inbound connections
sudo iptables -w -t mangle -A FW_OUTPUT -m connmark ! --mark 0x0/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff

# the sequence is important, higher priority rule is placed after lower priority rule
sudo iptables -w -t mangle -N FW_PREROUTING &>/dev/null
sudo iptables -w -t mangle -F FW_PREROUTING
sudo iptables -w -t mangle -C PREROUTING -j FW_PREROUTING &>/dev/null && sudo iptables -w -t mangle -D PREROUTING -j FW_PREROUTING
sudo iptables -w -t mangle -I PREROUTING -j FW_PREROUTING

# do not change fwmark if it is an existing connection, both for session sticky and reducing iptables overhead
sudo iptables -w -t mangle -A FW_PREROUTING -m connmark ! --mark 0x0/0xffff -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff
sudo iptables -w -t mangle -A FW_PREROUTING -m mark ! --mark 0x0/0xffff -j RETURN
sudo iptables -w -t mangle -A FW_PREROUTING -m connmark --mark 0x80000000/0x80000000 -j RETURN

# vpn client chain
sudo iptables -w -t mangle -N FW_RT_VC &> /dev/null
sudo iptables -w -t mangle -F FW_RT_VC
# only for outbound traffic marking
sudo iptables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -j FW_RT_VC
# global vpn client chain
sudo iptables -w -t mangle -N FW_RT_VC_GLOBAL &>/dev/null
sudo iptables -w -t mangle -F FW_RT_VC_GLOBAL
sudo iptables -w -t mangle -A FW_RT_VC -j FW_RT_VC_GLOBAL
# network group vpn client chain
sudo iptables -w -t mangle -N FW_RT_VC_TAG_NETWORK &>/dev/null
sudo iptables -w -t mangle -F FW_RT_VC_TAG_NETWORK
sudo iptables -w -t mangle -A FW_RT_VC -j FW_RT_VC_TAG_NETWORK
# network vpn client chain
sudo iptables -w -t mangle -N FW_RT_VC_NETWORK &> /dev/null
sudo iptables -w -t mangle -F FW_RT_VC_NETWORK
sudo iptables -w -t mangle -A FW_RT_VC -j FW_RT_VC_NETWORK
sudo iptables -w -t mangle -A FW_RT_VC_NETWORK -j SET --map-set c_vpn_client_n_set src,src --map-mark
# device group vpn client chain
sudo iptables -w -t mangle -N FW_RT_VC_TAG_DEVICE &> /dev/null
sudo iptables -w -t mangle -F FW_RT_VC_TAG_DEVICE
sudo iptables -w -t mangle -A FW_RT_VC -j FW_RT_VC_TAG_DEVICE
sudo iptables -w -t mangle -A FW_RT_VC_TAG_DEVICE -j SET --map-set c_vpn_client_tag_m_set src --map-mark
# device vpn client chain
sudo iptables -w -t mangle -N FW_RT_VC_DEVICE &> /dev/null
sudo iptables -w -t mangle -F FW_RT_VC_DEVICE
sudo iptables -w -t mangle -A FW_RT_VC -j FW_RT_VC_DEVICE
sudo iptables -w -t mangle -A FW_RT_VC_DEVICE -j SET --map-set c_vpn_client_m_set src --map-mark

# regular route chain
sudo iptables -w -t mangle -N FW_RT_REG &> /dev/null
sudo iptables -w -t mangle -F FW_RT_REG
# only for outbound traffic
sudo iptables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -j FW_RT_REG
# save the nfmark to connmark, which will be restored for subsequent packets of this connection and reduce duplicate chain traversal
sudo iptables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -m mark ! --mark 0x0/0xffff -j CONNMARK --save-mark --nfmask 0xffff --ctmask 0xffff
# global regular route chain
sudo iptables -w -t mangle -N FW_RT_REG_GLOBAL &> /dev/null
sudo iptables -w -t mangle -F FW_RT_REG_GLOBAL
sudo iptables -w -t mangle -A FW_RT_REG -j FW_RT_REG_GLOBAL
# network group regular route chain
sudo iptables -w -t mangle -N FW_RT_REG_TAG_NETWORK &> /dev/null
sudo iptables -w -t mangle -F FW_RT_REG_TAG_NETWORK
sudo iptables -w -t mangle -A FW_RT_REG -j FW_RT_REG_TAG_NETWORK
# network regular route chain
sudo iptables -w -t mangle -N FW_RT_REG_NETWORK &> /dev/null
sudo iptables -w -t mangle -F FW_RT_REG_NETWORK
sudo iptables -w -t mangle -A FW_RT_REG -j FW_RT_REG_NETWORK
# device group regular route chain
sudo iptables -w -t mangle -N FW_RT_REG_TAG_DEVICE &> /dev/null
sudo iptables -w -t mangle -F FW_RT_REG_TAG_DEVICE
sudo iptables -w -t mangle -A FW_RT_REG -j FW_RT_REG_TAG_DEVICE
# device regular route chain
sudo iptables -w -t mangle -N FW_RT_REG_DEVICE &> /dev/null
sudo iptables -w -t mangle -F FW_RT_REG_DEVICE
sudo iptables -w -t mangle -A FW_RT_REG -j FW_RT_REG_DEVICE

sudo iptables -w -t mangle -N FW_FORWARD &> /dev/null
sudo iptables -w -t mangle -F FW_FORWARD
sudo iptables -w -t mangle -C FORWARD -j FW_FORWARD &> /dev/null && sudo iptables -w -t mangle -D FORWARD -j FW_FORWARD
sudo iptables -w -t mangle -I FORWARD -j FW_FORWARD

# do not repeatedly traverse the FW_FORWARD chain in mangle table if the connection is already accepted before
sudo iptables -w -t mangle -A FW_FORWARD -m connmark --mark 0x80000000/0x80000000 -m statistic --mode random --probability $FW_PROBABILITY -j RETURN

sudo iptables -w -t mangle -N FW_QOS_SWITCH &> /dev/null
sudo iptables -w -t mangle -F FW_QOS_SWITCH
sudo iptables -w -t mangle -A FW_FORWARD -j FW_QOS_SWITCH
# second bit of 32-bit mark indicates if packet should be mirrored to ifb device in tc filter.
# the packet will be mirrored to ifb only if this bit is set
sudo iptables -w -t mangle -A FW_QOS_SWITCH -m set --match-set qos_off_set src,src -j CONNMARK --set-xmark 0x00000000/0x40000000
sudo iptables -w -t mangle -A FW_QOS_SWITCH -m set ! --match-set qos_off_set src,src -j CONNMARK --set-xmark 0x40000000/0x40000000
sudo iptables -w -t mangle -A FW_QOS_SWITCH -m set --match-set qos_off_set dst,dst -j CONNMARK --set-xmark 0x00000000/0x40000000
sudo iptables -w -t mangle -A FW_QOS_SWITCH -m set ! --match-set qos_off_set dst,dst -j CONNMARK --set-xmark 0x40000000/0x40000000

sudo iptables -w -t mangle -N FW_QOS &> /dev/null
sudo iptables -w -t mangle -F FW_QOS
sudo iptables -w -t mangle -A FW_FORWARD -m connmark --mark 0x40000000/0x40000000 -j FW_QOS
# global qos connmark chain
sudo iptables -w -t mangle -N FW_QOS_GLOBAL &> /dev/null
sudo iptables -w -t mangle -F FW_QOS_GLOBAL
sudo iptables -w -t mangle -A FW_QOS -j FW_QOS_GLOBAL
# network group qos connmark chain
sudo iptables -w -t mangle -N FW_QOS_NET_G &> /dev/null
sudo iptables -w -t mangle -F FW_QOS_NET_G
sudo iptables -w -t mangle -A FW_QOS -j FW_QOS_NET_G
# network qos connmark chain
sudo iptables -w -t mangle -N FW_QOS_NET &> /dev/null
sudo iptables -w -t mangle -F FW_QOS_NET
sudo iptables -w -t mangle -A FW_QOS -j FW_QOS_NET
# device group qos connmark chain
sudo iptables -w -t mangle -N FW_QOS_DEV_G &> /dev/null
sudo iptables -w -t mangle -F FW_QOS_DEV_G
sudo iptables -w -t mangle -A FW_QOS -j FW_QOS_DEV_G
# device qos connmark chain
sudo iptables -w -t mangle -N FW_QOS_DEV &> /dev/null
sudo iptables -w -t mangle -F FW_QOS_DEV
sudo iptables -w -t mangle -A FW_QOS -j FW_QOS_DEV

sudo ip6tables -w -t mangle -N FW_OUTPUT &> /dev/null
sudo ip6tables -w -t mangle -F FW_OUTPUT
sudo ip6tables -w -t mangle -C OUTPUT -j FW_OUTPUT &>/dev/null && sudo iptables -w -t mangle -D OUTPUT -j FW_OUTPUT
sudo ip6tables -w -t mangle -I OUTPUT -j FW_OUTPUT

# restore fwmark for reply packets of inbound connections
sudo ip6tables -w -t mangle -A FW_OUTPUT -m connmark ! --mark 0x0/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff

sudo ip6tables -w -t mangle -N FW_PREROUTING &>/dev/null
sudo ip6tables -w -t mangle -F FW_PREROUTING
sudo ip6tables -w -t mangle -C PREROUTING -j FW_PREROUTING &>/dev/null && sudo ip6tables -w -t mangle -D PREROUTING -j FW_PREROUTING
sudo ip6tables -w -t mangle -I PREROUTING -j FW_PREROUTING

# do not change fwmark if it is an existing connection, both for session sticky and reducing iptables overhead
sudo ip6tables -w -t mangle -A FW_PREROUTING -m connmark ! --mark 0x0/0xffff -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff
sudo ip6tables -w -t mangle -A FW_PREROUTING -m mark ! --mark 0x0/0xffff -j RETURN
sudo ip6tables -w -t mangle -A FW_PREROUTING -m connmark --mark 0x80000000/0x80000000 -j RETURN

# vpn client chain
sudo ip6tables -w -t mangle -N FW_RT_VC &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_VC
# only for outbound traffic marking
sudo ip6tables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -j FW_RT_VC
# global vpn client chain
sudo ip6tables -w -t mangle -N FW_RT_VC_GLOBAL &>/dev/null
sudo ip6tables -w -t mangle -F FW_RT_VC_GLOBAL
sudo ip6tables -w -t mangle -A FW_RT_VC -j FW_RT_VC_GLOBAL
# network group vpn client chain
sudo ip6tables -w -t mangle -N FW_RT_VC_TAG_NETWORK &>/dev/null
sudo ip6tables -w -t mangle -F FW_RT_VC_TAG_NETWORK
sudo ip6tables -w -t mangle -A FW_RT_VC -j FW_RT_VC_TAG_NETWORK
# network vpn client chain
sudo ip6tables -w -t mangle -N FW_RT_VC_NETWORK &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_VC_NETWORK
sudo ip6tables -w -t mangle -A FW_RT_VC -j FW_RT_VC_NETWORK
sudo ip6tables -w -t mangle -A FW_RT_VC_NETWORK -j SET --map-set c_vpn_client_n_set src,src --map-mark
# device group vpn client chain
sudo ip6tables -w -t mangle -N FW_RT_VC_TAG_DEVICE &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_VC_TAG_DEVICE
sudo ip6tables -w -t mangle -A FW_RT_VC -j FW_RT_VC_TAG_DEVICE
sudo ip6tables -w -t mangle -A FW_RT_VC_TAG_DEVICE -j SET --map-set c_vpn_client_tag_m_set src --map-mark
# device vpn client chain
sudo ip6tables -w -t mangle -N FW_RT_VC_DEVICE &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_VC_DEVICE
sudo ip6tables -w -t mangle -A FW_RT_VC -j FW_RT_VC_DEVICE
sudo ip6tables -w -t mangle -A FW_RT_VC_DEVICE -j SET --map-set c_vpn_client_m_set src --map-mark

# regular route chain
sudo ip6tables -w -t mangle -N FW_RT_REG &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_REG
# only for outbound traffic
sudo ip6tables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -j FW_RT_REG
# save the nfmark to connmark, which will be restored for subsequent packets of this connection and reduce duplicate chain traversal
sudo ip6tables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -m mark ! --mark 0x0/0xffff -j CONNMARK --save-mark --nfmask 0xffff --ctmask 0xffff
# global regular route chain
sudo ip6tables -w -t mangle -N FW_RT_REG_GLOBAL &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_REG_GLOBAL
sudo ip6tables -w -t mangle -A FW_RT_REG -j FW_RT_REG_GLOBAL
# network group regular route chain
sudo ip6tables -w -t mangle -N FW_RT_REG_TAG_NETWORK &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_REG_TAG_NETWORK
sudo ip6tables -w -t mangle -A FW_RT_REG -j FW_RT_REG_TAG_NETWORK
# network regular route chain
sudo ip6tables -w -t mangle -N FW_RT_REG_NETWORK &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_REG_NETWORK
sudo ip6tables -w -t mangle -A FW_RT_REG -j FW_RT_REG_NETWORK
# device group regular route chain
sudo ip6tables -w -t mangle -N FW_RT_REG_TAG_DEVICE &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_REG_TAG_DEVICE
sudo ip6tables -w -t mangle -A FW_RT_REG -j FW_RT_REG_TAG_DEVICE
# device regular route chain
sudo ip6tables -w -t mangle -N FW_RT_REG_DEVICE &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_REG_DEVICE
sudo ip6tables -w -t mangle -A FW_RT_REG -j FW_RT_REG_DEVICE

sudo ip6tables -w -t mangle -N FW_FORWARD &> /dev/null
sudo ip6tables -w -t mangle -F FW_FORWARD
sudo ip6tables -w -t mangle -C FORWARD -j FW_FORWARD &> /dev/null && sudo ip6tables -w -t mangle -D FORWARD -j FW_FORWARD
sudo ip6tables -w -t mangle -I FORWARD -j FW_FORWARD

# do not repeatedly traverse the FW_FORWARD chain in mangle table if the connection is already accepted before
sudo ip6tables -w -t mangle -A FW_FORWARD -m connmark --mark 0x80000000/0x80000000 -m statistic --mode random --probability $FW_PROBABILITY -j RETURN

sudo ip6tables -w -t mangle -N FW_QOS_SWITCH &> /dev/null
sudo ip6tables -w -t mangle -F FW_QOS_SWITCH
sudo ip6tables -w -t mangle -A FW_FORWARD -j FW_QOS_SWITCH
# second bit of 32-bit mark indicates if packet should be mirrored to ifb device in tc filter.
# the packet will be mirrored to ifb only if this bit is set
sudo ip6tables -w -t mangle -A FW_QOS_SWITCH -m set --match-set qos_off_set src,src -j CONNMARK --set-xmark 0x00000000/0x40000000
sudo ip6tables -w -t mangle -A FW_QOS_SWITCH -m set ! --match-set qos_off_set src,src -j CONNMARK --set-xmark 0x40000000/0x40000000
sudo ip6tables -w -t mangle -A FW_QOS_SWITCH -m set --match-set qos_off_set dst,dst -j CONNMARK --set-xmark 0x00000000/0x40000000
sudo ip6tables -w -t mangle -A FW_QOS_SWITCH -m set ! --match-set qos_off_set dst,dst -j CONNMARK --set-xmark 0x40000000/0x40000000

sudo ip6tables -w -t mangle -N FW_QOS &> /dev/null
sudo ip6tables -w -t mangle -F FW_QOS
sudo ip6tables -w -t mangle -A FW_FORWARD -m connmark --mark 0x40000000/0x40000000 -j FW_QOS
# global qos connmark chain
sudo ip6tables -w -t mangle -N FW_QOS_GLOBAL &> /dev/null
sudo ip6tables -w -t mangle -F FW_QOS_GLOBAL
sudo ip6tables -w -t mangle -A FW_QOS -j FW_QOS_GLOBAL
# network group qos connmark chain
sudo ip6tables -w -t mangle -N FW_QOS_NET_G &> /dev/null
sudo ip6tables -w -t mangle -F FW_QOS_NET_G
sudo ip6tables -w -t mangle -A FW_QOS -j FW_QOS_NET_G
# network qos connmark chain
sudo ip6tables -w -t mangle -N FW_QOS_NET &> /dev/null
sudo ip6tables -w -t mangle -F FW_QOS_NET
sudo ip6tables -w -t mangle -A FW_QOS -j FW_QOS_NET
# device group qos connmark chain
sudo ip6tables -w -t mangle -N FW_QOS_DEV_G &> /dev/null
sudo ip6tables -w -t mangle -F FW_QOS_DEV_G
sudo ip6tables -w -t mangle -A FW_QOS -j FW_QOS_DEV_G
# device qos connmark chain
sudo ip6tables -w -t mangle -N FW_QOS_DEV &> /dev/null
sudo ip6tables -w -t mangle -F FW_QOS_DEV
sudo ip6tables -w -t mangle -A FW_QOS -j FW_QOS_DEV

# This will remove all customized ip sets that are not referred in iptables after initialization
for set in `sudo ipset list -name | egrep "^c_"`; do
  sudo ipset flush -! $set
done
# flush before destory, some ipsets may be referred in other ipsets and cannot be destroyed at the first run
for set in `sudo ipset list -name | egrep "^c_"`; do
  sudo ipset destroy -! $set
done



if [[ $(uname -m) == "x86_64" ]]; then
  sudo iptables -w -N DOCKER-USER &>/dev/null
  sudo iptables -w -F DOCKER-USER
  sudo iptables -w -A DOCKER-USER -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
  sudo iptables -w -A DOCKER-USER -j RETURN
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
