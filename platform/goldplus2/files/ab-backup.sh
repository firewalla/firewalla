#!/bin/bash
# ab-backup.sh — Dump an A/B slot to a tar bundle.
#
# Runtime mode (default): backs up the inactive slot on the running box.
# Image mode (-f): backs up slot A from a Firewalla image file (for OTA/install bundles).
#
# Usage: ab-backup.sh [-o output.tar] [-f image.img]
#   -o FILE      write archive to FILE (default: goldplus2-sysbackup.tar)
#   -f IMAGE     read from image file slot A instead of live inactive slot
#
# Environment:
#   INCLUDE_ROOTFS=true   include rootfs in archive (default)
#   INCLUDE_ROOTFS=false  only backup kernel and initrd
#   TMPDIR=/data/tmp      temp storage for rootfs.img.gz

set -eo pipefail

PROG=$(basename "$0")
usage() {
    cat >&2 <<EOF
Usage: $PROG [-o output.tar] [-f image.img]
  -o FILE      write archive to FILE (default: goldplus2-sysbackup.tar)
  -f IMAGE     read from image file slot A instead of live inactive slot

Environment:
  INCLUDE_ROOTFS=true|false  include rootfs in archive (default: true)
  TMPDIR=DIR                 temp storage for rootfs.img.gz (default: dirname of image, or /data/tmp)
  PROMPT=true|false          prompt before overwriting existing output file (default: true)
  FORCE_AB=true|false        bypass A/B prerequisite checks — use only when you are
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

: ${INCLUDE_ROOTFS:=true}
: ${TMPDIR:=/data/tmp}
OUTPUT=""
IMAGE=""
WORKDIR=""
BOOTMNT=""
LOOPDEV=""

while [ $# -gt 0 ]; do
    case "$1" in
        -o) OUTPUT="$2"; shift 2 ;;
        -o*) OUTPUT="${1#-o}"; shift ;;
        -f) IMAGE="$2"; shift 2 ;;
        -f*) IMAGE="${1#-f}"; shift ;;
        -h|--help) usage ;;
        *) usage ;;
    esac
done

[ -n "${IMAGE}" ] && TMPDIR=$(dirname "$(realpath "${IMAGE}")")

if [ -z "${IMAGE}" ]; then
    { [ -b /dev/mmcblk0 ] && [ -f /etc/firewalla_release ]; } || usage
fi

[ -d "${TMPDIR}" ] || mkdir -m 1777 -p "${TMPDIR}"

cleanup() {
    [ -n "${WORKDIR}" ] && rm -rf "${WORKDIR}"
    if [ -n "${BOOTMNT}" ]; then
        umount "${BOOTMNT}" 2>/dev/null || true
        rm -rf "${BOOTMNT}"
    fi
    [ -n "${LOOPDEV}" ] && losetup -d "${LOOPDEV}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

WORKDIR=$(mktemp -d "${TMPDIR}/ab-backup.XXXXXX")

if [ -n "${IMAGE}" ]; then
    [ -f "${IMAGE}" ] || { echo "ERROR: image file not found: ${IMAGE}" >&2; exit 1; }
    echo "==> Image mode: slot A from ${IMAGE}"
    SLOT=A
    LOOPDEV=$(losetup -Pf --show "${IMAGE}")
    BOOTMNT=$(mktemp -d "${TMPDIR}/ab-bootmnt.XXXXXX")
    mount -o ro "${LOOPDEV}p1" "${BOOTMNT}"
    PART="${LOOPDEV}p2"
    KERNEL="${BOOTMNT}/kernelA.itb"
    INITRD="${BOOTMNT}/initrdA.img"
else
    ROOT_ARG=$(grep -o 'root=[^ ]*' /proc/cmdline 2>/dev/null)
    case "${ROOT_ARG}" in
        *p2*) ACTIVE=A ;;
        *p3*) ACTIVE=B ;;
        *) echo "ERROR: cannot determine active slot from cmdline (${ROOT_ARG})" >&2; exit 1 ;;
    esac
    if [ "${ACTIVE}" = "A" ]; then
        SLOT=B
        PART=/dev/mmcblk0p3
        KERNEL=/boot/kernelB.itb
        INITRD=/boot/initrdB.img
    else
        SLOT=A
        PART=/dev/mmcblk0p2
        KERNEL=/boot/kernelA.itb
        INITRD=/boot/initrdA.img
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
    if grep -q "^${PART} " /proc/mounts; then
        echo "ERROR: inactive slot ${PART} is currently mounted — unmount it before backup" >&2
        exit 1
    fi
    echo "==> Active slot: ${ACTIVE}  |  Backing up inactive slot: ${SLOT} (${PART})"
fi

if [ -z "${OUTPUT}" ]; then
    if [ -n "${IMAGE}" ]; then
        _base=$(basename "${IMAGE}")
        if [[ "${_base}" =~ ^(.*)-([0-9][0-9.]*)\.img$ ]]; then
            _name=${BASH_REMATCH[1]}; _ver=${BASH_REMATCH[2]}
            OUTPUT="$(dirname "$(realpath "${IMAGE}")")/${_name}-sysupgrade-${_ver}.tar"
        else
            OUTPUT="$(dirname "$(realpath "${IMAGE}")")/goldplus2-sysbackup.tar"
        fi
    else
        OUTPUT="${TMPDIR}/goldplus2-sysbackup.tar"
    fi
fi

if [ -f "${OUTPUT}" ]; then
    if [ "${PROMPT:-true}" != "true" ]; then
        echo "==> Removing existing $(realpath "${OUTPUT}") (PROMPT=false)"
        rm -f "${OUTPUT}" "${OUTPUT}.md5"
    else
        echo "ERROR: $(realpath "${OUTPUT}") already exists (set PROMPT=false to overwrite)" >&2
        exit 1
    fi
fi

if [ "${INCLUDE_ROOTFS}" = "true" ]; then
    echo "==> Imaging and compressing rootfs (${PART})..."
    dd if="${PART}" bs=4M status=progress | gzip -1 > "${WORKDIR}/rootfs.img.gz"
    echo "==> Compressed size: $(du -h "${WORKDIR}/rootfs.img.gz" | cut -f1)"
fi

ln -s "${KERNEL}" "${WORKDIR}/kernel.itb"
ln -s "${INITRD}" "${WORKDIR}/initrd.img"
printf 'slot=%s\ntimestamp=%s\n' "${SLOT}" "$(date -u +%Y%m%d-%H%M%S)" > "${WORKDIR}/metadata"

echo "==> Creating bundle → ${OUTPUT}"

ENTRIES="kernel.itb initrd.img metadata"
[ "${INCLUDE_ROOTFS}" = "true" ] && ENTRIES="kernel.itb initrd.img rootfs.img.gz metadata"

tar chf "${OUTPUT}" -C "${WORKDIR}" ${ENTRIES}

echo "==> Generating checksum → ${OUTPUT}.md5"
( cd "$(dirname "${OUTPUT}")" && md5sum "$(basename "${OUTPUT}")" ) > "${OUTPUT}.md5"

echo "==> Done."
echo "==> Output: $(realpath "${OUTPUT}")"
echo "==>         $(realpath "${OUTPUT}.md5")"
