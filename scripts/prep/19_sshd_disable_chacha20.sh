#!/bin/bash

# disable chacha20-poly1305 to mitigate CVE-2023-48795

TAG="FIREWALLA:SSHD_NO_CHACHA20"
SSHD_CONFIG=/etc/ssh/sshd_config
MARKER="Firewalla: disable chacha20-poly1305"

case $(lsb_release -rs | cut -d'.' -f1) in
  18|20) ;;
  *) exit 0 ;;
esac

if [[ ! -x /usr/sbin/sshd ]]; then
  logger "$TAG:SKIP:NO_SSHD"
  exit 0
fi

# a patched sshd advertises strict KEX and is not vulnerable, leave it on defaults.
# openssh 9.8 moved kex out of sshd into sshd-session, check both in case a newer
# sshd got installed by hand
if grep -aqs 'kex-strict-s-v00@openssh.com' /usr/sbin/sshd \
    /usr/lib/openssh/sshd-session /usr/libexec/openssh/sshd-session; then
  logger "$TAG:SKIP:STRICT_KEX_SUPPORTED"
  exit 0
fi

if grep -q "$MARKER" $SSHD_CONFIG; then
  logger "$TAG:SKIP:ALREADY_APPLIED"
  exit 0
fi

sudo cp -a $SSHD_CONFIG $SSHD_CONFIG.bak.chacha20 \
  || { logger "$TAG:ERROR:BACKUP_FAILED code $?"; exit 1; }

# insert at the top: keywords take their first obtained value, and anything
# after a Match block would only apply conditionally
sudo sed -i "1i # $MARKER\nCiphers -chacha20-poly1305@openssh.com" $SSHD_CONFIG \
  || { logger "$TAG:ERROR:SED_FAILED code $?"; exit 1; }

if ! sudo sshd -t; then
  logger "$TAG:ERROR:CONFIG_TEST_FAILED, reverting"
  sudo cp -a $SSHD_CONFIG.bak.chacha20 $SSHD_CONFIG
  exit 1
fi

# reload rather than restart so established sessions survive
if systemctl is-active --quiet sshd; then
  sudo systemctl reload sshd || { logger "$TAG:ERROR:RELOAD_FAILED code $?"; exit 1; }
fi

logger "$TAG:DONE"
