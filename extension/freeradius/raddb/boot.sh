#!/usr/bin/env bash

#ln -sf /etc/freeradius/mods-available/ldap /etc/freeradius/mods-enabled/ldap
ln -sf /etc/freeradius/sites-available/status /etc/freeradius/sites-enabled/status
ln -sf /etc/freeradius/mods-available/json_accounting /etc/freeradius/mods-enabled/json_accounting

mkdir -p /var/log/freeradius/radauth
chown -R freerad:freerad /var/log/freeradius/
chmod 644 /etc/freeradius/wpa3/*
