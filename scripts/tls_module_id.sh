#!/bin/bash
#
# Identity of a TLS kernel module, used to tell whether the module currently loaded in the
# kernel is the one built from the .ko we ship.
#
#   tls_module_id.sh loaded <module_name>       print the loaded module's id, or nothing
#   tls_module_id.sh file   <ko_path>           print the bundled .ko's id, or nothing
#   tls_module_id.sh same   <module_name> <ko_path>
#                                               exit 0 same, 1 different, 2 cannot tell
#   tls_module_id.sh describe <ko_path>         print what identifies the bundled .ko:
#                                                 version=<v>      (if the module carries one)
#                                                 srcversion=<sv>  (if the module carries one)
#                                                 id=<type>:<hex>  (its strongest id)
#
# Ids are type-tagged ("srcversion:<hex>", "buildid:<hex>", "sha256:<hex>") and only ids of
# the same type are comparable, hence "same" instead of a string compare by the caller.
#
# Newer kernels build these modules without MODULE_VERSION and without
# CONFIG_MODULE_SRCVERSION_ALL - on orange's aarch64 6.6.104 neither modinfo nor
# /sys/module/<m>/{version,srcversion} carries anything. What does survive on both sides is
# the GNU build-id: the kernel exposes the loaded module's note in
# /sys/module/<m>/notes/.note.gnu.build-id, and the same note sits in the .ko itself. Both
# sides can therefore be identified without recording anything at load time.
#
# version and srcversion of a .ko come from modinfo(8), which needs the file name to end in a
# module extension: gse ships its modules as xt_udp_tls.ko.<kernel checksum> with a
# xt_udp_tls.ko.<compiler> symlink pointing at it, and modinfo refuses both names. Pointing a
# temporary <module>.ko symlink at the file is enough to make modinfo read it (see ko_modinfo),
# whatever the real name is and whether or not the module is compressed.
# The build-id is not something modinfo reports, so that one is read out of the module image.
#
# Verified on gold 6.5/5.15, pse 5.15.78, gse 5.10.110, purple 4.9.241, orange 6.6.104 and
# goldplus2 6.6.104: every one of them exposes notes/.note.gnu.build-id for loaded modules.
#
# sha256 of the whole file is the last resort. It is only ever compared against an id of the
# same file taken at another time (KernelCrashMonitor's record of the module that was loaded
# when a crash happened), never against the loaded module.

mode=$1

# a GNU build-id note is namesz=4 descsz=20 type=3 "GNU\0" followed by the 20-byte id.
# Only sha1-sized (0x14) ids are recognized; anything else falls through to another id type.
NOTE_PREFIX_HEX='040000001400000003000000474e5500'

function hex_of {
  od -An -v -tx1 | tr -d ' \n'
}

# ── loaded module ────────────────────────────────────────────────────────────
# every id the kernel exposes for the loaded module, strongest first. build-id comes first
# because it identifies the build, while srcversion only hashes the sources: the same sources
# built with another toolchain or config keep their srcversion but are a different module.
function loaded_ids {
  local module_name=$1 hex
  [[ -n $module_name ]] || return 1
  local note_path="/sys/module/${module_name}/notes/.note.gnu.build-id"
  if [[ -r $note_path ]]; then
    hex=$(hex_of < "$note_path")
    [[ $hex =~ ^${NOTE_PREFIX_HEX}([0-9a-f]{40})$ ]] && echo "buildid:${BASH_REMATCH[1]}"
  fi
  local srcversion_path="/sys/module/${module_name}/srcversion"
  if [[ -r $srcversion_path ]]; then
    read -r hex < "$srcversion_path"
    [[ -n $hex ]] && echo "srcversion:${hex}"
  fi
}

# ── bundled .ko ──────────────────────────────────────────────────────────────
# the module image, decompressed if needed, on stdout
function ko_image {
  local ko_path=$1 magic
  [[ -r $ko_path ]] || return 1
  magic=$(od -An -N4 -v -tx1 < "$ko_path" | tr -d ' \n')
  case $magic in
    fd377a58) xz -dc -- "$ko_path" 2>/dev/null ;;   # XZ
    28b52ffd) zstd -dc -- "$ko_path" 2>/dev/null ;; # zstd
    1f8b*)    gzip -dc -- "$ko_path" 2>/dev/null ;; # gzip
    *)        cat -- "$ko_path" ;;
  esac
}

# On success IMAGE holds the decompressed module image. Fails when the file cannot be read,
# when no decompressor handled it, or when the result does not look like a complete module:
# vermagic= is present in every loadable module, and requiring it keeps a partially written
# or truncated file from yielding an id. That matters because an id derived from a corrupt
# file could differ from the loaded module and trigger a reload that then fails to insmod -
# without an id the caller is told "cannot tell" and leaves the working module alone.
IMAGE=""
function ensure_image {
  local ko_path=$1
  [[ -n $IMAGE ]] && return 0
  [[ -r $ko_path ]] || return 1
  IMAGE=$(mktemp) || { IMAGE=""; return 1; }
  trap 'rm -f "$IMAGE"' EXIT
  ko_image "$ko_path" > "$IMAGE" 2>/dev/null || { rm -f "$IMAGE"; IMAGE=""; return 1; }
  grep -a -q 'vermagic=' "$IMAGE" || { rm -f "$IMAGE"; IMAGE=""; return 1; }
  return 0
}

# modinfo output for a .ko whatever its file name is: modinfo only accepts names ending in a
# module extension, so files like xt_udp_tls.ko.<kernel checksum> (and the .ko.<compiler>
# symlink gse points at it) get a temporary <module>.ko symlink to read through. modinfo
# handles the compressed ones itself.
function ko_modinfo {
  local ko_path=$1
  [[ -r $ko_path ]] || return 1
  [[ $ko_path == *.ko ]] && { modinfo "$ko_path" 2>/dev/null; return; }
  local dir link rc
  dir=$(mktemp -d) || return 1
  link="${dir}/$(basename "${ko_path%%.ko*}").ko"
  ln -s "$(readlink -f "$ko_path")" "$link" || { rm -rf "$dir"; return 1; }
  modinfo "$link" 2>/dev/null
  rc=$?
  rm -rf "$dir"
  return $rc
}

# On success MODINFO holds modinfo's output for the .ko. Fails when modinfo cannot parse the
# file at all, which - like the vermagic check above - is how a corrupt file is told apart from
# a module: every module modinfo can read reports a vermagic.
MODINFO=""
MODINFO_TRIED=0
function ensure_modinfo {
  [[ $MODINFO_TRIED -eq 1 ]] && { [[ -n $MODINFO ]]; return; }
  MODINFO_TRIED=1
  MODINFO=$(ko_modinfo "$1")
  grep -q '^vermagic:' <<< "$MODINFO" || MODINFO=""
  [[ -n $MODINFO ]]
}

# every id the bundled .ko yields, strongest first, in the same order as loaded_ids
function file_ids {
  local ko_path=$1 hex is_module=0
  [[ -r $ko_path ]] || return 1
  if ensure_image "$ko_path"; then
    is_module=1
    hex=$(hex_of < "$IMAGE")
    [[ $hex =~ ${NOTE_PREFIX_HEX}([0-9a-f]{40}) ]] && echo "buildid:${BASH_REMATCH[1]}"
  fi
  if ensure_modinfo "$ko_path"; then
    is_module=1
    hex=$(awk '/^srcversion:/{print $2; exit}' <<< "$MODINFO")
    [[ -n $hex ]] && echo "srcversion:${hex}"
  fi
  # Hashing the raw file is the last resort, and only for a file that proved to be a module:
  # neither the image nor modinfo vouching for it means it is corrupt or truncated, and a hash
  # of that would still look like a perfectly good identity - one that differs from the stored
  # one, which is enough for KernelCrashMonitor to clear a crash-safety disable. With no id at
  # all the caller is told "unknown" instead and leaves that decision untouched.
  [[ $is_module -eq 1 ]] || return 1
  hex=$(sha256sum "$ko_path" 2>/dev/null | awk '{print $1}')
  [[ -n $hex ]] && echo "sha256:${hex}"
}

# id_of_type <type> <id>... : the id of that type among the given ones, empty if absent
function id_of_type {
  local id_type=$1; shift
  local id
  for id in "$@"; do
    [[ $id == "${id_type}:"* ]] && { echo "$id"; return 0; }
  done
  return 1
}

case "$mode" in
  loaded)
    loaded_ids "$2" | sed -n 1p
    ;;
  file)
    file_ids "$2" | sed -n 1p
    ;;
  describe)
    # prepared up front so the file_ids call below reuses both instead of decompressing the
    # module and running modinfo a second time
    ensure_image "$2"
    if ensure_modinfo "$2"; then
      value=$(awk '/^version:/{print $2; exit}' <<< "$MODINFO")
      [[ -n $value ]] && echo "version=${value}"
      value=$(awk '/^srcversion:/{print $2; exit}' <<< "$MODINFO")
      [[ -n $value ]] && echo "srcversion=${value}"
    fi
    id=$(file_ids "$2" | sed -n 1p)
    [[ -n $id ]] || exit 1
    echo "id=${id}"
    ;;
  same)
    mapfile -t loaded < <(loaded_ids "$2")
    mapfile -t file < <(file_ids "$3")
    # compare on the strongest id type available on both sides. sha256 is deliberately not
    # in this list: it cannot be derived from a loaded module, so a file that yields nothing
    # but a hash (unreadable image, no build-id, no srcversion) is simply not comparable.
    for id_type in buildid srcversion; do
      lhs=$(id_of_type "$id_type" "${loaded[@]}")
      rhs=$(id_of_type "$id_type" "${file[@]}")
      [[ -n $lhs && -n $rhs ]] || continue
      [[ $lhs == "$rhs" ]] && exit 0 || exit 1
    done
    exit 2
    ;;
  *)
    echo "Usage: $0 loaded <module_name> | file <ko_path> | describe <ko_path> | same <module_name> <ko_path>" >&2
    exit 2
    ;;
esac