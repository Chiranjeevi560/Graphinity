#!/bin/sh
# Installs the scanners CI uses (Linux x64) into .local/tools: official
# release binaries, each checked against its published checksum before use.
# Used by both workflows, so the versions can't drift apart.
set -eu
mkdir -p .local/tools && cd .local/tools
G=https://github.com/gitleaks/gitleaks/releases/download/v8.30.1
curl -sfLO $G/gitleaks_8.30.1_linux_x64.tar.gz && curl -sfLO $G/gitleaks_8.30.1_checksums.txt
grep " gitleaks_8.30.1_linux_x64.tar.gz$" gitleaks_8.30.1_checksums.txt | sha256sum -c -
tar -xzf gitleaks_8.30.1_linux_x64.tar.gz gitleaks
O=https://github.com/google/osv-scanner/releases/download/v2.6.0
curl -sfLO $O/osv-scanner_linux_amd64 && curl -sfLO $O/osv-scanner_SHA256SUMS
grep " osv-scanner_linux_amd64$" osv-scanner_SHA256SUMS | sha256sum -c -
mv osv-scanner_linux_amd64 osv-scanner && chmod +x gitleaks osv-scanner
