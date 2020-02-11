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
sudo ipset create trusted_ip_set hash:net family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create monitored_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create devicedns_mac_set hash:mac &>/dev/null
sudo ipset create protected_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
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

# This is to ensure all ipsets are empty when initializing
sudo ipset flush blocked_ip_set
sudo ipset flush blocked_domain_set
sudo ipset flush blocked_net_set
sudo ipset flush blocked_ip_port_set
sudo ipset flush blocked_remote_ip_port_set
sudo ipset flush blocked_remote_net_port_set
sudo ipset flush blocked_remote_port_set
sudo ipset flush blocked_mac_set
sudo ipset flush trusted_ip_set
sudo ipset flush monitored_ip_set
sudo ipset flush devicedns_mac_set
sudo ipset flush protected_ip_set
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
sudo iptables -w -C FW_DROP -p tcp -j REJECT &>/dev/null || sudo iptables -w -A FW_DROP -p tcp -j REJECT
sudo iptables -w -C FW_DROP -j DROP &>/dev/null || sudo iptables -w -A FW_DROP -j DROP

sudo iptables -w -N FW_BYPASS &> /dev/null
sudo iptables -w -F FW_BYPASS
# directly accept for not monitored devices
sudo iptables -w -C FW_BYPASS -m set --match-set not_monitored_mac_set dst -j ACCEPT &>/dev/null || sudo iptables -w -I FW_BYPASS -m set --match-set not_monitored_mac_set dst -j ACCEPT
sudo iptables -w -C FW_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT &>/dev/null || sudo iptables -w -I FW_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT

#FIXME: ignore if failed or not
sudo iptables -w -N FW_BLOCK &>/dev/null
sudo iptables -w -F FW_BLOCK

# return everything
sudo iptables -w -C FW_BLOCK --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null || sudo iptables -w -A FW_BLOCK --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN

sudo iptables -w -C FW_BLOCK -m set --match-set blocked_ip_set dst -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_ip_set dst -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_ip_set src -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_ip_set src -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_domain_set dst -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_domain_set dst -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_domain_set src -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_domain_set src -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_net_set dst -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_net_set dst -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_net_set src -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_net_set src -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_ip_port_set dst,dst -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_ip_port_set dst,dst -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_ip_port_set src,src -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_ip_port_set src,src -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_remote_ip_port_set dst,dst -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_ip_port_set dst,dst -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_remote_ip_port_set src,src -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_ip_port_set src,src -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_remote_net_port_set dst,dst -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_net_port_set dst,dst -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_remote_net_port_set src,src -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_net_port_set src,src -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_remote_port_set src -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_remote_port_set src -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_mac_set dst -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_mac_set dst -j FW_DROP
sudo iptables -w -C FW_BLOCK -m set --match-set blocked_mac_set src -j FW_DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -m set --match-set blocked_mac_set src -j FW_DROP

# forward to fw_block
sudo iptables -w -C FW_FORWARD -j FW_BLOCK &>/dev/null || sudo iptables -w -A FW_FORWARD -j FW_BLOCK


sudo iptables -w -N FW_WHITELIST_PREROUTE &> /dev/null
sudo iptables -w -F FW_WHITELIST_PREROUTE

sudo iptables -w -C FW_WHITELIST_PREROUTE -p tcp -m multiport --ports 53,67 -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST_PREROUTE -p tcp -m multiport --ports 53,67 -j RETURN
sudo iptables -w -C FW_WHITELIST_PREROUTE -p udp -m multiport --ports 53,67 -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST_PREROUTE -p udp -m multiport --ports 53,67 -j RETURN

# skip whitelist for local subnet traffic
sudo iptables -w -C FW_WHITELIST_PREROUTE -m set --match-set trusted_ip_set src -m set --match-set trusted_ip_set dst -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST_PREROUTE -m set --match-set trusted_ip_set src -m set --match-set trusted_ip_set dst -j RETURN

# FIXME: why??
sudo iptables -w -C FW_WHITELIST_PREROUTE -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST_PREROUTE -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN


sudo iptables -w -N FW_WHITELIST &> /dev/null
sudo iptables -w -F FW_WHITELIST

sudo iptables -w -C FW_FORWARD -j FW_WHITELIST_PREROUTE &>/dev/null || sudo iptables -w -I FW_FORWARD -j FW_WHITELIST_PREROUTE

sudo iptables -w -C FW_FORWARD -j FW_BYPASS &> /dev/null || sudo iptables -w -I FW_FORWARD -j FW_BYPASS

# device level whitelist
sudo iptables -w -C FW_WHITELIST_PREROUTE -m set --match-set device_whitelist_set src -j FW_WHITELIST &>/dev/null || sudo iptables -w -A FW_WHITELIST_PREROUTE -m set --match-set device_whitelist_set src -j FW_WHITELIST


# return if src/dst is in whitelist
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_ip_set src -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_ip_set src -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_ip_set dst -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_ip_set dst -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_domain_set src -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_domain_set src -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_domain_set dst -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_domain_set dst -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_net_set src -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_net_set src -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_net_set dst -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_net_set dst -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_ip_port_set dst,dst -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_ip_port_set dst,dst -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_ip_port_set src,src -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_ip_port_set src,src -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set dst,dst -j RETURN &>/dev/null || sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set dst,dst -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set src,src -j RETURN &>/dev/null || sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set src,src -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_remote_net_port_set dst,dst -j RETURN &>/dev/null || sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_net_port_set dst,dst -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_remote_net_port_set src,src -j RETURN &>/dev/null || sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_net_port_set src,src -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_remote_port_set dst -j RETURN &>/dev/null || sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_port_set dst -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_remote_port_set src -j RETURN &>/dev/null || sudo iptables -w -I FW_WHITELIST -m set --match-set whitelist_remote_port_set src -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_mac_set dst -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_mac_set dst -j RETURN
sudo iptables -w -C FW_WHITELIST -m set --match-set whitelist_mac_set src -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -m set --match-set whitelist_mac_set src -j RETURN

# reject tcp
sudo iptables -w -C FW_WHITELIST -p tcp --source 0.0.0.0/0 --destination 0.0.0.0/0 -j REJECT &>/dev/null || sudo iptables -w -A FW_WHITELIST -p tcp --source 0.0.0.0/0 --destination 0.0.0.0/0 -j REJECT
# drop everything
sudo iptables -w -C FW_WHITELIST --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP &>/dev/null || sudo iptables -w -A FW_WHITELIST --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP


sudo iptables -w -N FW_SHIELD &> /dev/null
sudo iptables -w -F FW_SHIELD

# drop everything
sudo iptables -w -C FW_SHIELD --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP &>/dev/null || sudo iptables -w -A FW_SHIELD --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP

# return established and related connections
sudo iptables -w -C FW_SHIELD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN &>/dev/null || sudo iptables -w -I FW_SHIELD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

# return if source ip is in trusted_ip_set
sudo iptables -w -C FW_SHIELD -m set --match-set trusted_ip_set src -j RETURN &>/dev/null || sudo iptables -w -I FW_SHIELD -m set --match-set trusted_ip_set src -j RETURN &>/dev/null

# divert to shield chain if dst ip is in protected_ip_set
sudo iptables -w -C FW_FORWARD -m set --match-set protected_ip_set dst -j FW_SHIELD &>/dev/null || sudo iptables -w -A FW_FORWARD -m set --match-set protected_ip_set dst -j FW_SHIELD

sudo iptables -w -t nat -N FW_PREROUTING &> /dev/null

sudo iptables -w -t nat -C PREROUTING -j FW_PREROUTING &>/dev/null || sudo iptables -w -t nat -A PREROUTING -j FW_PREROUTING

sudo iptables -w -t nat -N FW_POSTROUTING &> /dev/null

sudo iptables -w -t nat -C POSTROUTING -j FW_POSTROUTING &>/dev/null || sudo iptables -w -t nat -A POSTROUTING -j FW_POSTROUTING

sudo iptables -w -t nat -N FW_NAT_BYPASS &> /dev/null
sudo iptables -w -t nat -F FW_NAT_BYPASS
# directly return for not monitored devices
sudo iptables -w -t nat -C FW_NAT_BYPASS -m set --match-set not_monitored_mac_set dst -j ACCEPT || sudo iptables -w -t nat -I FW_NAT_BYPASS -m set --match-set not_monitored_mac_set dst -j ACCEPT
sudo iptables -w -t nat -C FW_NAT_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT || sudo iptables -w -t nat -I FW_NAT_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT

# nat blackhole 8888
sudo iptables -w -t nat -N FW_NAT_HOLE &>/dev/null
sudo iptables -w -t nat -F FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_HOLE -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_HOLE -j RETURN

# Special block chain for NAT table
sudo iptables -w -t nat -N FW_NAT_BLOCK &>/dev/null
sudo iptables -w -t nat -F FW_NAT_BLOCK

# Redirect global blocking ip set to port 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_ip_set dst -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_ip_set src -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_domain_set dst -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_domain_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_domain_set src -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_domain_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_net_set dst -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_net_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_net_set src -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_net_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_ip_port_set dst,dst -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_port_set dst,dst -j FW_NAT_HOLE &>/dev/null
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_ip_port_set src,src -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_port_set src,src -j FW_NAT_HOLE &>/dev/null
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set dst,dst -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set dst,dst -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set src,src -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set src,src -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set dst,dst -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set dst,dst -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set src,src -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set src,src -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_port_set src -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_port_set src -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_mac_set dst -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_mac_set dst -j FW_NAT_HOLE
sudo iptables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_mac_set src -j FW_NAT_HOLE &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_mac_set src -j FW_NAT_HOLE


sudo iptables -w -t nat -C FW_NAT_BLOCK --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null ||   sudo iptables -w -t nat -A FW_NAT_BLOCK --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN

sudo iptables -w -t nat -C FW_PREROUTING -j FW_NAT_BLOCK &>/dev/null || sudo iptables -w -t nat -I FW_PREROUTING -j FW_NAT_BLOCK

sudo iptables -w -t nat -N FW_NAT_WHITELIST_PREROUTE &> /dev/null
sudo iptables -w -t nat -F FW_NAT_WHITELIST_PREROUTE

sudo iptables -w -t nat -C FW_NAT_WHITELIST_PREROUTE -p tcp -m multiport --ports 53,67 -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST_PREROUTE -p tcp -m multiport --ports 53,67 -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST_PREROUTE -p udp -m multiport --ports 53,67 -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST_PREROUTE -p udp -m multiport --ports 53,67 -j RETURN

# skip whitelist for local subnet traffic
sudo iptables -w -t nat -C FW_NAT_WHITELIST_PREROUTE -m set --match-set trusted_ip_set src -m set --match-set trusted_ip_set dst -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST_PREROUTE -m set --match-set trusted_ip_set src -m set --match-set trusted_ip_set dst -j RETURN

# FIXME: why??
sudo iptables -w -t nat -C FW_NAT_WHITELIST_PREROUTE -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST_PREROUTE -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

sudo iptables -w -t nat -N FW_NAT_WHITELIST &>/dev/null
sudo iptables -w -t nat -F FW_NAT_WHITELIST

sudo iptables -w -t nat -C FW_PREROUTING -j FW_NAT_WHITELIST_PREROUTE &>/dev/null || sudo iptables -w -t nat -I FW_PREROUTING -j FW_NAT_WHITELIST_PREROUTE

# device level whitelist
sudo iptables -w -t nat -C FW_NAT_WHITELIST_PREROUTE -m set --match-set device_whitelist_set src -j FW_NAT_WHITELIST &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST_PREROUTE -m set --match-set device_whitelist_set src -j FW_NAT_WHITELIST


# return if src/dst is in whitelist
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_ip_set src -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_set src -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_ip_set dst -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_set dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_domain_set src -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_domain_set src -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_domain_set dst -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_domain_set dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_net_set src -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_net_set src -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_net_set dst -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_net_set dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set dst,dst -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set dst,dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set src,src -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set src,src -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set dst,dst -j RETURN &>/dev/null || sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set dst,dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set src,src -j RETURN &>/dev/null || sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set src,src -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set dst,dst -j RETURN &>/dev/null || sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set dst,dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set src,src -j RETURN &>/dev/null || sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set src,src -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set dst -j RETURN &>/dev/null || sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set src -j RETURN &>/dev/null || sudo iptables -w -t nat -I FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set src -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_mac_set dst -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_mac_set dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_mac_set src -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_mac_set src -j RETURN

# redirect tcp udp to port 8888 by default
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p tcp -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p tcp -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p udp -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p udp -j REDIRECT --to-ports 8888


# create dns redirect chain in PREROUTING
sudo iptables -w -t nat -N FW_PREROUTING_DNS_DEFAULT &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_DEFAULT
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT || sudo iptables -w -t nat -I FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT
sudo iptables -w -t nat -N FW_PREROUTING_DNS_VPN &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_VPN
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN || sudo iptables -w -t nat -I FW_PREROUTING -j FW_PREROUTING_DNS_VPN
sudo iptables -w -t nat -N FW_PREROUTING_DNS_SAFE_SEARCH &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_SAFE_SEARCH
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_SAFE_SEARCH || sudo iptables -w -t nat -I FW_PREROUTING -j FW_PREROUTING_DNS_SAFE_SEARCH
sudo iptables -w -t nat -N FW_PREROUTING_DNS_VPN_CLIENT &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_DNS_VPN_CLIENT
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT || sudo iptables -w -t nat -I FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT

# create port forward chain in PREROUTING, this is used in ipv4 only
sudo iptables -w -t nat -N FW_PREROUTING_PORT_FORWARD &> /dev/null
sudo iptables -w -t nat -F FW_PREROUTING_PORT_FORWARD
sudo iptables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_PORT_FORWARD || sudo iptables -w -t nat -I FW_PREROUTING -j FW_PREROUTING_PORT_FORWARD

# create nat bypass chain in PREROUTING
sudo iptables -w -t nat -C FW_PREROUTING -j FW_NAT_BYPASS &> /dev/null || sudo iptables -w -t nat -I FW_PREROUTING -j FW_NAT_BYPASS

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
  sudo ipset create trusted_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create monitored_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create protected_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
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
  sudo ipset flush trusted_ip_set6
  sudo ipset flush monitored_ip_set6
  sudo ipset flush protected_ip_set6
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

  sudo ip6tables -w -N FW_BYPASS &> /dev/null
  sudo ip6tables -w -F FW_BYPASS
  # directly accept for not monitored devices
  sudo ip6tables -w -C FW_BYPASS -m set --match-set not_monitored_mac_set dst -j ACCEPT &>/dev/null || sudo ip6tables -w -I FW_BYPASS -m set --match-set not_monitored_mac_set dst -j ACCEPT
  sudo ip6tables -w -C FW_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT &>/dev/null || sudo ip6tables -w -I FW_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT

  sudo ip6tables -w -N FW_BLOCK &>/dev/null
  sudo ip6tables -w -F FW_BLOCK

  # return everything
  sudo ip6tables -w -C FW_BLOCK --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null ||   sudo ip6tables -w -A FW_BLOCK --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN

  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_ip_set6 dst -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_ip_set6 dst -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_ip_set6 src -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_ip_set6 src -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_domain_set6 dst -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_domain_set6 dst -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_domain_set6 src -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_domain_set6 src -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_net_set6 dst -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_net_set6 dst -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_net_set6 src -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_net_set6 src -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_ip_port_set6 dst,dst -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_ip_port_set6 dst,dst -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_ip_port_set6 src,src -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_ip_port_set6 src,src -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_remote_ip_port_set6 dst,dst -j FW_DROP &>/dev/null || sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_ip_port_set6 dst,dst -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_remote_ip_port_set6 src,src -j FW_DROP &>/dev/null || sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_ip_port_set6 src,src -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_remote_net_port_set6 dst,dst -j FW_DROP &>/dev/null || sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_net_port_set6 dst,dst -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_remote_net_port_set6 src,src -j FW_DROP &>/dev/null || sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_net_port_set6 src,src -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_remote_port_set src -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_remote_port_set src -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_mac_set dst -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_mac_set dst -j FW_DROP
  sudo ip6tables -w -C FW_BLOCK -m set --match-set blocked_mac_set src -j FW_DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -m set --match-set blocked_mac_set src -j FW_DROP

  # forward to fw_block
  sudo ip6tables -w -C FW_FORWARD -j FW_BLOCK &>/dev/null ||   sudo ip6tables -w -A FW_FORWARD -j FW_BLOCK

  sudo ip6tables -w -N FW_WHITELIST_PREROUTE &> /dev/null
  sudo ip6tables -w -F FW_WHITELIST_PREROUTE

  sudo ip6tables -w -C FW_WHITELIST_PREROUTE -p tcp -m multiport --ports 53,67 -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST_PREROUTE -p tcp -m multiport --ports 53,67 -j RETURN
  sudo ip6tables -w -C FW_WHITELIST_PREROUTE -p udp -m multiport --ports 53,67 -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST_PREROUTE -p udp -m multiport --ports 53,67 -j RETURN

  # skip whitelist for local subnet traffic
  sudo ip6tables -w -C FW_WHITELIST_PREROUTE -m set --match-set trusted_ip_set src -m set --match-set trusted_ip_set dst -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST_PREROUTE -m set --match-set trusted_ip_set src -m set --match-set trusted_ip_set dst -j RETURN

  # FIXME: why??
  sudo ip6tables -w -C FW_WHITELIST_PREROUTE -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST_PREROUTE -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

  sudo ip6tables -w -N FW_WHITELIST &> /dev/null
  sudo ip6tables -w -F FW_WHITELIST

  sudo ip6tables -w -C FW_FORWARD -j FW_WHITELIST_PREROUTE &>/dev/null || sudo ip6tables -w -I FW_FORWARD -j FW_WHITELIST_PREROUTE

  sudo ip6tables -w -C FW_FORWARD -j FW_BYPASS &> /dev/null || sudo ip6tables -w -I FW_FORWARD -j FW_BYPASS

  # device level whitelist
  sudo ip6tables -w -C FW_WHITELIST_PREROUTE -m set --match-set device_whitelist_set src -j FW_WHITELIST &>/dev/null || sudo ip6tables -w -A FW_WHITELIST_PREROUTE -m set --match-set device_whitelist_set src -j FW_WHITELIST


  # return if src/dst is in whitelist
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_ip_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_ip_set6 src -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_ip_set6 dst -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_ip_set6 dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_domain_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_domain_set6 src -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_domain_set6 dst -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_domain_set6 dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_net_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_net_set6 src -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_net_set6 dst -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_net_set6 dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_ip_port_set6 dst,dst -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_ip_port_set6 dst,dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_ip_port_set6 src,src -j RETURN &>/dev/null || sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_ip_port_set6 src,src -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 dst,dst -j RETURN &>/dev/null || sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 dst,dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 src,src -j RETURN &>/dev/null || sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 src,src -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_remote_net_port_set6 dst,dst -j RETURN &>/dev/null || sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_net_port_set6 dst,dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_remote_net_port_set6 src,src -j RETURN &>/dev/null || sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_net_port_set6 src,src -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_remote_port_set dst -j RETURN &>/dev/null || sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_port_set dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_remote_port_set src -j RETURN &>/dev/null || sudo ip6tables -w -I FW_WHITELIST -m set --match-set whitelist_remote_port_set src -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_mac_set dst -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_mac_set dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -m set --match-set whitelist_mac_set src -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -m set --match-set whitelist_mac_set src -j RETURN

  # reject tcp
  sudo ip6tables -w -C FW_WHITELIST -p tcp --source 0.0.0.0/0 --destination 0.0.0.0/0 -j REJECT &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -p tcp --source 0.0.0.0/0 --destination 0.0.0.0/0 -j REJECT
  # drop everything
  sudo ip6tables -w -C FW_WHITELIST --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP &>/dev/null || sudo ip6tables -w -A FW_WHITELIST --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP


  sudo ip6tables -w -N FW_SHIELD &> /dev/null
  sudo ip6tables -w -F FW_SHIELD

  # drop everything
  sudo ip6tables -w -C FW_SHIELD --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP &>/dev/null || sudo ip6tables -w -A FW_SHIELD --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP

  # return established and related connections
  sudo ip6tables -w -C FW_SHIELD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN &>/dev/null || sudo ip6tables -w -I FW_SHIELD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

  # return if source mac is in trusted_ip_set6
  sudo ip6tables -w -C FW_SHIELD -m set -match-set trusted_ip_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -I FW_SHIELD -m set --match-set trusted_ip_set6 src -j RETURN &>/dev/null

  # divert to shield chain if dst ip is in protected_ip_set6
  sudo ip6tables -w -C FW_FORWARD -m set --match-set protected_ip_set6 dst -j FW_SHIELD &>/dev/null || sudo ip6tables -w -A FW_FORWARD -m set --match-set protected_ip_set6 dst -j FW_SHIELD

  sudo ip6tables -w -t nat -N FW_PREROUTING &> /dev/null

  sudo ip6tables -w -t nat -C PREROUTING -j FW_PREROUTING &>/dev/null || sudo ip6tables -w -t nat -A PREROUTING -j FW_PREROUTING

  sudo ip6tables -w -t nat -N FW_POSTROUTING &> /dev/null

  sudo ip6tables -w -t nat -C POSTROUTING -j FW_POSTROUTING &>/dev/null || sudo ip6tables -w -t nat -A POSTROUTING -j FW_POSTROUTING

  sudo ip6tables -w -t nat -N FW_NAT_BYPASS &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_BYPASS
  # directly return for not monitored devices
  sudo ip6tables -w -t nat -C FW_NAT_BYPASS -m set --match-set not_monitored_mac_set dst -j ACCEPT || sudo ip6tables -w -t nat -I FW_NAT_BYPASS -m set --match-set not_monitored_mac_set dst -j ACCEPT
  sudo ip6tables -w -t nat -C FW_NAT_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT || sudo ip6tables -w -t nat -I FW_NAT_BYPASS -m set --match-set not_monitored_mac_set src -j ACCEPT

  # nat blackhole 8888
  sudo ip6tables -w -t nat -N FW_NAT_HOLE &>/dev/null
  sudo ip6tables -w -t nat -F FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_HOLE -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_HOLE -j RETURN

  # Special block chain for NAT table
  sudo ip6tables -w -t nat -N FW_NAT_BLOCK &>/dev/null
  sudo ip6tables -w -t nat -F FW_NAT_BLOCK

  # Redirect global blocking ip set to port 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_ip_set6 dst -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_set6 dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_ip_set6 src -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_set6 src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_domain_set6 dst -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_domain_set6 dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_domain_set6 src -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_domain_set6 src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_net_set6 dst -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_net_set6 dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_net_set6 src -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_net_set6 src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set6 dst,dst -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set6 dst,dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set6 src,src -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_ip_port_set6 src,src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set6 dst,dst -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set6 dst,dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set6 src,src -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_net_port_set6 src,src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_port_set dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_remote_port_set src -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_remote_port_set src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_mac_set dst -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_mac_set dst -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_mac_set src -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_mac_set src -j FW_NAT_HOLE
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_ip_port_set6 dst,dst -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_port_set6 dst,dst -j FW_NAT_HOLE &>/dev/null
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -m set --match-set blocked_ip_port_set6 src,src -j FW_NAT_HOLE &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -m set --match-set blocked_ip_port_set6 src,src -j FW_NAT_HOLE &>/dev/null

  sudo ip6tables -w -t nat -C FW_NAT_BLOCK --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null ||   sudo ip6tables -w -t nat -A FW_NAT_BLOCK --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN

  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_NAT_BLOCK &>/dev/null || sudo ip6tables -w -t nat -I FW_PREROUTING -j FW_NAT_BLOCK

  sudo ip6tables -w -t nat -N FW_NAT_WHITELIST_PREROUTE &> /dev/null
  sudo ip6tables -w -t nat -F FW_NAT_WHITELIST_PREROUTE

  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST_PREROUTE -p tcp -m multiport --ports 53,67 -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST_PREROUTE -p tcp -m multiport --ports 53,67 -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST_PREROUTE -p udp -m multiport --ports 53,67 -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST_PREROUTE -p udp -m multiport --ports 53,67 -j RETURN

  # skip whitelist for local subnet traffic
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST_PREROUTE -m set --match-set trusted_ip_set src -m set --match-set trusted_ip_set dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST_PREROUTE -m set --match-set trusted_ip_set src -m set --match-set trusted_ip_set dst -j RETURN

  # FIXME: why??
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST_PREROUTE -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST_PREROUTE -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN


  sudo ip6tables -w -t nat -N FW_NAT_WHITELIST &>/dev/null
  sudo ip6tables -w -t nat -F FW_NAT_WHITELIST

  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_NAT_WHITELIST_PREROUTE &>/dev/null || sudo ip6tables -w -t nat -I FW_PREROUTING -j FW_NAT_WHITELIST_PREROUTE

  # device level whitelist
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST_PREROUTE -m set --match-set device_whitelist_set src -j FW_NAT_WHITELIST &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST_PREROUTE -m set --match-set device_whitelist_set src -j FW_NAT_WHITELIST


  # return if src/dst is in whitelist
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_ip_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_set6 src -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_ip_set6 dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_set6 dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_domain_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_domain_set6 src -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_domain_set6 dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_domain_set6 dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_net_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_net_set6 src -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_net_set6 dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_net_set6 dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set6 dst,dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set6 dst,dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set6 src,src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_ip_port_set6 src,src -j RETURN &>/dev/null
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 dst,dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 dst,dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 src,src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_ip_port_set6 src,src -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set6 dst,dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set6 dst,dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set6 src,src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_net_port_set6 src,src -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_remote_port_set src -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_mac_set dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_mac_set dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -m set --match-set whitelist_mac_set src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -m set --match-set whitelist_mac_set src -j RETURN

  # redirect tcp udp to port 8888 by default
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p tcp -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p tcp -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p udp -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p udp -j REDIRECT --to-ports 8888

  # create dns redirect chain in PREROUTING
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_DEFAULT &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_DEFAULT
  sudo ip6tables -w -t nat -C FW_REROUTING -j FW_PREROUTING_DNS_DEFAULT || sudo ip6tables -w -t nat -I FW_PREROUTING -j FW_PREROUTING_DNS_DEFAULT
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_VPN &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_VPN
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN || sudo ip6tables -w -t nat -I FW_PREROUTING -j FW_PREROUTING_DNS_VPN
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_SAFE_SEARCH &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_SAFE_SEARCH
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_SAFE_SEARCH || sudo ip6tables -w -t nat -I FW_PREROUTING -j FW_PREROUTING_DNS_SAFE_SEARCH
  sudo ip6tables -w -t nat -N FW_PREROUTING_DNS_VPN_CLIENT &> /dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_VPN_CLIENT
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT || sudo ip6tables -w -t nat -I FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT

  # create nat bypass chain in PREROUTING
  sudo ip6tables -w -t nat -C FW_PREROUTING -j FW_NAT_BYPASS &> /dev/null || sudo ip6tables -w -t nat -I FW_PREROUTING -j FW_NAT_BYPASS
fi

# redirect blue hole ip 80/443 port to localhost
sudo iptables -t nat -A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 80 -j REDIRECT --to-ports 8880
sudo iptables -t nat -A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 443 -j REDIRECT --to-ports 8883

# This is to remove all customized ip sets, to have a clean start
for set in `sudo ipset list -name | egrep "^c_"`; do
  sudo ipset destroy -! $set
done
# do this twice since some ipsets may be referred in other ipsets and cannot be destroyed at the first run
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




