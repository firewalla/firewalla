#!/bin/bash

if [[ -e /.dockerenv ]]; then
    #Disable iptables in docker
    sudo iptables -w -F && sudo iptables -w -F -t nat && sudo ip6tables -F
    exit
fi

BLACK_HOLE_IP="198.51.100.99"
BLUE_HOLE_IP="198.51.100.100"

sudo which ipset &>/dev/null || sudo apt-get install -y ipset

sudo ipset create blocked_ip_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_domain_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_ip_port_set hash:ip,port family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_mac_set hash:mac &>/dev/null

# This is to ensure all ipsets are empty when initializing
sudo ipset flush blocked_ip_set
sudo ipset flush blocked_domain_set
sudo ipset flush blocked_ip_port_set
sudo ipset flush blocked_mac_set

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


  # Special block chain for NAT table
sudo iptables -w -t nat -N FW_NAT_BLOCK &>/dev/null
sudo iptables -w -t nat -F FW_NAT_BLOCK

sudo iptables -w -t nat -C FW_NAT_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null ||   sudo iptables -w -t nat -A FW_NAT_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN

sudo iptables -w -t nat -C PREROUTING -p tcp -j FW_NAT_BLOCK &>/dev/null || sudo iptables -w -t nat -I PREROUTING -p tcp -j FW_NAT_BLOCK

if [[ -e /.dockerenv ]]; then
  sudo iptables -w -C OUTPUT -p all -j FW_BLOCK &>/dev/null || sudo iptables -w -A OUTPUT -p all -j FW_BLOCK
fi

if [[ -e /sbin/ip6tables ]]; then

  sudo ipset create blocked_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create blocked_domain_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create blocked_ip_port_set6 hash:ip,port family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset flush blocked_ip_set6
  sudo ipset flush blocked_domain_set6
  sudo ipset flush blocked_ip_port_set6


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


    # Special block chain for NAT table
  sudo ip6tables -w -t nat -N FW_NAT_BLOCK &>/dev/null
  sudo ip6tables -w -t nat -F FW_NAT_BLOCK

  sudo ip6tables -w -t nat -C FW_NAT_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null ||   sudo ip6tables -w -t nat -A FW_NAT_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN

  sudo ip6tables -w -t nat -C PREROUTING -p tcp -j FW_NAT_BLOCK &>/dev/null || sudo ip6tables -w -t nat -I PREROUTING -p tcp -j FW_NAT_BLOCK
fi

# redirect blue hole ip 80/443 port to localhost
sudo iptables -t nat -A PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 80 -j REDIRECT --to-ports 8880
sudo iptables -t nat -A PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 443 -j REDIRECT --to-ports 8883

# redirect 80 to 8835 for diag interface
for eth_ip in `ip addr show dev eth0 | awk '/inet / {print $2}'|cut -f1 -d/`; do
  sudo iptables -t nat -C PREROUTING -p tcp --destination ${eth_ip} --destination-port 80 -j REDIRECT --to-ports 8835 || sudo iptables -t nat -A PREROUTING -p tcp --destination ${eth_ip} --destination-port 80 -j REDIRECT --to-ports 8835
done