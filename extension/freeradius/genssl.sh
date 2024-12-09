#!/usr/bin/env bash

logger "[$(date)] Generate freeradius ssl certification"

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

# source ${FIREWALLA_HOME}/platform/platform.sh

RADIUS_DIR=${FIREWALLA_HIDDEN}/run/docker/freeradius
CERT_DIR=/etc/freeradius/certs

sudo rm -rf ${RADIUS_DIR}/ca.key
sudo rm -rf ${RADIUS_DIR}/ca.pem
touch ${RADIUS_DIR}/ca.key
touch ${RADIUS_DIR}/ca.pem

sudo docker run --rm --volume ${RADIUS_DIR}/ca.cnf:${CERT_DIR}/ca.cnf \
    --volume ${RADIUS_DIR}/ca.key:${CERT_DIR}/ca.key.tmp --volume ${RADIUS_DIR}/ca.pem:${CERT_DIR}/ca.pem.tmp \
    freeradius/freeradius-dev:v3.2.x bash -c "cd ${CERT_DIR} && make ca && cp ca.key ca.key.tmp && cp ca.pem ca.pem.tmp"
