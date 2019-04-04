#!/bin/bash

if [[ -e /.dockerenv ]]; then
    #Disable iptables in docker
    /home/pi/firewalla/scripts/flush_iptables.sh
    exit
fi

BLACK_HOLE_IP="198.51.100.99"
BLUE_HOLE_IP="198.51.100.100"

sudo which ipset &>/dev/null || sudo apt-get install -y ipset

sudo ipset create blocked_ip_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_domain_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_ip_port_set hash:ip,port family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_mac_set hash:mac &>/dev/null
sudo ipset create trusted_ip_set hash:net family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create monitored_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create devicedns_mac_set hash:mac &>/dev/null
sudo ipset create protected_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create whitelist_ip_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create whitelist_domain_set hash:ip family inet hashsize 128 maxelem 65536 &> /dev/null
sudo ipset create whitelist_ip_port_set hash:ip,port family inet hashsize 128 maxelem 65535 &>/dev/null
sudo ipset create whitelist_mac_set hash:mac &>/dev/null

# This is to ensure all ipsets are empty when initializing
sudo ipset flush blocked_ip_set
sudo ipset flush blocked_domain_set
sudo ipset flush blocked_ip_port_set
sudo ipset flush blocked_mac_set
sudo ipset flush trusted_ip_set
sudo ipset flush monitored_ip_set
sudo ipset flush devicedns_mac_set
sudo ipset flush protected_ip_set
sudo ipset flush whitelist_ip_set
sudo ipset flush whitelist_domain_set
sudo ipset flush whitelist_ip_port_set
sudo ipset flush whitelist_mac_set

sudo ipset add -! blocked_ip_set $BLACK_HOLE_IP
sudo ipset add -! blocked_ip_set $BLUE_HOLE_IP

# This is to remove all customized ip sets, to have a clean start
for set in `sudo ipset list -name | egrep "^c_"`; do
  sudo ipset destroy -! $set
done

#FIXME: ignore if failed or not
sudo iptables -w -N FW_BLOCK &>/dev/null
sudo iptables -w -F FW_BLOCK

# return everything
sudo iptables -w -C FW_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null || sudo iptables -w -A FW_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN

# drop non-tcp
sudo iptables -w -C FW_BLOCK -p all -m set --match-set blocked_ip_set dst -j DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -p all -m set --match-set blocked_ip_set dst -j DROP
sudo iptables -w -C FW_BLOCK -p all -m set --match-set blocked_ip_set src -j DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -p all -m set --match-set blocked_ip_set src -j DROP
sudo iptables -w -C FW_BLOCK -p all -m set --match-set blocked_domain_set dst -j DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -p all -m set --match-set blocked_domain_set dst -j DROP
sudo iptables -w -C FW_BLOCK -p all -m set --match-set blocked_domain_set src -j DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -p all -m set --match-set blocked_domain_set src -j DROP
sudo iptables -w -C FW_BLOCK -p all -m set --match-set blocked_ip_port_set dst,dst -j DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -p all -m set --match-set blocked_ip_port_set dst,dst -j DROP
sudo iptables -w -C FW_BLOCK -p all -m set --match-set blocked_mac_set dst -j DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -p all -m set --match-set blocked_mac_set dst -j DROP
sudo iptables -w -C FW_BLOCK -p all -m set --match-set blocked_mac_set src -j DROP &>/dev/null || sudo iptables -w -I FW_BLOCK -p all -m set --match-set blocked_mac_set src -j DROP

# reject tcp
sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set blocked_ip_set dst -j REJECT &>/dev/null || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set blocked_ip_set dst -j REJECT
sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set blocked_ip_set src -j REJECT &>/dev/null || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set blocked_ip_set src -j REJECT
sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set blocked_domain_set dst -j REJECT &>/dev/null || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set blocked_domain_set dst -j REJECT
sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set blocked_domain_set src -j REJECT &>/dev/null || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set blocked_domain_set src -j REJECT
sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set blocked_ip_port_set dst,dst -j REJECT &>/dev/null || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set blocked_ip_port_set dst,dst -j REJECT
sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set blocked_mac_set dst -j REJECT &>/dev/null || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set blocked_mac_set dst -j REJECT
sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set blocked_mac_set src -j REJECT &>/dev/null || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set blocked_mac_set src -j REJECT

# forward to fw_block
sudo iptables -w -C FORWARD -p all -j FW_BLOCK &>/dev/null || sudo iptables -w -A FORWARD -p all -j FW_BLOCK

# clear whitelist mark on dns packet in mangle table
sudo iptables -w -t mangle -C PREROUTING -p tcp -m tcp --dport 53 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -p tcp -m tcp --dport 53 -j CONNMARK --set-xmark 0x0/0x1
sudo iptables -w -t mangle -C PREROUTING -p tcp -m tcp --sport 53 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -p tcp -m tcp --sport 53 -j CONNMARK --set-xmark 0x0/0x1
sudo iptables -w -t mangle -C PREROUTING -p udp -m udp --dport 53 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -p udp -m udp --dport 53 -j CONNMARK --set-xmark 0x0/0x1
sudo iptables -w -t mangle -C PREROUTING -p udp -m udp --sport 53 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -p udp -m udp --sport 53 -j CONNMARK --set-xmark 0x0/0x1
# clear whitelist mark on dhcp packet in mangle table
sudo iptables -w -t mangle -C PREROUTING -p tcp -m tcp --dport 67 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -p tcp -m tcp --dport 67 -j CONNMARK --set-xmark 0x0/0x1
sudo iptables -w -t mangle -C PREROUTING -p tcp -m tcp --sport 67 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -p tcp -m tcp --sport 67 -j CONNMARK --set-xmark 0x0/0x1
sudo iptables -w -t mangle -C PREROUTING -p udp -m udp --dport 67 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -p udp -m udp --dport 67 -j CONNMARK --set-xmark 0x0/0x1
sudo iptables -w -t mangle -C PREROUTING -p udp -m udp --sport 67 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -p udp -m udp --sport 67 -j CONNMARK --set-xmark 0x0/0x1
# clear whitelist mark on local subnet traffic in mangle table
sudo iptables -w -t mangle -C PREROUTING -m set --match-set trusted_ip_set src -m set --match-set trusted_ip_set dst -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -m set --match-set trusted_ip_set src -m set --match-set trusted_ip_set dst -j CONNMARK --set-xmark 0x0/0x1
# clear whitelist mark on established connections in mangle table
sudo iptables -w -t mangle -C PREROUTING -m conntrack --ctstate RELATED,ESTABLISHED -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo iptables -w -t mangle -A PREROUTING -m conntrack --ctstate RELATED,ESTABLISHED -j CONNMARK --set-xmark 0x0/0x1

sudo iptables -w -N FW_WHITELIST &> /dev/null
sudo iptables -w -F FW_WHITELIST

# return if src/dst is in whitelist
sudo iptables -w -C FW_WHITELIST -p all -m set --match-set whitelist_ip_set src -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -p all -m set --match-set whitelist_ip_set src -j RETURN
sudo iptables -w -C FW_WHITELIST -p all -m set --match-set whitelist_ip_set dst -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -p all -m set --match-set whitelist_ip_set dst -j RETURN
sudo iptables -w -C FW_WHITELIST -p all -m set --match-set whitelist_domain_set src -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -p all -m set --match-set whitelist_domain_set src -j RETURN
sudo iptables -w -C FW_WHITELIST -p all -m set --match-set whitelist_domain_set dst -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -p all -m set --match-set whitelist_domain_set dst -j RETURN
sudo iptables -w -C FW_WHITELIST -p all -m set --match-set whitelist_ip_port_set dst,dst -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -p all -m set --match-set whitelist_ip_port_set dst,dst -j RETURN
sudo iptables -w -C FW_WHITELIST -p all -m set --match-set whitelist_mac_set dst -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -p all -m set --match-set whitelist_mac_set dst -j RETURN
sudo iptables -w -C FW_WHITELIST -p all -m set --match-set whitelist_mac_set src -j RETURN &>/dev/null || sudo iptables -w -A FW_WHITELIST -p all -m set --match-set whitelist_mac_set src -j RETURN

# reject tcp
sudo iptables -w -C FW_WHITELIST -p tcp --source 0.0.0.0/0 --destination 0.0.0.0/0 -j REJECT &>/dev/null || sudo iptables -w -A FW_WHITELIST -p tcp --source 0.0.0.0/0 --destination 0.0.0.0/0 -j REJECT
# drop everything
sudo iptables -w -C FW_WHITELIST -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP &>/dev/null || sudo iptables -w -A FW_WHITELIST -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP

# divert to whitelist chain if whitelist bit is marked
sudo iptables -w -C FORWARD -m connmark --mark 0x1/0x1 -j FW_WHITELIST &>/dev/null || sudo iptables -w -I FORWARD -m connmark --mark 0x1/0x1 -j FW_WHITELIST

sudo iptables -w -N FW_SHIELD &> /dev/null
sudo iptables -w -F FW_SHIELD

# drop everything
sudo iptables -w -C FW_SHIELD -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP &>/dev/null || sudo iptables -w -A FW_SHIELD -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP

# return established and related connections
sudo iptables -w -C FW_SHIELD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN &>/dev/null || sudo iptables -w -I FW_SHIELD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

# return if source ip is in trusted_ip_set
sudo iptables -w -C FW_SHIELD -m set --match-set trusted_ip_set src -j RETURN &>/dev/null || sudo iptables -w -I FW_SHIELD -m set --match-set trusted_ip_set src -j RETURN &>/dev/null

# divert to shield chain if dst ip is in protected_ip_set
sudo iptables -w -C FORWARD -m set --match-set protected_ip_set dst -j FW_SHIELD &>/dev/null || sudo iptables -w -A FORWARD -m set --match-set protected_ip_set dst -j FW_SHIELD

# Special block chain for NAT table
sudo iptables -w -t nat -N FW_NAT_BLOCK &>/dev/null
sudo iptables -w -t nat -F FW_NAT_BLOCK

# Redirect global blocking ip set to port 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_set dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_set dst -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_set dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_set dst -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_set src -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_set src -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_set src -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_set src -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_domain_set dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_domain_set dst -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_domain_set dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_domain_set dst -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_domain_set src -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_domain_set src -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_domain_set src -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_domain_set src -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_mac_set dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_mac_set dst -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_mac_set dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_mac_set dst -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_mac_set src -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_mac_set src -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_mac_set src -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_mac_set src -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_port_set dst,dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_port_set dst,dst -j REDIRECT --to-ports 8888 &>/dev/null
sudo iptables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_port_set dst,dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_port_set dst,dst -j REDIRECT --to-ports 8888 &>/dev/null


sudo iptables -w -t nat -C FW_NAT_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null ||   sudo iptables -w -t nat -A FW_NAT_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN

sudo iptables -w -t nat -C PREROUTING -j FW_NAT_BLOCK &>/dev/null || sudo iptables -w -t nat -I PREROUTING -j FW_NAT_BLOCK

sudo iptables -w -t nat -N FW_NAT_WHITELIST &>/dev/null
sudo iptables -w -t nat -F FW_NAT_WHITELIST

# return if src/dst is in whitelist
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_set src -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_set src -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_set dst -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_set dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_domain_set src -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_domain_set src -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_domain_set dst -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_domain_set dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_port_set dst,dst -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_port_set dst,dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_mac_set dst -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_mac_set dst -j RETURN
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_mac_set src -j RETURN &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_mac_set src -j RETURN

# redirect tcp udp to port 8888 by default
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p tcp -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p tcp -j REDIRECT --to-ports 8888
sudo iptables -w -t nat -C FW_NAT_WHITELIST -p udp -j REDIRECT --to-ports 8888 &>/dev/null || sudo iptables -w -t nat -A FW_NAT_WHITELIST -p udp -j REDIRECT --to-ports 8888

# divert to whitelist chain if whitelist bit is marked
sudo iptables -w -t nat -C PREROUTING -m connmark --mark 0x1/0x1 -j FW_NAT_WHITELIST &>/dev/null || sudo iptables -w -t nat -I PREROUTING -m connmark --mark 0x1/0x1 -j FW_NAT_WHITELIST


if [[ -e /.dockerenv ]]; then
  sudo iptables -w -C OUTPUT -p all -j FW_BLOCK &>/dev/null || sudo iptables -w -A OUTPUT -p all -j FW_BLOCK
fi

if [[ -e /sbin/ip6tables ]]; then

  sudo ipset create blocked_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create blocked_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create blocked_ip_port_set6 hash:ip,port family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create trusted_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create monitored_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create protected_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create whitelist_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &> /dev/null
  sudo ipset create whitelist_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &> /dev/null
  sudo ipset create whitelist_ip_port_set6 hash:ip,port family inet6 hashsize 128 maxelem 65536 &>/dev/null


  sudo ipset flush blocked_ip_set6
  sudo ipset flush blocked_domain_set6
  sudo ipset flush blocked_ip_port_set6
  sudo ipset flush trusted_ip_set6
  sudo ipset flush monitored_ip_set6
  sudo ipset flush protected_ip_set6
  sudo ipset flush whitelist_ip_set6
  sudo ipset flush whitelist_domain_set6
  sudo ipset flush whitelist_ip_port_set6


  sudo ip6tables -w -N FW_BLOCK &>/dev/null
  sudo ip6tables -w -F FW_BLOCK

  # return everything
  sudo ip6tables -w -C FW_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null ||   sudo ip6tables -w -A FW_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN

  # drop non-tcp
  sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set blocked_ip_set6 dst -j DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set blocked_ip_set6 dst -j DROP
  sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set blocked_ip_set6 src -j DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set blocked_ip_set6 src -j DROP
  sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set blocked_domain_set6 dst -j DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set blocked_domain_set6 dst -j DROP
  sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set blocked_domain_set6 src -j DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set blocked_domain_set6 src -j DROP
  sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set blocked_ip_port_set6 dst,dst -j DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set blocked_ip_port_set6 dst,dst -j DROP
  sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set blocked_mac_set dst -j DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set blocked_mac_set dst -j DROP
  sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set blocked_mac_set src -j DROP &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set blocked_mac_set src -j DROP
  
  # reject tcp
  sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set blocked_ip_set6 dst -j REJECT &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set blocked_ip_set6 dst -j REJECT
  sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set blocked_ip_set6 src -j REJECT &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set blocked_ip_set6 src -j REJECT
  sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set blocked_domain_set6 dst -j REJECT &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set blocked_domain_set6 dst -j REJECT
  sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set blocked_domain_set6 src -j REJECT &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set blocked_domain_set6 src -j REJECT
  sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set blocked_ip_port_set6 dst,dst -j REJECT &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set blocked_ip_port_set6 dst,dst -j REJECT
  sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set blocked_mac_set dst -j REJECT &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set blocked_mac_set dst -j REJECT
  sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set blocked_mac_set src -j REJECT &>/dev/null ||   sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set blocked_mac_set src -j REJECT

  # forward to fw_block
  sudo ip6tables -w -C FORWARD -p all -j FW_BLOCK &>/dev/null ||   sudo ip6tables -w -A FORWARD -p all -j FW_BLOCK

  # clear whitelist mark on dns packet in mangle table
  sudo ip6tables -w -t mangle -C PREROUTING -p tcp -m tcp --dport 53 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -p tcp -m tcp --dport 53 -j CONNMARK --set-xmark 0x0/0x1
  sudo ip6tables -w -t mangle -C PREROUTING -p tcp -m tcp --sport 53 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -p tcp -m tcp --sport 53 -j CONNMARK --set-xmark 0x0/0x1
  sudo ip6tables -w -t mangle -C PREROUTING -p udp -m udp --dport 53 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -p udp -m udp --dport 53 -j CONNMARK --set-xmark 0x0/0x1
  sudo ip6tables -w -t mangle -C PREROUTING -p udp -m udp --sport 53 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -p udp -m udp --sport 53 -j CONNMARK --set-xmark 0x0/0x1
  # clear whitelist mark on dhcp packet in mangle table
  sudo ip6tables -w -t mangle -C PREROUTING -p tcp -m tcp --dport 67 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -p tcp -m tcp --dport 67 -j CONNMARK --set-xmark 0x0/0x1
  sudo ip6tables -w -t mangle -C PREROUTING -p tcp -m tcp --sport 67 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -p tcp -m tcp --sport 67 -j CONNMARK --set-xmark 0x0/0x1
  sudo ip6tables -w -t mangle -C PREROUTING -p udp -m udp --dport 67 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -p udp -m udp --dport 67 -j CONNMARK --set-xmark 0x0/0x1
  sudo ip6tables -w -t mangle -C PREROUTING -p udp -m udp --sport 67 -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -p udp -m udp --sport 67 -j CONNMARK --set-xmark 0x0/0x1
  # clear whitelist mark on local subnet packet in mangle table
  sudo ip6tables -w -t mangle -C PREROUTING -m set --match-set trusted_ip_set6 src -m set --match-set trusted_ip_set6 dst -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -m set --match-set trusted_ip_set6 src -m set --match-set trusted_ip_set6 dst -j CONNMARK --set-xmark 0x0/0x1
  # clear whitelist mark on established connections in mangle table
  sudo ip6tables -w -t mangle -C PREROUTING -m conntrack --ctstate RELATED,ESTABLISHED -j CONNMARK --set-xmark 0x0/0x1 &>/dev/null || sudo ip6tables -w -t mangle -A PREROUTING -m conntrack --ctstate RELATED,ESTABLISHED -j CONNMARK --set-xmark 0x0/0x1

  sudo ip6tables -w -N FW_WHITELIST &> /dev/null
  sudo ip6tables -w -F FW_WHITELIST

  # return if src/dst is in whitelist
  sudo ip6tables -w -C FW_WHITELIST -p all -m set --match-set whitelist_ip_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -p all -m set --match-set whitelist_ip_set6 src -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -p all -m set --match-set whitelist_ip_set6 dst -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -p all -m set --match-set whitelist_ip_set6 dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -p all -m set --match-set whitelist_domain_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -p all -m set --match-set whitelist_domain_set6 src -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -p all -m set --match-set whitelist_domain_set6 dst -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -p all -m set --match-set whitelist_domain_set6 dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -p all -m set --match-set whitelist_ip_port_set6 dst,dst -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -p all -m set --match-set whitelist_ip_port_set6 dst,dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -p all -m set --match-set whitelist_mac_set dst -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -p all -m set --match-set whitelist_mac_set dst -j RETURN
  sudo ip6tables -w -C FW_WHITELIST -p all -m set --match-set whitelist_mac_set src -j RETURN &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -p all -m set --match-set whitelist_mac_set src -j RETURN

  # reject tcp
  sudo ip6tables -w -C FW_WHITELIST -p tcp --source 0.0.0.0/0 --destination 0.0.0.0/0 -j REJECT &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -p tcp --source 0.0.0.0/0 --destination 0.0.0.0/0 -j REJECT
  # drop everything
  sudo ip6tables -w -C FW_WHITELIST -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP &>/dev/null || sudo ip6tables -w -A FW_WHITELIST -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP

  # divert to white list chain if whitelist bit is marked
  sudo ip6tables -w -C FORWARD -m connmark --mark 0x1/0x1 -j FW_WHITELIST &>/dev/null || sudo ip6tables -w -I FORWARD -m connmark --mark 0x1/0x1 -j FW_WHITELIST


  sudo ip6tables -w -N FW_SHIELD &> /dev/null
  sudo ip6tables -w -F FW_SHIELD

  # drop everything
  sudo ip6tables -w -C FW_SHIELD -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP &>/dev/null || sudo ip6tables -w -A FW_SHIELD -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j DROP

  # return established and related connections
  sudo ip6tables -w -C FW_SHIELD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN &>/dev/null || sudo ip6tables -w -I FW_SHIELD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

  # return if source mac is in trusted_ip_set6
  sudo ip6tables -w -C FW_SHIELD -m set -match-set trusted_ip_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -I FW_SHIELD -m set --match-set trusted_ip_set6 src -j RETURN &>/dev/null

  # divert to shield chain if dst ip is in protected_ip_set6
  sudo ip6tables -w -C FORWARD -m set --match-set protected_ip_set6 dst -j FW_SHIELD &>/dev/null || sudo ip6tables -w -A FORWARD -m set --match-set protected_ip_set6 dst -j FW_SHIELD

  # Special block chain for NAT table
  sudo ip6tables -w -t nat -N FW_NAT_BLOCK &>/dev/null
  sudo ip6tables -w -t nat -F FW_NAT_BLOCK

  # Redirect global blocking ip set to port 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_set6 dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_set6 dst -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_set6 dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_set6 dst -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_set6 src -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_set6 src -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_set6 src -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_set6 src -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_domain_set6 dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_domain_set6 dst -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_domain_set6 dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_domain_set6 dst -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_domain_set6 src -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_domain_set6 src -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_domain_set6 src -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_domain_set6 src -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_mac_set dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_mac_set dst -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_mac_set dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_mac_set dst -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_mac_set src -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_mac_set src -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_mac_set src -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_mac_set src -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_port_set6 dst,dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p tcp -m set --match-set blocked_ip_port_set6 dst,dst -j REDIRECT --to-ports 8888 &>/dev/null
  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_port_set6 dst,dst -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p udp -m set --match-set blocked_ip_port_set6 dst,dst -j REDIRECT --to-ports 8888 &>/dev/null

  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null ||   sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN

  sudo ip6tables -w -t nat -C PREROUTING -j FW_NAT_BLOCK &>/dev/null || sudo ip6tables -w -t nat -I PREROUTING -j FW_NAT_BLOCK

  sudo ip6tables -w -t nat -N FW_NAT_WHITELIST &>/dev/null
  sudo ip6tables -w -t nat -F FW_NAT_WHITELIST

  # return if src/dst is in whitelist
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_set6 src -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_set6 dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_set6 dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_domain_set6 src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_domain_set6 src -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_domain_set6 dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_domain_set6 dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_port_set6 dst,dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_ip_port_set6 dst,dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_mac_set dst -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_mac_set dst -j RETURN
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p all -m set --match-set whitelist_mac_set src -j RETURN &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p all -m set --match-set whitelist_mac_set src -j RETURN

  # redirect tcp udp to port 8888 by default
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p tcp -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p tcp -j REDIRECT --to-ports 8888
  sudo ip6tables -w -t nat -C FW_NAT_WHITELIST -p udp -j REDIRECT --to-ports 8888 &>/dev/null || sudo ip6tables -w -t nat -A FW_NAT_WHITELIST -p udp -j REDIRECT --to-ports 8888

  # divert to whitelist chain if whitelist chain is marked
  sudo ip6tables -w -t nat -C PREROUTING -m connmark --mark 0x1/0x1 -j FW_NAT_WHITELIST &>/dev/null || sudo ip6tables -w -t nat -I PREROUTING -m connmark --mark 0x1/0x1 -j FW_NAT_WHITELIST
fi

# redirect blue hole ip 80/443 port to localhost
sudo iptables -t nat -A PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 80 -j REDIRECT --to-ports 8880
sudo iptables -t nat -A PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 443 -j REDIRECT --to-ports 8883

# redirect 80 to 8835 for diag interface
for eth_ip in `ip addr show dev eth0 | awk '/inet / {print $2}'|cut -f1 -d/`; do
  sudo iptables -t nat -C PREROUTING -p tcp --destination ${eth_ip} --destination-port 80 -j REDIRECT --to-ports 8835 || sudo iptables -t nat -A PREROUTING -p tcp --destination ${eth_ip} --destination-port 80 -j REDIRECT --to-ports 8835
done
