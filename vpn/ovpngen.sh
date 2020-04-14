#!/bin/bash 

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

sudo chmod 777 -R /etc/openvpn

if [[ -e /etc/openvpn/easy-rsa/keys ]] && [[ $(uname -m) == "aarch64" ]] && [[ -e /etc/openvpn/easy-rsa/keys2 ]]; then
  bash $FIREWALLA_HOME/scripts/reset-vpn-keys-extended.sh
fi

# ovpngen.sh <common name> <keypassword> <public ip> <external port>

NAME=$1
echo "Please enter a Name for the Client:"
echo $NAME

PUBLIC_IP=$3
sed 's/PUBLIC_IP/'$PUBLIC_IP'/' <$FIREWALLA_HOME/vpn/Default.txt >/etc/openvpn/easy-rsa/keys/Default.txt # Default.txt is temporarily used to generate ovpn file
# Set local port
EXTERNAL_PORT=$4
: ${EXTERNAL_PORT:="1194"}
sed -i "s/EXTERNAL_PORT/$EXTERNAL_PORT/" /etc/openvpn/easy-rsa/keys/Default.txt

PROTO=$5
: ${PROTO:="udp"}
sed -i "s/PROTO/$PROTO/" /etc/openvpn/easy-rsa/keys/Default.txt

 
# Default Variable Declarations 
DEFAULT="Default.txt" 
FILEEXT=".ovpn" 
CRT=".crt" 
OKEY=".key"
KEY=".3des.key" 
CA="ca.crt" 
TA="ta.key" 
 
#Build the client key and then encrypt the key
sudo chmod 777 -R /etc/openvpn
cd /etc/openvpn/easy-rsa
OPENSSL_CNF=$(get_openssl_cnf_file)
# Ensure nextUpdate in openssl crl to 3600 days
if [ -f $OPENSSL_CNF ]; then
  sudo sed -i 's/default_crl_days= [0-9]*/default_crl_days= 3600/' $OPENSSL_CNF
fi

source ./vars
if [ -f ~/ovpns/.ovpn.cn ]; then
  # Invalidate previous profile starts with $NAME, this is specifically for default VPN profile fishboneVPN1xxx
  PREVIOUS_CN=`cat ~/ovpns/.ovpn.cn`
  if [[ $PREVIOUS_CN == $NAME* ]]; then
    echo "revoke previous CN: $PREVIOUS_CN"
    ./revoke-full $PREVIOUS_CN
    rm ~/ovpns/.ovpn.cn
  fi
fi
# Invalidate previous profile with same common name anyway
echo "revoke previous CN: $NAME"
./revoke-full $NAME
sudo cp keys/crl.pem /etc/openvpn/crl.pem
sudo chmod 644 /etc/openvpn/crl.pem

echo "build key pass"
#./build-key-pass $NAME
./pkitool $NAME
echo "After build key pass"
cd keys
openssl rsa -passout pass:$2 -in $NAME$OKEY -des3 -out $NAME$KEY
#openssl rsa -in $NAME$OKEY -des3 -out $NAME$KEY
echo "Openssl done "
 
#1st Verify that client�s Public Key Exists 
if [ ! -f $NAME$CRT ]; then 
 echo "[ERROR]: Client Public Key Certificate not found: $NAME$CRT" 
 exit 
fi 
echo "Client�s cert found: $NAME$CRT" 
 
#Then, verify that there is a private key for that client 
if [ ! -f $NAME$KEY ]; then 
 echo "[ERROR]: Client 3des Private Key not found: $NAME$KEY" 
 exit 
fi 
echo "Client�s Private Key found: $NAME$KEY"
 
#Confirm the CA public key exists 
if [ ! -f $CA ]; then 
 echo "[ERROR]: CA Public Key not found: $CA" 
 exit 
fi 
echo "CA public Key found: $CA" 
 
#Confirm the tls-auth ta key file exists 
if [ ! -f $TA ]; then 
 echo "[ERROR]: tls-auth Key not found: $TA" 
 exit 
fi 
echo "tls-auth Private Key found: $TA" 
 
#Ready to make a new .opvn file - Start by populating with the 
#default file 
cat $DEFAULT > $NAME$FILEEXT 
 
#Now, append the CA Public Cert 
echo "<ca>" >> $NAME$FILEEXT 
cat $CA >> $NAME$FILEEXT 
echo "</ca>" >> $NAME$FILEEXT
 
#Next append the client Public Cert 
echo "<cert>" >> $NAME$FILEEXT 
cat $NAME$CRT | sed -ne '/-BEGIN CERTIFICATE-/,/-END CERTIFICATE-/p' >> $NAME$FILEEXT 
echo "</cert>" >> $NAME$FILEEXT 
 
#Then, append the client Private Key 
echo "<key>" >> $NAME$FILEEXT 
cat $NAME$KEY >> $NAME$FILEEXT 
echo "</key>" >> $NAME$FILEEXT 
 
#Finally, append the TA Private Key 
echo "<tls-auth>" >> $NAME$FILEEXT 
cat $TA >> $NAME$FILEEXT 
echo "</tls-auth>" >> $NAME$FILEEXT 

# Copy the .ovpn profile to the home directory for convenient remote access
cp /etc/openvpn/easy-rsa/keys/$NAME$FILEEXT ~/ovpns/$NAME$FILEEXT
sudo chmod 755 -R /etc/openvpn
sudo chmod 644 /etc/openvpn/crl.pem
sudo chmod 644 /etc/openvpn/client_conf/*
echo "$NAME$FILEEXT moved to home directory."
PASSEXT=".password"
echo -n "$2" > ~/ovpns/$NAME$FILEEXT$PASSEXT
sync
# Original script written by Eric Jodoin.
