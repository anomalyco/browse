#!/usr/bin/env bash
set -euo pipefail
uid=$(id -u canary)
if [[ ${1:-} == drop ]]; then
  /usr/sbin/nft add element inet browse_canary offline "{ $uid timeout 15s }"
  sleep 15
  exit 0
fi
# Replace only our own table, atomically. Never drop traffic for other users. The initial extension's default
# connection is refused by the kernel before its profile is configured for :19770. This survives service pauses.
{
  if /usr/sbin/nft list table inet browse_canary >/dev/null 2>&1; then echo 'delete table inet browse_canary'; fi
  cat <<EOF
table inet browse_canary {
  set offline { type uid; flags timeout; }
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid $uid oifname "lo" tcp dport 19988 reject
    meta skuid @offline tcp dport { 53, 80, 443 } drop
    meta skuid @offline udp dport { 53, 443 } drop
  }
}
EOF
} | /usr/sbin/nft -f -
