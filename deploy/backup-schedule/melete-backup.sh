#!/usr/bin/env bash
# An example of a daily backup that leaves this machine, encrypted, and says
# when it did not run (docs/DEPLOYMENT.md, "Backups on a schedule"). Run it
# from cron or from the systemd timer next to it. Set:
#
#   MELETE_BACKUP_TO         where the backup goes: ssh://host:/path
#   MELETE_BACKUP_RECIPIENT  the age1... (or ssh-ed25519) public key it is
#                            encrypted to; keep the private half off this machine
#   MELETE_BACKUP_PING_URL   optional: a check-in address from a monitor that
#                            alerts you when the pings stop. It is called after
#                            each backup that finishes, and with /fail after
#                            one that does not.
#
# Set "backup": { "scheduled": true } in deploy/melete.deploy.json as well, so
# `check` and `status` fail once the newest backup is more than 26 hours old.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

: "${MELETE_BACKUP_TO:?Set MELETE_BACKUP_TO to ssh://host:/path}"
: "${MELETE_BACKUP_RECIPIENT:?Set MELETE_BACKUP_RECIPIENT to an age1... public key}"
ping_url="${MELETE_BACKUP_PING_URL:-}"

ping() {
  if [ -n "$ping_url" ]; then
    curl -fsS -m 10 --retry 3 -o /dev/null "$ping_url$1" || true
  fi
}

if bun run melete backup --to "$MELETE_BACKUP_TO" --encrypt-to "$MELETE_BACKUP_RECIPIENT"; then
  ping ''
else
  status=$?
  ping /fail
  exit "$status"
fi
