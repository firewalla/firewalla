#!/bin/bash
# ab-restore.sh — Restore a backup bundle to the inactive A/B slot.
#
# Usage: ab-restore.sh [-i input.tar] [--activate]
#   -i FILE      read bundle from FILE
#   --activate   switch ab_slot to the restored slot after restore

set -eo pipefail

PROG=$(basename "$0")
usage() {
    cat >&2 <<EOF
Usage: $PROG [-i input.tar] [--activate]
  -i FILE      read bundle from FILE
  --activate   switch ab_slot to the restored slot after restore

Environment:
  PROMPT=true|false    show confirmation prompt before restore (default: true)
  FORCE_AB=true|false  bypass A/B prerequisite checks — use only when you are
                       certain the system supports A/B boot but checks fail due
                       to corruption or partial setup (default: false)
EOF
    exit 1
}

[ "$(id -u)" -eq 0 ] || { echo "ERROR: must run as root" >&2; exit 1; }

# Verify all A/B boot prerequisites.  Prints one line per failed check;
# returns 1 if any check fails.  Requires /boot mounted and root privileges.
is_ab_boot_enabled() {
    local ok=true label

    # U-Boot env: static A/B variables compiled into the env
    for _var in ab_fail_max ab_total_reboots_max ab_state_addr; do
        fw_printenv "$_var" >/dev/null 2>&1 \
            || { echo "  MISSING u-boot env: $_var" >&2; ok=false; }
    done

    # /boot: A/B state files (single ASCII char each)
    for _f in ab_slot ab_fail_count ab_total_reboots; do
        [ -f "/boot/$_f" ] || { echo "  MISSING /boot/$_f" >&2; ok=false; }
    done

    # /boot: per-slot kernel and initrd files
    for _f in kernelA.itb kernelB.itb initrdA.img initrdB.img; do
        [ -f "/boot/$_f" ] || { echo "  MISSING /boot/$_f" >&2; ok=false; }
    done

    # eMMC: both slot partitions must exist and carry LABEL=root
    for _part in /dev/mmcblk0p2 /dev/mmcblk0p3; do
        if [ ! -b "$_part" ]; then
            echo "  MISSING block device: $_part" >&2; ok=false; continue
        fi
        label=$(blkid -s LABEL -o value "$_part" 2>/dev/null)
        [ "$label" = "root" ] \
            || { echo "  WRONG LABEL on $_part: '${label:-<none>}' (expected 'root')" >&2; ok=false; }
    done

    $ok
}

INPUT=""
ACTIVATE=0

while [ $# -gt 0 ]; do
    case "$1" in
        -i) INPUT="$2"; shift 2 ;;
        -i*) INPUT="${1#-i}"; shift ;;
        --activate) ACTIVATE=1; shift ;;
        -h|--help) usage ;;
        *) usage ;;
    esac
done

[ -n "${INPUT}" ] || usage
[ -f "${INPUT}" ] || { echo "ERROR: input file not found: ${INPUT}" >&2; exit 1; }

CHECKSUM_FILE="${INPUT}.md5"
[ -f "${CHECKSUM_FILE}" ] || { echo "ERROR: checksum file not found: ${CHECKSUM_FILE}" >&2; exit 1; }

{ [ -b /dev/mmcblk0 ] && [ -f /etc/firewalla_release ]; } || usage

ROOT_ARG=$(grep -o 'root=[^ ]*' /proc/cmdline 2>/dev/null)
case "${ROOT_ARG}" in
    *p2*) ACTIVE=A ;;
    *p3*) ACTIVE=B ;;
    *) echo "ERROR: cannot determine active slot from cmdline (${ROOT_ARG})" >&2; exit 1 ;;
esac

if [ "${ACTIVE}" = "A" ]; then
    INACTIVE=B
    INACTIVE_PART=/dev/mmcblk0p3
    INACTIVE_KERNEL=/boot/kernelB.itb
    INACTIVE_INITRD=/boot/initrdB.img
else
    INACTIVE=A
    INACTIVE_PART=/dev/mmcblk0p2
    INACTIVE_KERNEL=/boot/kernelA.itb
    INACTIVE_INITRD=/boot/initrdA.img
fi

if ! mountpoint -q /boot; then
    echo "==> Mounting /boot..."
    mount /dev/mmcblk0p1 /boot
fi

if ! is_ab_boot_enabled; then
    if ${FORCE_AB:-false}; then
        echo "WARNING: A/B boot prerequisite checks failed — proceeding anyway (FORCE_AB=true)" >&2
    else
        echo "ERROR: A/B boot prerequisites not met — aborting" >&2
        echo "       Set FORCE_AB=true to override if you are certain A/B boot should be supported" >&2
        exit 1
    fi
fi

if grep -q "^${INACTIVE_PART} " /proc/mounts; then
    echo "ERROR: inactive slot ${INACTIVE_PART} is currently mounted — unmount it before restore" >&2
    exit 1
fi

echo "==> Active slot: ${ACTIVE}  |  Restore target: inactive slot ${INACTIVE} (${INACTIVE_PART})"

echo "==> Archive metadata:"
tar xfO "${INPUT}" metadata 2>/dev/null || true

if [ "${PROMPT:-true}" = "true" ]; then
    printf "==> Confirm restore to inactive slot ${INACTIVE} (${INACTIVE_PART})? [y/N] "
    read -r _ans
    [ "${_ans}" = "y" ] || [ "${_ans}" = "Y" ] || { echo "Aborted."; exit 1; }
else
    echo "==> Skipping confirmation (PROMPT=false)"
fi

echo "==> Verifying checksum..."
( cd "$(dirname "${INPUT}")" && md5sum -c "$(basename "${CHECKSUM_FILE}")" ) \
    || { echo "ERROR: checksum verification failed: ${INPUT}" >&2; exit 1; }

HAS_ROOTFS=false
tar tf "${INPUT}" rootfs.img.gz &>/dev/null && HAS_ROOTFS=true || true

if ${HAS_ROOTFS}; then
    echo "==> Flashing rootfs → ${INACTIVE_PART}"
    tar xfO "${INPUT}" rootfs.img.gz | gunzip | dd of="${INACTIVE_PART}" bs=4M conv=fsync status=progress
fi

echo "==> Deploying kernel → ${INACTIVE_KERNEL}"
tar xfO "${INPUT}" kernel.itb > "${INACTIVE_KERNEL}.tmp" \
    && mv -f "${INACTIVE_KERNEL}.tmp" "${INACTIVE_KERNEL}" \
    || { rm -f "${INACTIVE_KERNEL}.tmp"; echo "ERROR: failed to extract kernel.itb" >&2; exit 1; }

echo "==> Deploying initrd → ${INACTIVE_INITRD}"
tar xfO "${INPUT}" initrd.img > "${INACTIVE_INITRD}.tmp" \
    && mv -f "${INACTIVE_INITRD}.tmp" "${INACTIVE_INITRD}" \
    || { rm -f "${INACTIVE_INITRD}.tmp"; echo "ERROR: failed to extract initrd.img" >&2; exit 1; }

if ${HAS_ROOTFS}; then
    echo "==> Checking inactive rootfs..."
    e2fsck -f -p "${INACTIVE_PART}" || true
fi

sync

echo "==> Resetting boot counters"
printf '0' > /boot/ab_fail_count
printf '0' > /boot/ab_total_reboots
sync

if [ "${ACTIVATE}" -eq 1 ]; then
    echo "==> Switching ab_slot to ${INACTIVE}"
    if [ "${INACTIVE}" = "B" ]; then
        printf 'B' > /boot/ab_slot
    else
        printf 'A' > /boot/ab_slot
    fi
    MAX=$(fw_printenv ab_fail_max 2>/dev/null | cut -d= -f2)
    echo "==> Slot ${INACTIVE} will be active after reboot (fallback after ${MAX:-3} failures)."
    echo "==> Rebooting..."
    reboot
else
    echo "==> Restore complete. Run with --activate to switch to slot ${INACTIVE} and reboot."
fi
