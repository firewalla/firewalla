#!/bin/bash 

: ${FIREWALLA_HOME:=/home/pi/firewalla}

LEGACY_NAME="fishboneVPN1"
INDEX="index.txt"

sudo chmod 777 -R /etc/openvpn
if [[ $(uname -m) == "aarch64" ]] && grep -w $LEGACY_NAME /etc/openvpn/easy-rsa/keys/${INDEX} &>/dev/null; then
  cd /etc/openvpn/easy-rsa
  curl -s -o /dev/null -w "%{http_code}" -X POST --header 'Content-Type: application/json' --header 'Accept: application/json' -d '{ "vpn": {"state": false }}' 'http://localhost:8834/v1/encipher/simple?command=set&item=policy&target=0.0.0.0'
  source ./vars
  ./clean-all
  (cd $FIREWALLA_HOME/vpn; sudo ./install2.sh server)
  sudo chmod 777 -R /etc/openvpn
  sudo bash $FIREWALLA_HOME/scripts/prep/06_check_ovpn_conf.sh 
  curl -s -o /dev/null -w "%{http_code}" -X POST --header 'Content-Type: application/json' --header 'Accept: application/json' -d '{ "vpn": {"state": true }}' 'http://localhost:8834/v1/encipher/simple?command=set&item=policy&target=0.0.0.0'
  cd -
fi

# ovpngen.sh <client name> <keypassword> <public ip> <local port> <original name> <compress algorithm>

NAME=$1
echo "Please enter a Name for the Client:"
echo $NAME

PUBLIC_IP=$3
sed 's/PUBLIC_IP/'$PUBLIC_IP'/' <$FIREWALLA_HOME/vpn/Default.txt >/etc/openvpn/easy-rsa/keys/Default.txt # Default.txt is temporarily used to generate ovpn file
# Set local port
LOCAL_PORT=$4
: ${LOCALPORT:="1194"}
sed -i "s/LOCAL_PORT/$LOCAL_PORT/" /etc/openvpn/easy-rsa/keys/Default.txt

ORIGINAL_NAME=$5
: ${ORIGINAL_NAME:=$NAME}

COMPRESS_ALG=$6
: ${COMPRESS_ALG=""}
 
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

# Change nextUpdate in openssl crl to 3600 days
if [ -f /etc/openvpn/easy-rsa/openssl-1.0.0.cnf ]; then
  sudo sed -i 's/default_crl_days= [0-9]*/default_crl_days= 3600/' /etc/openvpn/easy-rsa/openssl-1.0.0.cnf
fi

source ./vars
if [ -f ~/ovpns/.ovpn.cn ]; then
  # Invalidate previous profile
  PREVIOUS_CN=`cat ~/ovpns/.ovpn.cn`
  echo "revoke previous CN: $PREVIOUS_CN"
  ./revoke-full $PREVIOUS_CN
  sudo cp keys/crl.pem /etc/openvpn/crl.pem
  sudo chmod 644 /etc/openvpn/crl.pem
else
  # Invalidate all previous client profiles
  cat /etc/openvpn/easy-rsa/keys/index.txt | grep "^V" | grep fishboneVPN1 | cut -d/ -f7 | cut -d= -f2 | while read -r line; do
    echo "revoke legacy CN: $line"
    ./revoke-full $line
  done
  sudo cp keys/crl.pem /etc/openvpn/crl.pem
  sudo chmod 644 /etc/openvpn/crl.pem
fi

# create client config file in client-conf-dir
if [[ "x$COMPRESS_ALG" == "x" ]]; then
  sed 's/COMP_LZO_OPT/comp-lzo no/' < $FIREWALLA_HOME/vpn/client_conf.txt > /etc/openvpn/client_conf/$NAME
  sed -i 's/COMPRESS_OPT/compress/' /etc/openvpn/client_conf/$NAME
  sudo chmod 644 /etc/openvpn/client_conf/$NAME
else
  if [[ $COMPRESS_ALG == "lzo" ]]; then
    sed 's/COMP_LZO_OPT/comp-lzo/' < $FIREWALLA_HOME/vpn/client_conf.txt > /etc/openvpn/client_conf/$NAME
    sed -i 's/COMPRESS_OPT/compress lzo/' /etc/openvpn/client_conf/$NAME
    sudo chmod 644 /etc/openvpn/client_conf/$NAME
  else
    sed 's/COMP_LZO_OPT/comp-lzo no/' < $FIREWALLA_HOME/vpn/client_conf.txt > /etc/openvpn/client_conf/$NAME
    sed -i 's/COMPRESS_OPT/compress '$COMPRESS_ALG'/' /etc/openvpn/client_conf/$NAME
    sudo chmod 644 /etc/openvpn/client_conf/$NAME
  fi
fi

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
sudo chmod 600 -R /etc/openvpn
sudo chmod 777 /etc/openvpn
sudo chmod 777 /etc/openvpn/client_conf
sudo chmod 644 /etc/openvpn/crl.pem
sudo chmod 644 /etc/openvpn/client_conf/*
echo "$NAME$FILEEXT moved to home directory."
PASSEXT=".password"
echo -n "$2" > ~/ovpns/$NAME$FILEEXT$PASSEXT
cp ~/ovpns/$NAME$FILEEXT ~/ovpns/$ORIGINAL_NAME.ovpn
cp ~/ovpns/$NAME$FILEEXT$PASSEXT ~/ovpns/$ORIGINAL_NAME.ovpn.password
echo "$NAME" > ~/ovpns/.ovpn.cn
 
# Original script written by Eric Jodoin.
