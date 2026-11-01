#!/bin/sh
# Installs the scanners CI uses (Linux x64) into .local/tools: official release binaries, each checked
# against a checksum written here, not one fetched beside the binary: a tampered release could change
# both. To upgrade, change the version and the hash together, in a commit a person reads.
# Used by both workflows, so the versions can't drift apart.
set -eu
mkdir -p .local/tools && cd .local/tools
G=https://github.com/gitleaks/gitleaks/releases/download/v8.30.1
curl -sfLO $G/gitleaks_8.30.1_linux_x64.tar.gz
echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  gitleaks_8.30.1_linux_x64.tar.gz" | sha256sum -c -
tar -xzf gitleaks_8.30.1_linux_x64.tar.gz gitleaks
O=https://github.com/google/osv-scanner/releases/download/v2.6.0
curl -sfLO $O/osv-scanner_linux_amd64
echo "ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108  osv-scanner_linux_amd64" | sha256sum -c -
mv osv-scanner_linux_amd64 osv-scanner && chmod +x gitleaks osv-scanner
