# CA Certificates Bundle

This directory ships an offline `ca-certificates` Debian package for Firewalla boxes running older Ubuntu releases whose system CA bundle is outdated.

## Maintenance

The bundled `ca-certificates_all.deb` should be refreshed periodically—roughly once a year is usually enough—to include newly issued root CAs and to retire expired ones.

## Obtaining the Latest Package

Download the latest `ca-certificates_*_all.deb` from the official Ubuntu archive:

http://archive.ubuntu.com/ubuntu/pool/main/c/ca-certificates/

After downloading, place the versioned `.deb` file in this directory and point `ca-certificates_all.deb` at it (for example, with a symlink). FireRouter installs the package at boot via `scripts/update_ca_certificates.sh` when the bundled version differs from the version already installed on the system.
