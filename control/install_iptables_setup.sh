#!/bin/bash

# shellcheck source=iptables_common.sh
source "$(dirname "$0")/iptables_common.sh"

reset_ipset

if [[ $MANAGED_BY_FIREROUTER != "yes" ]]; then
  sudo iptables -w -F FORWARD
  sudo iptables -w -t nat -F PREROUTING
  sudo ip6tables -w -F FORWARD
  sudo ip6tables -w -t nat -F PREROUTING
fi


reset_ip_rules

create_filter_table


# ============= NAT =============
{
sudo iptables-save -t nat | grep -vE "^:FW_| FW_|^COMMIT"

cat << EOF
-N FW_PREROUTING
-A PREROUTING -j FW_PREROUTING

-N FW_POSTROUTING
# ensure it is inserted at the beginning of POSTROUTING, so that snat rules in firewalla will take effect ahead of firerouter snat rules
-I POSTROUTING -j FW_POSTROUTING

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
# create POSTROUTING pbr chain
-N FW_PR_SNAT
-A FW_POSTROUTING -m conntrack --ctdir ORIGINAL -j FW_PR_SNAT

-N FW_PR_SNAT_DEV
-N FW_PR_SNAT_DEV_1
-A FW_PR_SNAT_DEV -j FW_PR_SNAT_DEV_1
-N FW_PR_SNAT_DEV_2
-A FW_PR_SNAT_DEV -j FW_PR_SNAT_DEV_2
-N FW_PR_SNAT_DEV_3
-A FW_PR_SNAT_DEV -j FW_PR_SNAT_DEV_3
-N FW_PR_SNAT_DEV_4
-A FW_PR_SNAT_DEV -j FW_PR_SNAT_DEV_4
-N FW_PR_SNAT_DEV_5
-A FW_PR_SNAT_DEV -j FW_PR_SNAT_DEV_5
-N FW_PR_SNAT_DEV_G
-N FW_PR_SNAT_DEV_G_1
-A FW_PR_SNAT_DEV_G -j FW_PR_SNAT_DEV_G_1
-N FW_PR_SNAT_DEV_G_2
-A FW_PR_SNAT_DEV_G -j FW_PR_SNAT_DEV_G_2
-N FW_PR_SNAT_DEV_G_3
-A FW_PR_SNAT_DEV_G -j FW_PR_SNAT_DEV_G_3
-N FW_PR_SNAT_DEV_G_4
-A FW_PR_SNAT_DEV_G -j FW_PR_SNAT_DEV_G_4
-N FW_PR_SNAT_DEV_G_5
-A FW_PR_SNAT_DEV_G -j FW_PR_SNAT_DEV_G_5
-N FW_PR_SNAT_NET
-N FW_PR_SNAT_NET_1
-A FW_PR_SNAT_NET -j FW_PR_SNAT_NET_1
-N FW_PR_SNAT_NET_2
-A FW_PR_SNAT_NET -j FW_PR_SNAT_NET_2
-N FW_PR_SNAT_NET_3
-A FW_PR_SNAT_NET -j FW_PR_SNAT_NET_3
-N FW_PR_SNAT_NET_4
-A FW_PR_SNAT_NET -j FW_PR_SNAT_NET_4
-N FW_PR_SNAT_NET_5
-A FW_PR_SNAT_NET -j FW_PR_SNAT_NET_5
-N FW_PR_SNAT_NET_G
-N FW_PR_SNAT_NET_G_1
-A FW_PR_SNAT_NET_G -j FW_PR_SNAT_NET_G_1
-N FW_PR_SNAT_NET_G_2
-A FW_PR_SNAT_NET_G -j FW_PR_SNAT_NET_G_2
-N FW_PR_SNAT_NET_G_3
-A FW_PR_SNAT_NET_G -j FW_PR_SNAT_NET_G_3
-N FW_PR_SNAT_NET_G_4
-A FW_PR_SNAT_NET_G -j FW_PR_SNAT_NET_G_4
-N FW_PR_SNAT_NET_G_5
-A FW_PR_SNAT_NET_G -j FW_PR_SNAT_NET_G_5
-N FW_PR_SNAT_GLOBAL
-N FW_PR_SNAT_GLOBAL_1
-A FW_PR_SNAT_GLOBAL -j FW_PR_SNAT_GLOBAL_1
-N FW_PR_SNAT_GLOBAL_2
-A FW_PR_SNAT_GLOBAL -j FW_PR_SNAT_GLOBAL_2
-N FW_PR_SNAT_GLOBAL_3
-A FW_PR_SNAT_GLOBAL -j FW_PR_SNAT_GLOBAL_3
-N FW_PR_SNAT_GLOBAL_4
-A FW_PR_SNAT_GLOBAL -j FW_PR_SNAT_GLOBAL_4
-N FW_PR_SNAT_GLOBAL_5
-A FW_PR_SNAT_GLOBAL -j FW_PR_SNAT_GLOBAL_5

-A FW_PR_SNAT -j FW_PR_SNAT_DEV
-A FW_PR_SNAT -j FW_PR_SNAT_DEV_G
-A FW_PR_SNAT -j FW_PR_SNAT_NET
-A FW_PR_SNAT -j FW_PR_SNAT_NET_G
-A FW_PR_SNAT -j FW_PR_SNAT_GLOBAL

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
-N FW_PREROUTING_VC_EXT_IP
-A FW_PREROUTING -j FW_PREROUTING_VC_EXT_IP
-N FW_PRERT_PORT_FORWARD
-N FW_PRERT_VC_PORT_FORWARD
# create dmz host chain, this is used in ipv4 only
-N FW_PREROUTING_DMZ_HOST
-A FW_PREROUTING_DMZ_HOST -p tcp -m multiport --dports 22,53,8853,8837,8833,8834,8835 -j RETURN
-A FW_PREROUTING_DMZ_HOST -p udp -m multiport --dports 53,8853 -j RETURN
# add dmz host chain to the end of port forward chain
-A FW_PRERT_PORT_FORWARD -j FW_PREROUTING_DMZ_HOST
-A FW_PRERT_VC_PORT_FORWARD -j FW_PREROUTING_DMZ_HOST

# create vpn client dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN_CLIENT

# initialize nat dns fallback chain, which is traversed if acl is off
-N FW_PREROUTING_DNS_FALLBACK

# create regular dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
-N FW_PREROUTING_DNS_WG
-A FW_PREROUTING -j FW_PREROUTING_DNS_WG
-N FW_PREROUTING_DNS_DEFAULT
# skip FW_PREROUTING_DNS_DEFAULT chain if acl or dns booster is off
-A FW_PREROUTING -m set ! --match-set acl_off_set src,src -m set ! --match-set no_dns_caching_set src,src -j FW_PREROUTING_DNS_DEFAULT
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT
# traverse DNS fallback chain if default chain is not taken
-A FW_PREROUTING -j FW_PREROUTING_DNS_FALLBACK

# redirect blue hole ip 80/443 port to localhost
-A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 80 -j REDIRECT --to-ports 8880
-A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 443 -j REDIRECT --to-ports 8883
EOF

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  echo '-A FW_PREROUTING_DMZ_HOST -j FR_WIREGUARD'
fi

echo 'COMMIT'
} >> "$iptables_file"


{
sudo ip6tables-save -t nat | grep -vE "^:FW_| FW_|^COMMIT"

cat << EOF
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

# initialize nat dns fallback chain, which is traversed if acl is off
-N FW_PREROUTING_DNS_FALLBACK

# create regular dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
-N FW_PREROUTING_DNS_WG
-A FW_PREROUTING -j FW_PREROUTING_DNS_WG
-N FW_PREROUTING_DNS_DEFAULT
-A FW_PREROUTING -m set ! --match-set acl_off_set src,src -m set ! --match-set no_dns_caching_set src,src -j FW_PREROUTING_DNS_DEFAULT
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT
# traverse DNS fallback chain if default chain is not taken
-A FW_PREROUTING -j FW_PREROUTING_DNS_FALLBACK

COMMIT
EOF
} >> "$ip6tables_file"


# ============= mangle =============
mangle_file=${FIREWALLA_HIDDEN}/run/iptables/mangle

create_route_chains

create_qos_chains

{
cat << EOF
-N FW_OUTPUT
-I OUTPUT -j FW_OUTPUT

# restore fwmark for reply packets of inbound connections
-A FW_OUTPUT -m connmark ! --mark 0x0/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff

# the sequence is important, higher priority rule is placed after lower priority rule
-N FW_PREROUTING
-I PREROUTING -j FW_PREROUTING

# do not change fwmark if it is an existing outbound connection, both for session sticky and reducing iptables overhead
-A FW_PREROUTING -m connmark ! --mark 0x0/0xffff -m conntrack --ctdir ORIGINAL -m set --match-set c_lan_set src,src -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff
# restore mark on a REPLY packet of an existing connection
-A FW_PREROUTING -m connmark ! --mark 0x0/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff
-A FW_PREROUTING -m mark ! --mark 0x0/0xffff -j RETURN
# always check first 4 original packets of a new connection, this is mainly for tls match
-A FW_PREROUTING -m connbytes --connbytes 4 --connbytes-dir original --connbytes-mode packets -j RETURN

EOF

cat "$route_file"

cat << EOF
# save the nfmark to connmark, which will be restored for subsequent packets of this connection and reduce duplicate chain traversal
-A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -m mark ! --mark 0x0/0xffff -j CONNMARK --save-mark --nfmask 0xffff --ctmask 0xffff

-N FW_FORWARD
-I FORWARD -j FW_FORWARD
EOF

cat "$qos_file"

} > "$mangle_file"

{
  sudo iptables-save -t mangle | grep -vE "^:FW_| FW_|^COMMIT"
  cat "$mangle_file"
  echo 'COMMIT'
} >> "$iptables_file"

{
  sudo ip6tables-save -t mangle | grep -vE "^:FW_| FW_|^COMMIT"
  cat "$mangle_file"
  echo 'COMMIT'
} >> "$ip6tables_file"

if [[ $XT_TLS_SUPPORTED == "yes" ]]; then
  # existence of "-m tls" rules prevents kernel module from being updated, resotre with a tls-clean version first
  grep -v "\-m tls" "$iptables_file" | sudo iptables-restore
  grep -v "\-m tls" "$ip6tables_file" | sudo ip6tables-restore
  if lsmod | grep -w "xt_tls"; then
    sudo rmmod xt_tls
    if [[ $? -eq 0 ]]; then
      installTLSModule
    fi
  else
    installTLSModule
  fi
fi

# install out-of-tree sch_cake.ko if applicable
installSchCakeModule

sudo iptables-restore "$iptables_file"
sudo ip6tables-restore "$ip6tables_file"


{
  # This will remove all customized ip sets that are not referred in iptables after initialization
  for set in $(sudo ipset list -name | grep "^c_"); do
    echo "flush -! $set"
  done
  # flush before destory, some ipsets may be referred in other ipsets and cannot be destroyed at the first run
  for set in $(sudo ipset list -name | grep "^c_"); do
    echo "destroy -! $set"
  done
} > "${FIREWALLA_HIDDEN}/run/iptables/ipset_destroy"

sudo ipset restore -! --file "${FIREWALLA_HIDDEN}/run/iptables/ipset_destroy"

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

create_tc_rules

sudo ebtables -t nat --concurrent -N FW_PREROUTING -P RETURN &>/dev/null
sudo ebtables -t nat --concurrent -F FW_PREROUTING
sudo ebtables -t nat --concurrent -Lx PREROUTING | grep "^-j FW_PREROUTING" || sudo ebtables -t nat --concurrent -A PREROUTING -j FW_PREROUTING
