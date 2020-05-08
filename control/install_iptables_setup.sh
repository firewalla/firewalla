#!/bin/bash

if [[ -e /.dockerenv ]]; then
    #Disable iptables in docker
    /home/pi/firewalla/scripts/flush_iptables.sh
    exit
fi

BLACK_HOLE_IP="0.0.0.0"
BLUE_HOLE_IP="198.51.100.100"

sudo which ipset &>/dev/null || sudo apt-get install -y ipset

# bidirection
sudo ipset create block_ip_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create block_domain_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create block_net_set hash:net family inet hashsize 128 maxelem 65536 &>/dev/null
# inbound
sudo ipset create block_ib_ip_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create block_ib_domain_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create block_ib_net_set hash:net family inet hashsize 128 maxelem 65536 &>/dev/null
# outbound
sudo ipset create block_ob_ip_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create block_ob_domain_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create block_ob_net_set hash:net family inet hashsize 128 maxelem 65536 &>/dev/null

# bidirection
sudo ipset create allow_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create allow_domain_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create allow_net_set hash:net family inet hashsize 128 maxelem 65536 &> /dev/null
# inbound
sudo ipset create allow_ib_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create allow_ib_domain_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create allow_ib_net_set hash:net family inet hashsize 128 maxelem 65536 &> /dev/null
# outbound
sudo ipset create allow_ob_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create allow_ob_domain_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create allow_ob_net_set hash:net family inet hashsize 128 maxelem 65536 &> /dev/null

sudo ipset create monitoring_off_mac_set hash:mac &>/dev/null
sudo ipset create monitoring_off_set list:set &>/dev/null
sudo ipset create monitored_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create no_dns_caching_mac_set hash:mac &>/dev/null
sudo ipset create no_dns_caching_set list:set &>/dev/null
sudo ipset create monitored_net_set list:set &>/dev/null

# This is to ensure all ipsets are empty when initializing
sudo ipset flush block_ip_set
sudo ipset flush block_domain_set
sudo ipset flush block_net_set
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

sudo ipset flush monitoring_off_mac_set
sudo ipset flush monitoring_off_set
sudo ipset add -! monitoring_off_set monitoring_off_mac_set

sudo ipset flush monitored_ip_set

sudo ipset flush no_dns_caching_mac_set
sudo ipset flush no_dns_caching_set
sudo ipset add -! no_dns_caching_set no_dns_caching_mac_set
sudo ipset flush monitored_net_set

sudo ipset add -! block_ip_set $BLUE_HOLE_IP

# destroy chains in previous version, these should be removed in next release
sudo iptables -F FW_BLOCK &>/dev/null && sudo iptables -X FW_BLOCK
sudo iptables -F FW_NAT_BLOCK &>/dev/null && sudo iptables -X FW_NAT_BLOCK
sudo iptables -F FW_WHITELIST_PREROUTE &>/dev/null && sudo iptables -X FW_WHITELIST_PREROUTE
sudo iptables -F FW_WHITELIST &>/dev/null && sudo iptables -X FW_WHITELIST
sudo iptables -F FW_NAT_WHITELIST_PREROUTE &>/dev/null && sudo iptables -X FW_NAT_WHITELIST_PREROUTE
sudo iptables -F FW_NAT_WHITELIST &>/dev/null && sudo iptables -X FW_NAT_WHITELIST
sudo ip6tables -F FW_BLOCK &>/dev/null && sudo ip6tables -X FW_BLOCK
sudo ip6tables -F FW_NAT_BLOCK &>/dev/null && sudo ip6tables -X FW_NAT_BLOCK
sudo ip6tables -F FW_WHITELIST_PREROUTE &>/dev/null && sudo ip6tables -X FW_WHITELIST_PREROUTE
sudo ip6tables -F FW_WHITELIST &>/dev/null && sudo ip6tables -X FW_WHITELIST
sudo ip6tables -F FW_NAT_WHITELIST_PREROUTE &>/dev/null && sudo ip6tables -X FW_NAT_WHITELIST_PREROUTE
sudo ip6tables -F FW_NAT_WHITELIST &>/dev/null && sudo ip6tables -X FW_NAT_WHITELIST


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
sudo iptables -w -A FW_INPUT_ACCEPT -p tcp -m multiport --dports 22 -j ACCEPT

sudo iptables -w -N FW_INPUT_DROP &> /dev/null
sudo iptables -w -F FW_INPUT_DROP
sudo iptables -w -C INPUT -j FW_INPUT_DROP &>/dev/null || sudo iptables -w -A INPUT -j FW_INPUT_DROP

# multi protocol block chain
sudo iptables -w -N FW_DROP &>/dev/null
sudo iptables -w -F FW_DROP
sudo iptables -w -A FW_DROP -p tcp -j REJECT
sudo iptables -w -A FW_DROP -j DROP

sudo iptables -w -N FW_ACCEPT &>/dev/null
sudo iptables -w -F FW_ACCEPT
sudo iptables -w -A FW_ACCEPT -j ACCEPT

# initialize bypass chain
sudo iptables -w -N FW_BYPASS &> /dev/null
sudo iptables -w -F FW_BYPASS
sudo iptables -w -C FW_FORWARD -j FW_BYPASS &> /dev/null || sudo iptables -w -A FW_FORWARD -j FW_BYPASS
# directly accept for monitoring off devices/networks
sudo iptables -w -A FW_BYPASS -m set --match-set monitoring_off_set src,src -j ACCEPT
sudo iptables -w -A FW_BYPASS -m set --match-set monitoring_off_set dst,dst -j ACCEPT

# initialize vpn client kill switch chain
sudo iptables -w -N FW_VPN_CLIENT &>/dev/null
sudo iptables -w -F FW_VPN_CLIENT
sudo iptable -w -C FW_FORWARD -j FW_VPN_CLIENT &> /dev/null || sudo iptables -w -A FW_FORWARD -j FW_VPN_CLIENT


# initialize firewall chain
sudo iptables -w -N FW_FIREWALL &> /dev/null
sudo iptables -w -F FW_FIREWALL
sudo iptables -w -C FW_FORWARD -j FW_FIREWALL &>/dev/null || sudo iptables -w -A FW_FORWARD -j FW_FIREWALL
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

# nat POSTROUTING port forward hairpin chain
sudo iptables -w -t nat -N FW_POSTROUTING_PORT_FORWARD &> /dev/null
sudo iptables -w -t nat -F FW_POSTROUTING_PORT_FORWARD
sudo iptables -w -t nat -C FW_POSTROUTING -j FW_POSTROUTING_PORT_FORWARD &> /dev/null || sudo iptables -w -t nat -A FW_POSTROUTING -j FW_POSTROUTING_PORT_FORWARD
sudo iptables -w -t nat -N FW_POSTROUTING_HAIRPIN &> /dev/null
sudo iptables -w -t nat -F FW_POSTROUTING_HAIRPIN

# nat blackhole 8888
sudo iptables -w -t nat -N FW_NAT_HOLE &>/dev/null
sudo iptables -w -t nat -F FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -A FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -A FW_NAT_HOLE -j RETURN


# DNAT related chain comes first
# create port forward chain in PREROUTING, this is used in ipv4 only
sudo iptables -w -t nat -N FW_PREROUTING_EXT_IP &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_EXT_IP
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_EXT_IP &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_EXT_IP
sudo iptables -w -t nat -N FW_PREROUTING_PORT_FORWARD &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_PORT_FORWARD
# initialize nat bypass chain
sudo iptables -w -t nat -N FW_NAT_BYPASS &> /dev/null
sudo iptables -w -t nat -F FW_NAT_BYPASS
sudo iptables -w -t nat -C FW_PREROUTING -j FW_NAT_BYPASS &> /dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_NAT_BYPASS
# directly accept for monitoring off devices/networks
sudo iptables -w -t nat -A FW_NAT_BYPASS -m set --match-set monitoring_off_set src,src -j ACCEPT
# create dns redirect chain in PREROUTING
sudo iptables -w -t nat -N FW_PREROUTING_DNS_VPN_CLIENT &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_VPN_CLIENT
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT
sudo iptables -w -t nat -N FW_PREROUTING_DNS_VPN &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_VPN
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
sudo iptables -w -t nat -N FW_PREROUTING_DNS_DEFAULT &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_DEFAULT
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT

# initialize nat firewall chain
sudo iptables -w -t nat -N FW_NAT_FIREWALL &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL
sudo iptables -w -t nat -C FW_PREROUTING -j FW_NAT_FIREWALL &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_NAT_FIREWALL
# device block/allow chains
sudo iptables -w -t nat -N FW_NAT_FIREWALL_DEV_ALLOW &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL_DEV_ALLOW
sudo iptables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_DEV_ALLOW
sudo iptables -w -t nat -N FW_NAT_FIREWALL_DEV_BLOCK &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL_DEV_BLOCK
sudo iptables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_DEV_BLOCK
# device group block/allow chains
sudo iptables -w -t nat -N FW_NAT_FIREWALL_DEV_G_ALLOW &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL_DEV_G_ALLOW
sudo iptables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_DEV_G_ALLOW
sudo iptables -w -t nat -N FW_NAT_FIREWALL_DEV_G_BLOCK &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL_DEV_G_BLOCK
sudo iptables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_DEV_G_BLOCK
# network block/allow chains
sudo iptables -w -t nat -N FW_NAT_FIREWALL_NET_ALLOW &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL_NET_ALLOW
sudo iptables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_NET_ALLOW
sudo iptables -w -t nat -N FW_NAT_FIREWALL_NET_BLOCK &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL_NET_BLOCK
sudo iptables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_NET_BLOCK
# network group block/allow chains
sudo iptables -w -t nat -N FW_NAT_FIREWALL_NET_G_ALLOW &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL_NET_G_ALLOW
sudo iptables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_NET_G_ALLOW
sudo iptables -w -t nat -N FW_NAT_FIREWALL_NET_G_BLOCK &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL_NET_G_BLOCK
sudo iptables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_NET_G_BLOCK
# global block/allow chains
sudo iptables -w -t nat -N FW_NAT_FIREWALL_GLOBAL_ALLOW &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL_GLOBAL_ALLOW
sudo iptables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_GLOBAL_ALLOW
sudo iptables -w -t nat -N FW_NAT_FIREWALL_GLOBAL_BLOCK &> /dev/null
sudo iptables -w -t nat -F FW_NAT_FIREWALL_GLOBAL_BLOCK
sudo iptables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_GLOBAL_BLOCK

# bidirection
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ip_set src -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ip_set dst -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_domain_set src -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_domain_set dst -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_net_set src -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_net_set dst -j ACCEPT
# inbound
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_ip_set src -m conntrack --ctdir ORIGINAL -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_ip_set dst -m conntrack --ctdir REPLY -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_domain_set src -m conntrack --ctdir ORIGINAL -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_domain_set dst -m conntrack --ctdir REPLY -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_net_set src -m conntrack --ctdir ORIGINAL -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_net_set dst -m conntrack --ctdir REPLY -j ACCEPT
# outbound
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_ip_set src -m conntrack --ctdir REPLY -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_ip_set dst -m conntrack --ctdir ORIGINAL -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_domain_set src -m conntrack --ctdir REPLY -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_domain_set dst -m conntrack --ctdir ORIGINAL -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_net_set src -m conntrack --ctdir REPLY -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_net_set dst -m conntrack --ctdir ORIGINAL -j ACCEPT

# bidirection
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ip_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ip_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_domain_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_domain_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_net_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_net_set dst -j FW_NAT_HOLE
# inbound
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_ip_set src -m conntrack --ctdir ORIGINAL -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_ip_set dst -m conntrack --ctdir REPLY -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_domain_set src -m conntrack --ctdir ORIGINAL -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_domain_set dst -m conntrack --ctdir REPLY -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_net_set src -m conntrack --ctdir ORIGINAL -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_net_set dst -m conntrack --ctdir REPLY -j FW_NAT_HOLE
# outbound
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_ip_set src -m conntrack --ctdir REPLY -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_ip_set dst -m conntrack --ctdir ORIGINAL -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_domain_set src -m conntrack --ctdir REPLY -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_domain_set dst -m conntrack --ctdir ORIGINAL -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_net_set src -m conntrack --ctdir REPLY -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_net_set dst -m conntrack --ctdir ORIGINAL -j FW_NAT_HOLE

if [[ -e /.dockerenv ]]; then
  sudo iptables -w -C OUTPUT -j FW_BLOCK &>/dev/null || sudo iptables -w -A OUTPUT -j FW_BLOCK
fi

if [[ -e /sbin/ip6tables ]]; then
  # bidirection
  sudo ipset create block_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create block_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create block_net_set6 hash:net family inet6 hashsize 128 maxelem 65536 &>/dev/null
  # inbound
  sudo ipset create block_ib_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create block_ib_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create block_ib_net_set6 hash:net family inet6 hashsize 128 maxelem 65536 &>/dev/null
  # outbound
  sudo ipset create block_ob_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create block_ob_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create block_ob_net_set6 hash:net family inet6 hashsize 128 maxelem 65536 &>/dev/null

  # bidirection
  sudo ipset create allow_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create allow_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create allow_net_set6 hash:net family inet6 hashsize 128 maxelem 65536 &>/dev/null
  # inbound
  sudo ipset create allow_ib_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create allow_ib_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create allow_ib_net_set6 hash:net family inet6 hashsize 128 maxelem 65536 &>/dev/null
  # outbound
  sudo ipset create allow_ob_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create allow_ob_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create allow_ob_net_set6 hash:net family inet6 hashsize 128 maxelem 65536 &>/dev/null

  sudo ipset create monitored_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null

  sudo ipset flush block_ip_set6
  sudo ipset flush block_domain_set6
  sudo ipset flush block_net_set6
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

  sudo ipset flush monitored_ip_set6

  sudo ip6tables -w -N FW_FORWARD &>/dev/null
  
  sudo ip6tables -w -C FORWARD -j FW_FORWARD &>/dev/null || sudo ip6tables -w -A FORWARD -j FW_FORWARD

  # INPUT chain protection
  sudo ip6tables -w -N FW_INPUT_ACCEPT &> /dev/null
  sudo ip6tables -w -F FW_INPUT_ACCEPT
  sudo ip6tables -w -C INPUT -j FW_INPUT_ACCEPT &>/dev/null || sudo ip6tables -w -A INPUT -j FW_INPUT_ACCEPT
  sudo ip6tables -w -A FW_INPUT_ACCEPT -p tcp -m multiport --dports 22 -j ACCEPT

  sudo ip6tables -w -N FW_INPUT_DROP &> /dev/null
  sudo ip6tables -w -F FW_INPUT_DROP
  sudo ip6tables -w -C INPUT -j FW_INPUT_DROP &>/dev/null || sudo ip6tables -w -A INPUT -j FW_INPUT_DROP

  # multi protocol block chain
  sudo ip6tables -w -N FW_DROP &>/dev/null
  sudo ip6tables -w -F FW_DROP
  sudo ip6tables -w -C FW_DROP -p tcp -j REJECT &>/dev/null || sudo ip6tables -w -A FW_DROP -p tcp -j REJECT
  sudo ip6tables -w -C FW_DROP -j DROP &>/dev/null || sudo ip6tables -w -A FW_DROP -j DROP

  sudo ip6tables -w -N FW_ACCEPT &>/dev/null
  sudo ip6tables -w -F FW_ACCEPT
  sudo ip6tables -w -A FW_ACCEPT -j ACCEPT

  # initialize bypass chain
  sudo ip6tables -w -N FW_BYPASS &> /dev/null
  sudo ip6tables -w -F FW_BYPASS
  sudo ip6tables -w -C FW_FORWARD -j FW_BYPASS &> /dev/null || sudo ip6tables -w -A FW_FORWARD -j FW_BYPASS
  # directly accept for not monitored devices
  sudo ip6tables -w -A FW_BYPASS -m set --match-set monitoring_off_set src,src -j FW_ACCEPT
  sudo ip6tables -w -A FW_BYPASS -m set --match-set monitoring_off_set dst,dst -j FW_ACCEPT


  # initialize firewall chain
  sudo ip6tables -w -N FW_FIREWALL &> /dev/null
  sudo ip6tables -w -F FW_FIREWALL
  sudo ip6tables -w -C FW_FORWARD -j FW_FIREWALL &>/dev/null || sudo ip6tables -w -A FW_FORWARD -j FW_FIREWALL
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

  # initialize nat bypass chain
  sudo ip6tables -w -t nat -N FW_NAT_BYPASS &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_BYPASS
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_NAT_BYPASS &> /dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_NAT_BYPASS
  # directly accept for not monitored devices
  sudo ip6tables -w -t nat -A FW_NAT_BYPASS -m set --match-set monitoring_off_set src,src -j ACCEPT

  # DNAT related chain comes first
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_VPN_CLIENT &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_VPN_CLIENT
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT  
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_VPN &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_VPN
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_DEFAULT &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_DEFAULT
  sudo ip6tables -w -t nat -C FW_REROUTING -j FW_PREROUTING_DNS_DEFAULT &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT

  # initialize nat firewall chain
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_NAT_FIREWALL &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_NAT_FIREWALL
  # device block/allow chains
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL_DEV_ALLOW &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL_DEV_ALLOW
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_DEV_ALLOW
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL_DEV_BLOCK &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL_DEV_BLOCK
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_DEV_BLOCK
  # device group block/allow chains
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL_DEV_G_ALLOW &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL_DEV_G_ALLOW
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_DEV_G_ALLOW
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL_DEV_G_BLOCK &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL_DEV_G_BLOCK
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_DEV_G_BLOCK
  # network block/allow chains
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL_NET_ALLOW &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL_NET_ALLOW
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_NET_ALLOW
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL_NET_BLOCK &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL_NET_BLOCK
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_NET_BLOCK
  # network group block/allow chains
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL_NET_G_ALLOW &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL_NET_G_ALLOW
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_NET_G_ALLOW
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL_NET_G_BLOCK &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL_NET_G_BLOCK
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_NET_G_BLOCK
  # global block/allow chains
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL_GLOBAL_ALLOW &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL_GLOBAL_ALLOW
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_GLOBAL_ALLOW
  sudo ip6tables -w -t nat -N FW_NAT_FIREWALL_GLOBAL_BLOCK &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_FIREWALL_GLOBAL_BLOCK
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL -j FW_NAT_FIREWALL_GLOBAL_BLOCK

  # bidirection
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ip_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ip_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_domain_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_domain_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_net_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_net_set6 dst -j ACCEPT
  # inbound
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_ip_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_ip_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_domain_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_domain_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_net_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ib_net_set6 dst -j ACCEPT
  # outbound
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_ip_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_ip_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_domain_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_domain_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_net_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_ALLOW -m set --match-set allow_ob_net_set6 dst -j ACCEPT

  # bidirection
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ip_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ip_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_domain_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_domain_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_net_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_net_set6 dst -j ACCEPT
  # inbound
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_ip_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_ip_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_domain_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_domain_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_net_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ib_net_set6 dst -j ACCEPT
  # outbound
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_ip_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_ip_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_domain_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_domain_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_net_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_FIREWALL_GLOBAL_BLOCK -m set --match-set block_ob_net_set6 dst -j ACCEPT
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

# the sequence is important, higher priority rule is placed after lower priority rule
sudo iptables -w -t mangle -N FW_PREROUTING &>/dev/null
sudo iptables -w -t mangle -F FW_PREROUTING
sudo iptables -w -t mangle -C PREROUTING -j FW_PREROUTING &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -j FW_PREROUTING

# vpn client inbound reply chain
sudo iptables -w -t mangle -N FW_RT_VC_REPLY &> /dev/null
sudo iptables -w -t mangle -F FW_RT_VC_REPLY &> /dev/null
sudo iptables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir REPLY -j FW_RT_VC_REPLY
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
# only for outbound traffic and not being marked by previous vpn client chain
sudo iptables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -m mark --mark 0x0000 -j FW_RT_REG
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

sudo ip6tables -w -t mangle -N FW_PREROUTING &>/dev/null
sudo ip6tables -w -t mangle -F FW_PREROUTING
sudo ip6tables -w -t mangle -C PREROUTING -j FW_PREROUTING &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -j FW_PREROUTING

# vpn client inbound reply chain
sudo ip6tables -w -t mangle -N FW_RT_VC_REPLY &> /dev/null
sudo ip6tables -w -t mangle -F FW_RT_VC_REPLY &> /dev/null
sudo ip6tables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir REPLY -j FW_RT_VC_REPLY
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
# only for outbound traffic and not being marked by previous vpn client chain
sudo ip6tables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -m mark --mark 0x0000 -j FW_RT_REG
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
