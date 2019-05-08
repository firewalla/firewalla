#!/bin/bash
# 
read -d '' USAGE << EOF
 Usage:
 1) install
   install -i <profile_id> -f <profile_path> -p <password> 
 2) start
   start -i <profile_id>
 3) stop
   stop -i <profile_id>
 4) grant access
   grant -m <mac_address>
 5) revoke access
   revoke -m <mac_address>
EOF

OPT=$1

if [[ "$OPT" != "install" ]] && [[ "$OPT" != "start" ]] && [[ "$OPT" != "stop" ]] && [[ "$OPT" != "grant" ]] && [[ "$OPT" != "revoke" ]]
then
  echo "$USAGE"
  exit 0;
fi

shift 1;

while getopts i:f:p:m: option
do
  case "${option}"
  in
  i) PROFILE_ID=${OPTARG};;
  f) PROFILE_PATH=${OPTARG};;
  p) PASSWORD=${OPTARG};;
  m) DEVICE_MAC=${OPTARG};;
  esac
done

PROFILE_REPO="/home/pi/.firewalla/run/ovpn_profile/"
mkdir -p $PROFILE_REPO

if [[ "$OPT" == "install" ]]
then
  if [[ -z $PROFILE_ID ]]
  then
    echo "Profile id is not specified."
    exit 1
  fi
  if [[ -z $PROFILE_PATH ]]
  then
    echo "Profile path is not specified."
    exit 1
  fi
  if [[ ! -f $PROFILE_PATH ]]
  then
    echo "Specified profile does not exist."
    exit 1
  fi 
  if [[ -z $PASSWORD ]]
  then
    echo "Password is not specified."
    exit 1
  fi

  echo "Installing profile $PROFILE_ID..."
  cp "$PROFILE_PATH" "$PROFILE_REPO/$PROFILE_ID.ovpn"
  echo -n "$PASSWORD" > "$PROFILE_REPO/$PROFILE_ID.password"
fi

if [[ "$OPT" == "start" ]]
then
  if [[ -z $PROFILE_ID ]]
  then
    echo "Profile id is not specified."
    exit 1
  fi
  if [[ ! -f "$PROFILE_REPO/$PROFILE_ID.ovpn" ]]
  then
    echo "Profile of specified id does not exist."
    exit 1
  fi

  echo "Starting vpn client of $PROFILE_ID..."
  redis-cli hset policy:system vpnClient "{\"state\":true,\"type\":\"openvpn\",\"openvpn\":{\"profileId\":\"$PROFILE_ID\"}}"
  redis-cli publish DiscoveryEvent '{"type":"SystemPolicy:Changed","ip":"0","msg":{"vpnClient":null}}'
fi

if [[ "$OPT" == "stop" ]]
then
  if [[ -z $PROFILE_ID ]]
  then
    echo "Profile id is not specified."
    exit 1
  fi
  if [[ ! -f "$PROFILE_REPO/$PROFILE_ID.ovpn" ]]
  then
    echo "Profile of specified id does not exist."
    exit 1
  fi

  echo "Stopping vpn client of $PROFILE_ID..."
  redis-cli hset policy:system vpnClient "{\"state\":false,\"type\":\"openvpn\",\"openvpn\":{\"profileId\":\"$PROFILE_ID\"}}"
  redis-cli publish DiscoveryEvent '{"type":"SystemPolicy:Changed","ip":"0","msg":{"vpnClient":null}}'
fi

if [[ "$OPT" == "grant" ]]
then
  if [[ -z "$DEVICE_MAC" ]]
  then
    echo "Device mac is not specified."
    exit 1
  fi
  DEVICE_IP=`redis-cli hget host:mac:$DEVICE_MAC ipv4Addr`
  if [[ -z $DEVICE_IP ]]
  then
    echo "IP address of $DEVICE_MAC is not found"
    exit 1
  fi
  redis-cli hset policy:mac:$DEVICE_MAC vpnClient '{"mode":"dhcp","state":true}'
  redis-cli publish DiscoveryEvent "{\"type\":\"HostPolicy:Changed\",\"ip\":\"$DEVICE_IP\",\"msg\":{\"vpnClient\":null}}"
fi

if [[ "$OPT" == "revoke" ]]
then
  if [[ -z "$DEVICE_MAC" ]]
  then
    echo "Device mac is not specified."
    exit 1
  fi
  DEVICE_IP=`redis-cli hget host:mac:$DEVICE_MAC ipv4Addr`
  if [[ -z $DEVICE_IP ]]
  then
    echo "IP address of $DEVICE_MAC is not found"
    exit 1
  fi
  redis-cli hset policy:mac:$DEVICE_MAC vpnClient '{"mode":"dhcp","state":false}'
  redis-cli publish DiscoveryEvent "{\"type\":\"HostPolicy:Changed\",\"ip\":\"$DEVICE_IP\",\"msg\":{\"vpnClient\":null}}"
fi
