#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

ASSETSD_PATH=${FIREWALLA_HIDDEN}/config/assets.d/
CPU_ARCH=$(uname -m)

mkdir -p $ASSETSD_PATH
sudo chown pi:pi $ASSETSD_PATH -R
rm -f $ASSETSD_PATH/*

RELEASE_HASH=$(cat /etc/firewalla_release | grep HASH | cut -d: -f2 | xargs echo -n)

OS_VERSION=u$(lsb_release -r | cut -f2 | cut -d'.' -f1)

 awk '{print $0}' "${FW_PLATFORM_DIR}/all/files/assets.lst" > "${ASSETSD_PATH}/00_assets.lst"

if [ -f "${FW_PLATFORM_CUR_DIR}/files/assets.lst" ]; then
   awk '{print $0}' "${FW_PLATFORM_CUR_DIR}/files/assets.lst" >> "${ASSETSD_PATH}/00_assets.lst"
fi

if [ -f "${FW_PLATFORM_CUR_DIR}/files/${OS_VERSION}/assets.lst" ]; then
   awk '{print $0}' "${FW_PLATFORM_CUR_DIR}/files/${OS_VERSION}/assets.lst" >> "${ASSETSD_PATH}/00_assets.lst"
fi

if [ -f "${FW_PLATFORM_CUR_DIR}/files/${RELEASE_HASH}/patch.lst" ]; then
  cp "${FW_PLATFORM_CUR_DIR}/files/${RELEASE_HASH}/patch.lst" "${ASSETSD_PATH}/05_patch.lst"
fi

if [ -f "${FIREWALLA_HIDDEN}/run/assets/nmap" ]; then
  sudo cp -f "${FIREWALLA_HIDDEN}/run/assets/nmap" $(which nmap)
fi

NSE_FILES="outlib.lua rand.lua tableaux.lua mysql8.lua"

for NFILE in $NSE_FILES
do
  if [ -f "${FIREWALLA_HIDDEN}/run/assets/${NFILE}" ]; then
    if  [ ! -f "/usr/share/nmap/nselib/${NFILE}" ]; then
      sudo ln -s "${FIREWALLA_HIDDEN}/run/assets/${NFILE}" /usr/share/nmap/nselib/${NFILE}
   fi
  fi
done

if [ -f "${FIREWALLA_HIDDEN}/run/assets/libmysqlclient.so.21" ]; then
  if  [ ! -f "/usr/lib/${CPU_ARCH}-linux-gnu/libmysqlclient.so.21" ]; then
    sudo rm -f "/usr/lib/${CPU_ARCH}-linux-gnu/libmysqlclient.so.21" # in case linked to nonexistent target
    sudo ln -s "${FIREWALLA_HIDDEN}/run/assets/libmysqlclient.so.21" /usr/lib/${CPU_ARCH}-linux-gnu/libmysqlclient.so.21
  fi
fi

lualib=$(find /home/pi/.firewalla/run/assets/ -name liblua* -type f -printf "%f")
luaver=5.4 # by default
if [[ $lualib =~ [[:digit:]]\.[[:digit:]] ]];then luaver=${BASH_REMATCH[0]}; fi
if [ -f "${FIREWALLA_HIDDEN}/run/assets/${lualib}" ]; then
  if  [ ! -f "/usr/local/lib/lua/${luaver}/luasql/mysql.so" ]; then
    sudo mkdir -p /usr/local/lib/lua/${luaver}/luasql/
    sudo rm -f "/usr/local/lib/lua/${luaver}/luasql/mysql.so" # in case linked to nonexistent target
    sudo ln -s ${FIREWALLA_HIDDEN}/run/assets/liblua${luaver}-sql-mysql.so /usr/local/lib/lua/${luaver}/luasql/mysql.so
  fi
fi