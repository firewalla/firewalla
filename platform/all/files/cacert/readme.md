# CA Certificates Bundle

Firewalla boxes on older Ubuntu releases have an outdated system CA bundle, and an updated `ca-certificates` package is reset on reboot. `scripts/update_ca_certificates.sh` installs `ca-certificates` from one of two debs:

- **Asset deb**: `~/.firewalla/run/assets/ca-certificates_all.deb`. `update_assets.sh` downloads it from fireupgrade `/all/ca-certificates_all.deb` (see `platform/all/files/assets.lst`) and checks its sha256 and signature.
- **Bundled deb**: `ca-certificates_all.deb` in this directory, which ships with the release.

The script tries the deb with the higher version first and falls back to the other one if that install fails. It installs only when `ca-certificates` is missing or older than the deb, and does nothing otherwise. It runs from:

- `main-run` at every boot, before `update_assets.sh`. It reinstalls from the last downloaded asset deb without needing the network.
- The asset's `exec_post` when `update_assets.sh` downloads a new asset deb, so a new deb is installed without a reboot or a release.
- The end of every `update_assets.sh` run (at boot and from the daily cron job), next to `patch_system.sh`, which retries an install that failed earlier.

## Responding to a CA incident

When a CA is compromised or distrusted, publish the fixed deb through fireupgrade instead of waiting for a firewalla release:

1. Get the fixed deb from the Ubuntu archive: http://archive.ubuntu.com/ubuntu/pool/main/c/ca-certificates/
   - Use the latest `ubuntu0.22.04.*` security build, for example `ca-certificates_20260816ubuntu0.22.04.1_all.deb`. The plain Debian version without the `ubuntu` suffix (for example `20260816`) can miss Ubuntu's distrust fixes.
   - Check its changelog (`usr/share/doc/ca-certificates/changelog.gz`) for the fix, and check that `Depends` is still satisfied on the oldest image (Ubuntu 18).
   - The version must be higher than the bundled one (`dpkg --compare-versions`), or boxes will not install it.
2. Commit it as `files/all/ca-certificates_all.deb` to the `main` branch of `firewalla/fireupgrade`. CI signs it (`.sha256` and `.sig`) and syncs it to `dev`.
3. Cherry-pick the deb commit and the signing commit to `alpha`, then to `prod`. Boxes pick it up within a day through the daily assets cron, or at the next boot.

## Refreshing the bundled deb

Refresh the bundled deb periodically (roughly once a year) and after a CA incident, so new releases ship with an up-to-date floor. Place the versioned `.deb` in this directory and point the `ca-certificates_all.deb` symlink at it.
