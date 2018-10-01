#!/bin/bash 

: ${FIREWALLA_HOME:=/home/pi/firewalla}

# ovpngen <clientname> <keypassword> <local ip> <publicip> <dns>

LOCALIP=$3
DNS=$5
: ${DNS:="8.8.8.8"}


# Write config file for server using the template .txt file
sed 's/LOCALIP/'$LOCALIP'/' <$FIREWALLA_HOME/vpn/server_config.txt >/etc/openvpn/server.conf

# Set DNS
sed -i "s=MYDNS=$DNS=" /etc/openvpn/server.conf

if [ $ENCRYPT = 2048 ]; then
 sed -i 's:dh1024:dh2048:' /etc/openvpn/server.conf
fi


PUBLICIP=$4
sed 's/PUBLICIP/'$PUBLICIP'/' <$FIREWALLA_HOME/vpn/Default.txt >/etc/openvpn/easy-rsa/keys/Default.txt
 
# Default Variable Declarations 
DEFAULT="Default.txt" 
FILEEXT=".ovpn" 
CRT=".crt" 
OKEY=".key"
KEY=".3des.key" 
CA="ca.crt" 
TA="ta.key" 

NAME=$1
echo "Please enter a Name for the Client:"
echo $NAME
 
#Build the client key and then encrypt the key
sudo chmod 777 -R /etc/openvpn
cd /etc/openvpn/easy-rsa
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
echo "Client�s cert found: $NAME$CR" 
 
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
sudo chmod 644 /etc/openvpn/crl.pem
echo "$NAME$FILEEXT moved to home directory."
PASSEXT=".password"
echo $2 > ~/ovpns/$NAME$FILEEXT$PASSEXT
cp ~/ovpns/$NAME$FILEEXT ~/ovpns/fishboneVPN1.ovpn
cp ~/ovpns/$NAME$FILEEXT$PASSEXT ~/ovpns/fishboneVPN1.ovpn.password
echo "$NAME" > ~/ovpns/.ovpn.cn
 
# Original script written by Eric Jodoin.
