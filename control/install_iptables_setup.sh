#!/bin/bash

if [[ -e /.dockerenv ]]; then
    #Disable iptables in docker
    /home/pi/firewalla/scripts/flush_iptables.sh
    exit
fi

BLACK_HOLE_IP="0.0.0.0"
BLUE_HOLE_IP="198.51.100.100"

sudo which ipset &>/dev/null || sudo apt-get install -y ipset

sudo ipset create blocked_ip_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_domain_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_net_set hash:net family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_ip_port_set hash:ip,port family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_remote_ip_port_set hash:ip,port family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_remote_net_port_set hash:net,port family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_remote_port_set bitmap:port range 0-65535 &>/dev/null
sudo ipset create blocked_mac_set hash:mac &>/dev/null
sudo ipset create not_monitored_mac_set hash:mac &>/dev/null
sudo ipset create monitored_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create device_whitelist_set hash:mac &> /dev/null
sudo ipset create whitelist_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create whitelist_domain_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create whitelist_net_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create whitelist_ip_port_set hash:ip,port family inet hashsize 128 maxelem 65535 &>/dev/null
sudo ipset create whitelist_remote_ip_port_set hash:ip,port family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create whitelist_remote_net_port_set hash:net,port family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create whitelist_mac_set hash:mac &>/dev/null
sudo ipset create whitelist_remote_port_set bitmap:port range 0-65535 &>/dev/null
sudo ipset create no_dns_caching_mac_set hash:mac &>/dev/null
sudo ipset create no_dns_caching_set list:set &>/dev/null
sudo ipset create monitored_net_set list:set &>/dev/null

# This is to ensure all ipsets are empty when initializing
sudo ipset flush blocked_ip_set
sudo ipset flush blocked_domain_set
sudo ipset flush blocked_net_set
sudo ipset flush blocked_ip_port_set
sudo ipset flush blocked_remote_ip_port_set
sudo ipset flush blocked_remote_net_port_set
sudo ipset flush blocked_remote_port_set
sudo ipset flush blocked_mac_set
sudo ipset flush monitored_ip_set
sudo ipset flush whitelist_ip_set
sudo ipset flush whitelist_domain_set
sudo ipset flush whitelist_net_set
sudo ipset flush whitelist_ip_port_set
sudo ipset flush whitelist_remote_ip_port_set
sudo ipset flush whitelist_remote_net_port_set
sudo ipset flush whitelist_remote_port_set
sudo ipset flush whitelist_mac_set

sudo ipset flush no_dns_caching_mac_set
sudo ipset flush no_dns_caching_set
sudo ipset add -! no_dns_caching_set no_dns_caching_mac_set
sudo ipset flush monitored_net_set

sudo ipset add -! blocked_ip_set $BLUE_HOLE_IP

# This is to remove all vpn client ip sets
for set in `sudo ipset list -name | egrep "^vpn_client_"`; do
  sudo ipset destroy -! $set
done

rules_to_remove=`ip rule list | grep -v -e "^501:" | grep -v -e "^1001:" | grep -v -e "^2001:" | grep -v -e "^3000:" | grep -v -e "^3001:" | grep -v -e "^4001:" | grep -v -e "^5001:" | grep -v -e "^5002:" | grep -v -e "^6001:" | grep -v -e "^7001:" | grep -v -e "^8001:" | grep -v -e "^9001:" | grep -v -e "^10001:" | cut -d: -f2-`;
while IFS= read -r line; do
  sudo ip rule del $line
done <<< "$rules_to_remove"
sudo ip rule add pref 0 from all lookup local
sudo ip rule add pref 32766 from all lookup main
sudo ip rule add pref 32767 from all lookup default

sudo iptables -w -N FW_FORWARD &>/dev/null

sudo iptables -w -C FORWARD -j FW_FORWARD &>/dev/null || sudo iptables -w -A FORWARD -j FW_FORWARD

# multi protocol block chain
sudo iptables -w -N FW_DROP &>/dev/null
sudo iptables -w -F FW_DROP
sudo iptables -w -A FW_DROP -p tcp -j REJECT
sudo iptables -w -A FW_DROP -j DROP

sudo iptables -w -N FW_ACCEPT &>/dev/null
sudo iptables -w -F FW_ACCEPT
sudo iptables -w -A FW_ACCEPT -j CONNMARK --set-mark 0x1/0x1
sudo iptables -w -A FW_ACCEPT -j ACCEPT

# initialize bypass chain
sudo iptables -w -N FW_BYPASS &> /dev/null
sudo iptables -w -F FW_BYPASS
sudo iptables -w -C FW_FORWARD -j FW_BYPASS &> /dev/null || sudo iptables -w -A FW_FORWARD -j FW_BYPASS
# directly accept for not monitored devices
sudo iptables -w -A FW_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT

# initialize vpn client kill switch chain
sudo iptables -w -N FW_VPN_CLIENT &>/dev/null
sudo iptables -w -F FW_VPN_CLIENT
sudo iptable -w -C FW_FORWARD -j FW_VPN_CLIENT &> /dev/null || sudo iptables -w -A FW_FORWARD -j FW_VPN_CLIENT

# do not traverse FW_FORWARD if the packet belongs to an accepted connection
sudo iptables -w -C FW_FORWARD -m connmark --mark 0x1/0x1 -j ACCEPT &>/dev/null || sudo iptables -w -A FW_FORWARD -m connmark --mark 0x1/0x1 -j ACCEPT

# initialize inbound firewall chain
sudo iptables -w -N FW_INBOUND_FIREWALL &> /dev/null
sudo iptables -w -F FW_INBOUND_FIREWALL
sudo iptables -w -C FW_FORWARD -m set ! --match-set monitored_net_set src -m set --match-set monitored_net_set dst -m conntrack --ctstate NEW -j FW_INBOUND_FIREWALL &> /dev/null || sudo iptables -w -A FW_FORWARD -m set ! --match-set monitored_net_set src -m set --match-set monitored_net_set dst -m conntrack --ctstate NEW -j FW_INBOUND_FIREWALL

# initialize whitelist chain
sudo iptables -w -N FW_WHITELIST &> /dev/null
sudo iptables -w -F FW_WHITELIST
sudo iptables -w -C FW_FORWARD -j FW_WHITELIST &>/dev/null || sudo iptables -w -A FW_FORWARD -j FW_WHITELIST
# whitelist supersedes blacklist, thus directly accept
sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_ip_set src -j FW_ACCEPT
sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_ip_set dst -j FW_ACCEPT
sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_domain_set src -j FW_ACCEPT
sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_domain_set dst -j FW_ACCEPT
sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_net_set src -j FW_ACCEPT
sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_net_set dst -j FW_ACCEPT
sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_ip_port_set dst,dst -j FW_ACCEPT
sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_ip_port_set src,src -j FW_ACCEPT
sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set dst,dst -j FW_ACCEPT
sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set src,src -j FW_ACCEPT
sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_net_port_set dst,dst -j FW_ACCEPT
sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_net_port_set src,src -j FW_ACCEPT
sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_port_set dst -j FW_ACCEPT
sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_port_set src -j FW_ACCEPT
sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_mac_set dst -j FW_ACCEPT
sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_mac_set src -j FW_ACCEPT

# initialize blacklist chain
sudo iptables -w -N FW_BLOCK &>/dev/null
sudo iptables -w -F FW_BLOCK
sudo iptables -w -C FW_FORWARD -j FW_BLOCK &>/dev/null || sudo iptables -w -A FW_FORWARD -j FW_BLOCK

sudo iptables -w -I FW_BLOCK -m set --match-set blocked_ip_set dst -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_ip_set src -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_domain_set dst -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_domain_set src -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_net_set dst -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_net_set src -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_ip_port_set dst,dst -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_ip_port_set src,src -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_ip_port_set dst,dst -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_ip_port_set src,src -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_net_port_set dst,dst -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_net_port_set src,src -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_port_set src -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_mac_set dst -j FW_DROP
sudo iptables -w -I FW_BLOCK -m set --match-set blocked_mac_set src -j FW_DROP

# initialize lockdown selector chain
sudo iptables -w -N FW_LOCKDOWN_SELECTOR &> /dev/null
sudo iptables -w -F FW_LOCKDOWN_SELECTOR
sudo iptables -w -C FW_FORWARD -j FW_LOCKDOWN_SELECTOR &>/dev/null || sudo iptables -w -A FW_FORWARD -j FW_LOCKDOWN_SELECTOR

sudo iptables -w -A FW_LOCKDOWN_SELECTOR -p tcp -m multiport --ports 53,67 -j RETURN
sudo iptables -w -A FW_LOCKDOWN_SELECTOR -p udp -m multiport --ports 53,67 -j RETURN
# skip lockdown for local subnet traffic
sudo iptables -w -A FW_LOCKDOWN_SELECTOR -m set --match-set monitored_net_set src -m set --match-set monitored_net_set dst -j RETURN
# FIXME: why??
sudo iptables -w -A FW_LOCKDOWN_SELECTOR -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
# device level lockdown
sudo iptables -w -A FW_LOCKDOWN_SELECTOR -m set --match-set device_whitelist_set src -j FW_DROP


sudo iptables -w -t nat -N FW_PREROUTING &> /dev/null

sudo iptables -w -t nat -C PREROUTING -j FW_PREROUTING &>/dev/null || sudo iptables -w -t nat -A PREROUTING -j FW_PREROUTING

sudo iptables -w -t nat -N FW_POSTROUTING &> /dev/null

sudo iptables -w -t nat -C POSTROUTING -j FW_POSTROUTING &>/dev/null || sudo iptables -w -t nat -A POSTROUTING -j FW_POSTROUTING

# nat blackhole 8888
sudo iptables -w -t nat -N FW_NAT_HOLE &>/dev/null
sudo iptables -w -t nat -F FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -A FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -A FW_NAT_HOLE -j RETURN

# initialize nat bypass chain
sudo iptables -w -t nat -N FW_NAT_BYPASS &> /dev/null
sudo iptables -w -t nat -F FW_NAT_BYPASS
sudo iptables -w -t nat -C FW_PREROUTING -j FW_NAT_BYPASS &> /dev/null || sudo iptables -w -t nat -A FW_PREROUTING -j FW_NAT_BYPASS
# directly accept for not monitored devices
sudo iptables -w -t nat -A FW_NAT_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT

# DNAT related chain comes first
# create port forward chain in PREROUTING, this is used in ipv4 only
sudo iptables -w -t nat -N FW_PREROUTING_PORT_FORWARD &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_PORT_FORWARD
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_PORT_FORWARD || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_PORT_FORWARD
# create dns redirect chain in PREROUTING
sudo iptables -w -t nat -N FW_PREROUTING_DNS_VPN_CLIENT &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_VPN_CLIENT
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT
sudo iptables -w -t nat -N FW_PREROUTING_DNS_VPN &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_VPN
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
sudo iptables -w -t nat -N FW_PREROUTING_DNS_DEFAULT &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_DEFAULT
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT || sudo iptables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT

# only enable NAT whitelist for outbound connections because
# 1. address translation is not done in PREROUTING, it does not make sense to check inbound connection 
# 2. inbound connection should be blocked/allowed in INBOUND_FIREWALL in forward table
sudo iptables -w -t nat -N FW_NAT_WHITELIST &>/dev/null
sudo iptables -w -t nat -F FW_NAT_WHITELIST
sudo iptables -w -t nat -C FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_WHITELIST &> /dev/null || sudo iptables -w -t nat -A FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_WHITELIST
# whitelist supersedes blacklist, thus directly accept
sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_set src -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_set dst -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_domain_set src -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_domain_set dst -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_net_set src -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_net_set dst -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set dst,dst -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set src,src -j ACCEPT
sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set dst,dst -j ACCEPT
sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set src,src -j ACCEPT
sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set dst,dst -j ACCEPT
sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set src,src -j ACCEPT
sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set dst -j ACCEPT
sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set src -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_mac_set dst -j ACCEPT
sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_mac_set src -j ACCEPT

# initialize blacklist chain for NAT table
sudo iptables -w -t nat -N FW_NAT_BLOCK &>/dev/null
sudo iptables -w -t nat -F FW_NAT_BLOCK
# only enable NAT blacklist for outbound connections for the same reason as above
sudo iptables -w -t nat -C FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_BLOCK &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_BLOCK

sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_domain_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_domain_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_net_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_net_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_port_set dst,dst -j FW_NAT_HOLE &>/dev/null
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_port_set src,src -j FW_NAT_HOLE &>/dev/null
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set dst,dst -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set src,src -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set dst,dst -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set src,src -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_port_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_mac_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_mac_set src -j FW_NAT_HOLE

# initialize lockdown selector chain
sudo iptables -w -t nat -N FW_NAT_LOCKDOWN_SELECTOR &> /dev/null
sudo iptables -w -t nat -F FW_NAT_LOCKDOWN_SELECTOR
# only enable NAT lockdown for outbound connections for the same reason as above
sudo iptables -w -t nat -C FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_LOCKDOWN_SELECTOR &>/dev/null || sudo iptables -w -t nat -A FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_LOCKDOWN_SELECTOR

sudo iptables -w -t nat -A FW_NAT_LOCKDOWN_SELECTOR -p tcp -m multiport --ports 53,67 -j RETURN
sudo iptables -w -t nat -A FW_NAT_LOCKDOWN_SELECTOR -p udp -m multiport --ports 53,67 -j RETURN
# skip whitelist for local subnet traffic
sudo iptables -w -t nat -A FW_NAT_LOCKDOWN_SELECTOR -m set --match-set monitored_net_set src -m set --match-set monitored_net_set dst -j RETURN
# FIXME: why??
sudo iptables -w -t nat -A FW_NAT_LOCKDOWN_SELECTOR -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
# device level whitelist
sudo iptables -w -t nat -A FW_NAT_LOCKDOWN_SELECTOR -m set --match-set device_whitelist_set src -j FW_NAT_HOLE




if [[ -e /.dockerenv ]]; then
  sudo iptables -w -C OUTPUT -j FW_BLOCK &>/dev/null || sudo iptables -w -A OUTPUT -j FW_BLOCK
fi

if [[ -e /sbin/ip6tables ]]; then

  sudo ipset create blocked_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create blocked_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create blocked_net_set6 hash:net family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create blocked_ip_port_set6 hash:ip,port family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create blocked_remote_ip_port_set6 hash:ip,port family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create blocked_remote_net_port_set6 hash:net,port family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create monitored_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create whitelist_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &> /dev/null
  sudo ipset create whitelist_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &> /dev/null
  sudo ipset create whitelist_net_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &> /dev/null
  sudo ipset create whitelist_ip_port_set6 hash:ip,port family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create whitelist_remote_ip_port_set6 hash:ip,port family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create whitelist_remote_net_port_set6 hash:net,port family inet6 hashsize 128 maxelem 65536 &>/dev/null

  sudo ipset flush blocked_ip_set6
  sudo ipset flush blocked_domain_set6
  sudo ipset flush blocked_net_set6
  sudo ipset flush blocked_ip_port_set6
  sudo ipset flush blocked_remote_ip_port_set6
  sudo ipset flush blocked_remote_net_port_set6
  sudo ipset flush monitored_ip_set6
  sudo ipset flush whitelist_ip_set6
  sudo ipset flush whitelist_domain_set6
  sudo ipset flush whitelist_net_set6
  sudo ipset flush whitelist_ip_port_set6
  sudo ipset flush whitelist_remote_ip_port_set6
  sudo ipset flush whitelist_remote_net_port_set6

  sudo ip6tables -w -N FW_FORWARD &>/dev/null
  
  sudo ip6tables -w -C FORWARD -j FW_FORWARD &>/dev/null || sudo ip6tables -w -A FORWARD -j FW_FORWARD

  # multi protocol block chain
  sudo ip6tables -w -N FW_DROP &>/dev/null
  sudo ip6tables -w -F FW_DROP
  sudo ip6tables -w -C FW_DROP -p tcp -j REJECT &>/dev/null || sudo ip6tables -w -A FW_DROP -p tcp -j REJECT
  sudo ip6tables -w -C FW_DROP -j DROP &>/dev/null || sudo ip6tables -w -A FW_DROP -j DROP

  sudo ip6tables -w -N FW_ACCEPT &>/dev/null
  sudo ip6tables -w -F FW_ACCEPT
  sudo ip6tables -w -A FW_ACCEPT -j CONNMARK --set-mark 0x1/0x1
  sudo ip6tables -w -A FW_ACCEPT -j ACCEPT

  # initialize bypass chain
  sudo ip6tables -w -N FW_BYPASS &> /dev/null
  sudo ip6tables -w -F FW_BYPASS
  sudo ip6tables -w -C FW_FORWARD -j FW_BYPASS &> /dev/null || sudo ip6tables -w -A FW_FORWARD -j FW_BYPASS
  # directly accept for not monitored devices
  sudo ip6tables -w -A FW_BYPASS -m set --match-set not_monitored_mac_set src -j FW_ACCEPT


  # do not traverse FW_FORWARD if the packet belongs to an accepted connection
  sudo ip6tables -w -C FW_FORWARD -m connmark --mark 0x1/0x1 -j ACCEPT &>/dev/null || sudo ip6tables -w -A FW_FORWARD -m connmark --mark 0x1/0x1 -j ACCEPT

   # initialize inbound firewall chain
  sudo ip6tables -w -N FW_INBOUND_FIREWALL &> /dev/null
  sudo ip6tables -w -F FW_INBOUND_FIREWALL
  sudo ip6tables -w -C FW_FORWARD -m set ! --match-set monitored_net_set src -m set --match-set monitored_net_set dst -m conntrack --ctstate NEW -j FW_INBOUND_FIREWALL &> /dev/null || sudo ip6tables -w -A FW_FORWARD -m set ! --match-set monitored_net_set src -m set --match-set monitored_net_set dst -m conntrack --ctstate NEW -j FW_INBOUND_FIREWALL

  # initialize whitelist chain
  sudo ip6tables -w -N FW_WHITELIST &> /dev/null
  sudo ip6tables -w -F FW_WHITELIST
  sudo ip6tables -w -C FW_FORWARD -j FW_WHITELIST &>/dev/null || sudo ip6tables -w -A FW_FORWARD -j FW_WHITELIST
  # whitelist supersedes blacklist, thus directly accept
  sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_ip_set6 src -j FW_ACCEPT
  sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_ip_set6 dst -j FW_ACCEPT
  sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_domain_set6 src -j FW_ACCEPT
  sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_domain_set6 dst -j FW_ACCEPT
  sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_net_set6 src -j FW_ACCEPT
  sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_net_set6 dst -j FW_ACCEPT
  sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_ip_port_set6 dst,dst -j FW_ACCEPT
  sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_ip_port_set6 src,src -j FW_ACCEPT
  sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 dst,dst -j FW_ACCEPT
  sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 src,src -j FW_ACCEPT
  sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_net_port_set6 dst,dst -j FW_ACCEPT
  sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_net_port_set6 src,src -j FW_ACCEPT
  sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_port_set dst -j FW_ACCEPT
  sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_port_set src -j FW_ACCEPT
  sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_mac_set dst -j FW_ACCEPT
  sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_mac_set src -j FW_ACCEPT

  # initialize blacklist chain
  sudo ip6tables -w -N FW_BLOCK &>/dev/null
  sudo ip6tables -w -F FW_BLOCK
  sudo ip6tables -w -C FW_FORWARD -j FW_BLOCK &>/dev/null ||   sudo ip6tables -w -A FW_FORWARD -j FW_BLOCK

  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_ip_set6 dst -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_ip_set6 src -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_domain_set6 dst -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_domain_set6 src -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_net_set6 dst -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_net_set6 src -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_ip_port_set6 dst,dst -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_ip_port_set6 src,src -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_ip_port_set6 dst,dst -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_ip_port_set6 src,src -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_net_port_set6 dst,dst -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_net_port_set6 src,src -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_port_set src -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_mac_set dst -j FW_DROP
  sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_mac_set src -j FW_DROP

  # initialize lockdown selector chain
  sudo ip6tables -w -N FW_LOCKDOWN_SELECTOR &> /dev/null
  sudo ip6tables -w -F FW_LOCKDOWN_SELECTOR
  sudo ip6tables -w -C FW_FORWARD -j FW_LOCKDOWN_SELECTOR &>/dev/null || sudo ip6tables -w -A FW_FORWARD -j FW_LOCKDOWN_SELECTOR

  sudo ip6tables -w -A FW_LOCKDOWN_SELECTOR -p tcp -m multiport --ports 53,67 -j RETURN
  sudo ip6tables -w -A FW_LOCKDOWN_SELECTOR -p udp -m multiport --ports 53,67 -j RETURN
  # skip lockdown for local subnet traffic
  sudo ip6tables -w -A FW_LOCKDOWN_SELECTOR -m set --match-set monitored_net_set src -m set --match-set monitored_net_set dst -j RETURN
  # FIXME: why??
  sudo ip6tables -w -A FW_LOCKDOWN_SELECTOR -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
  # device level whitelist
  sudo ip6tables -w -A FW_LOCKDOWN_SELECTOR -m set --match-set device_whitelist_set src -j FW_DROP


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
  sudo ip6tables -w -t nat -A FW_NAT_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT

  # DNAT related chain comes first
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_VPN_CLIENT &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_VPN_CLIENT
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT  
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_VPN &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_VPN
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_DEFAULT &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_DEFAULT
  sudo ip6tables -w -t nat -C FW_REROUTING -j FW_PREROUTING_DNS_DEFAULT || sudo ip6tables -w -t nat -A FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT
  
  # only enable NAT whitelist for outbound connections because
  # 1. address translation is not done in PREROUTING, it does not make sense to check inbound connection 
  # 2. inbound connection should be blocked/allowed in INBOUND_FIREWALL in forward table
  sudo ip6tables -w -t nat -N FW_NAT_WHITELIST &>/dev/null
  sudo ip6tables -w -t nat -F FW_NAT_WHITELIST
  sudo ip6tables -w -t nat -C FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_WHITELIST &> /dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_WHITELIST
  # whitelist supersedes blacklist, thus directly accept
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_domain_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_domain_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_net_set6 src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_net_set6 dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set6 dst,dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set6 src,src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 dst,dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 src,src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set6 dst,dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set6 src,src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set src -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_mac_set dst -j ACCEPT
  sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_mac_set src -j ACCEPT

  # initialize blacklist chain for NAT table
  sudo ip6tables -w -t nat -N FW_NAT_BLOCK &>/dev/null
  sudo ip6tables -w -t nat -F FW_NAT_BLOCK
  # only enable NAT blacklist for outbound connections for the same reason as above
  sudo ip6tables -w -t nat -C FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_BLOCK &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_BLOCK

  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_set6 dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_set6 src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_domain_set6 dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_domain_set6 src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_net_set6 dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_net_set6 src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set6 dst,dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set6 src,src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set6 dst,dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set6 src,src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_port_set src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_mac_set dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_mac_set src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_port_set6 dst,dst -j FW_NAT_HOLE &>/dev/null
  sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_port_set6 src,src -j FW_NAT_HOLE &>/dev/null

  # initialize lockdown selector chain
  sudo ip6tables -w -t nat -N FW_NAT_LOCKDOWN_SELECTOR &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_LOCKDOWN_SELECTOR
  # only enable NAT lockdown for outbound connections for the same reason as above
  sudo ip6tables -w -t nat -C FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_LOCKDOWN_SELECTOR &>/dev/null || sudo ip6tables -w -t nat -A FW_PREROUTING -m set --match-set monitored_net_set src -m set ! --match-set monitored_net_set dst -j FW_NAT_LOCKDOWN_SELECTOR
  
  sudo ip6tables -w -t nat -A FW_NAT_LOCKDOWN_SELECTOR -p tcp -m multiport --ports 53,67 -j RETURN
  sudo ip6tables -w -t nat -A FW_NAT_LOCKDOWN_SELECTOR -p udp -m multiport --ports 53,67 -j RETURN
  # skip whitelist for local subnet traffic
  sudo ip6tables -w -t nat -A FW_NAT_LOCKDOWN_SELECTOR -m set --match-set monitored_net_set src -m set --match-set monitored_net_set dst -j RETURN
  # FIXME: why??
  sudo ip6tables -w -t nat -A FW_NAT_LOCKDOWN_SELECTOR -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
  # device level whitelist
  sudo ip6tables -w -t nat -A FW_NAT_LOCKDOWN_SELECTOR -m set --match-set device_whitelist_set src -j FW_NAT_HOLE
fi

# redirect blue hole ip 80/443 port to localhost
sudo iptables -t nat -A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 80 -j REDIRECT --to-ports 8880
sudo iptables -t nat -A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 443 -j REDIRECT --to-ports 8883

# This is to remove all customized ip sets, to have a clean start
for set in `sudo ipset list -name | egrep "^c_"`; do
  sudo ipset flush -! $set
done
# flush before destory, some ipsets may be referred in other ipsets and cannot be destroyed at the first run
for set in `sudo ipset list -name | egrep "^c_"`; do
  sudo ipset destroy -! $set
done
# create a list of set which stores net set of lan networks
sudo ipset create -! c_lan_set list:set
sudo ipset flush -! c_lan_set
# create several list of sets with skbinfo extension which store tag/network/device customized wan and skbmark
sudo ipset create -! c_wan_n_set list:set skbinfo
sudo ipset flush -! c_wan_n_set
sudo ipset create -! c_wan_tag_m_set list:set skbinfo
sudo ipset flush -! c_wan_tag_m_set
sudo ipset create -! c_wan_m_set hash:mac skbinfo
sudo ipset flush -! c_wan_m_set

# the sequence is important, higher priority rule is placed after lower priority rule
sudo iptables -w -t mangle -N FW_PREROUTING &>/dev/null
sudo iptables -w -t mangle -C PREROUTING -j FW_PREROUTING &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -j FW_PREROUTING
# set mark based on tag on network
sudo iptables -w -t mangle -N FW_PREROUTING_WAN_TAG_N &>/dev/null
sudo iptables -w -t mangle -F FW_PREROUTING_WAN_TAG_N
sudo iptables -w -t mangle -C FW_PREROUTING -m set --match-set c_lan_set src,src -j FW_PREROUTING_WAN_TAG_N &>/dev/null || sudo iptables -w -t mangle -I FW_PREROUTING -m set --match-set c_lan_set src,src -j FW_PREROUTING_WAN_TAG_N
# set mark based on network
sudo iptables -w -t mangle -C FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_n_set src,src --map-mark &>/dev/null || sudo iptables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_n_set src,src --map-mark
# set mark based on tag on device
sudo iptables -w -t mangle -C FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_tag_m_set src,src --map-mark &>/dev/null || sudo iptables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_tag_m_set src,src --map-mark
# set mark based on device
sudo iptables -w -t mangle -C FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_m_set src --map-mark &>/dev/null || sudo iptables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_m_set src --map-mark

sudo ip6tables -w -t mangle -N FW_PREROUTING &>/dev/null
sudo ip6tables -w -t mangle -C PREROUTING -j FW_PREROUTING &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -j FW_PREROUTING
# set mark based on tag on network
sudo ip6tables -w -t mangle -N FW_PREROUTING_WAN_TAG_N &>/dev/null
sudo ip6tables -w -t mangle -F FW_PREROUTING_WAN_TAG_N
sudo ip6tables -w -t mangle -C FW_PREROUTING -m set --match-set c_lan_set src,src -j FW_PREROUTING_WAN_TAG_N &>/dev/null || sudo ip6tables -w -t mangle -I FW_PREROUTING -m set --match-set c_lan_set src,src -j FW_PREROUTING_WAN_TAG_N
# set mark based on network
sudo ip6tables -w -t mangle -C FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_n_set src,src --map-mark &>/dev/null || sudo ip6tables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_n_set src,src --map-mark
# set mark based on tag on device
sudo ip6tables -w -t mangle -C FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_tag_m_set src,src --map-mark &>/dev/null || sudo ip6tables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_tag_m_set src,src --map-mark
# set mark based on device
sudo ip6tables -w -t mangle -C FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_m_set src --map-mark &>/dev/null || sudo ip6tables -w -t mangle -A FW_PREROUTING -m set --match-set c_lan_set src,src -j SET --map-set c_wan_m_set src --map-mark



if [[ $(uname -m) == "x86_64" ]]; then
  sudo iptables -w -N DOCKER-USER &>/dev/null
  sudo iptables -w -F DOCKER-USER
  sudo iptables -w -A DOCKER-USER -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
  sudo iptables -w -A DOCKER-USER -j RETURN
fi