#!/usr/bin/env bash
#
CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

test -e ${CUR_DIR}/../../files/fire-temp-check.sh || exit 0

ROOT_RO=/media/root-ro

if ! cmp -s ${CUR_DIR}/../../files/fire-temp-check.sh ${ROOT_RO}/usr/local/bin/fire-temp-check.sh; then
    sudo install ${CUR_DIR}/../../files/fire-temp-check.sh ${ROOT_RO}/usr/local/bin/
    sudo cp ${CUR_DIR}/../../files/ftc.* ${ROOT_RO}/etc/systemd/system/
    sudo ln -sf /etc/systemd/system/ftc.timer ${ROOT_RO}/etc/systemd/system/timers.target.wants/ftc.timer
fi

if ! cmp -s ${CUR_DIR}/../../files/fire-temp-check.sh /usr/local/bin/fire-temp-check.sh; then
    sudo install ${CUR_DIR}/../../files/fire-temp-check.sh /usr/local/bin/
    sudo cp ${CUR_DIR}/../../files/ftc.* /etc/systemd/system/
    sudo ln -sf /etc/systemd/system/ftc.timer /etc/systemd/system/timers.target.wants/ftc.timer
    sudo systemctl daemon-reload
    sudo systemctl start ftc
fi
