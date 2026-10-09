#!/usr/bin/env bash
# Installs and starts Melete with Docker, from the published images.
#
#   curl -fsSL https://raw.githubusercontent.com/ychampion/melete/main/install.sh | bash
#
# It downloads the Compose file and its configuration into ~/melete (or
# MELETE_DIR), writes deploy/.env once with fresh secrets, pulls the images and
# starts them. Running it again updates the files and images and keeps
# deploy/.env and every volume. Options, all read from the environment:
#
#   MELETE_DIR        where the files go (default ~/melete)
#   MELETE_REF        the branch, tag or commit the files come from (default main)
#   MELETE_IMAGE_TAG  the image tag to run (default main)
#   MELETE_MODEL      the model id to use with ANTHROPIC_API_KEY, OPENAI_API_KEY
#                     or GOOGLE_API_KEY
#   MELETE_NO_OPEN    set to 1 to leave the browser closed
#
# deploy/.env holds the same settings deploy/scripts/configure.ts writes.
#
# Everything runs inside main(), called on the last line, so a download cut
# short runs nothing.

set -euo pipefail

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Melete: %s\n' "$*" >&2
  exit 1
}

# The versions deploy/scripts/configure.ts requires (apps/melete/src/runtime/docker-engine.ts).
REQUIRED_API_VERSION=1.48
REQUIRED_COMPOSE_VERSION=2.33.1

# 0 when $1 >= $2, comparing dotted numbers.
version_at_least() {
  local IFS=.
  local -a have want
  read -r -a have <<<"$1"
  read -r -a want <<<"$2"
  local index
  for index in 0 1 2; do
    local h="${have[index]:-0}" w="${want[index]:-0}"
    if ((10#$h > 10#$w)); then return 0; fi
    if ((10#$h < 10#$w)); then return 1; fi
  done
  return 0
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$(uname -s)" = Linux ]; then
      fail 'Docker is needed. Install Docker Engine with the Compose plugin (https://docs.docker.com/engine/install/), then run this again.'
    fi
    fail 'Docker is needed. Install Docker Desktop (https://docs.docker.com/desktop/), start it, then run this again.'
  fi
  local engine
  if ! engine="$(docker version --format '{{.Server.APIVersion}}' 2>/dev/null)" || [ -z "$engine" ]; then
    fail 'Docker is installed but not running, or this account cannot use it. Start Docker (or add yourself to the docker group), then run this again.'
  fi
  if ! version_at_least "$engine" "$REQUIRED_API_VERSION"; then
    fail "Docker Engine 28.0 or newer is needed (this one speaks API $engine). Update Docker, then run this again."
  fi
  local compose
  compose="$(docker compose version --short 2>/dev/null || true)"
  compose="${compose#v}"
  compose="${compose%%[-+]*}"
  if [ -z "$compose" ]; then
    fail 'Docker Compose v2 is needed. Install the Docker Compose plugin (https://docs.docker.com/compose/install/), then run this again.'
  fi
  if ! version_at_least "$compose" "$REQUIRED_COMPOSE_VERSION"; then
    fail "Docker Compose $REQUIRED_COMPOSE_VERSION or newer is needed (this one is $compose). Update Docker, then run this again."
  fi
  command -v curl >/dev/null 2>&1 || fail 'curl is needed to download the files.'
}

download() {
  local path="$1" target="$2"
  local partial="$target.download"
  curl -fsSL --retry 3 -o "$partial" "$BASE_URL/$path" ||
    fail "Could not download $path from $BASE_URL. Check MELETE_REF and the network."
  mv -f "$partial" "$target"
}

hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
base64_bytes() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
base64url() { base64 | tr -d '\n=' | tr '+/' '-_'; }

# A Web Push (VAPID) key pair, as generateVapidKeys() writes it: the public
# point uncompressed and the private scalar, both base64url without padding.
# The SEC1 DER of a P-256 key has a fixed layout: the scalar at byte 7 (32
# bytes), the public point at byte 56 (65 bytes).
vapid_keys() {
  command -v openssl >/dev/null 2>&1 || return 1
  local der
  der="$(openssl ecparam -name prime256v1 -genkey -noout -outform DER 2>/dev/null | od -An -tx1 -v | tr -d ' \n')" || return 1
  [ "${#der}" -eq 242 ] && [ "${der:0:14}" = 30770201010420 ] && [ "${der:112:2}" = 04 ] || return 1
  VAPID_PRIVATE="$(printf '%s' "${der:14:64}" | hex_to_bytes | base64url)"
  VAPID_PUBLIC="$(printf '%s' "${der:112:130}" | hex_to_bytes | base64url)"
}

hex_to_bytes() {
  local hexdigits
  hexdigits="$(cat)"
  local index
  for ((index = 0; index < ${#hexdigits}; index += 2)); do
    # shellcheck disable=SC2059 # the format is the escaped byte itself
    printf "\\x${hexdigits:index:2}"
  done
}

# The Docker socket's group as melete-cells will see it, as configure.ts measures it.
docker_gid() {
  local os desktop
  os="$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || true)"
  desktop=0
  case "$os" in *[Dd]ocker\ [Dd]esktop*) desktop=1 ;; esac
  case "${DOCKER_HOST:-}" in tcp://* | ssh://* | http://* | https://*) desktop=1 ;; esac
  if [ "$(uname -s)" = Linux ] && [ "$desktop" = 0 ]; then
    [ -S /var/run/docker.sock ] ||
      fail 'There is no Docker socket at /var/run/docker.sock, which the stack mounts. Start Docker Engine, or link its socket to that path.'
    stat -c %g /var/run/docker.sock
    return
  fi
  local image probe
  image="$(sed -n 's/^ *image: *\(postgres:[^ ]*\) *$/\1/p' "$DEPLOY/docker-compose.yml" | head -n 1)"
  [ -n "$image" ] || fail 'Could not find the Postgres image in docker-compose.yml.'
  # Git Bash on Windows would otherwise rewrite the Linux paths below.
  probe="$(MSYS_NO_PATHCONV=1 docker run --rm --network none --entrypoint stat \
    --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
    "$image" -c '%g %a %F' /var/run/docker.sock 2>/dev/null)" ||
    fail 'A container could not inspect /var/run/docker.sock. Check that Docker can run containers.'
  case "$probe" in
    *socket*) printf '%s\n' "${probe%% *}" ;;
    *) fail "/var/run/docker.sock is not a socket on this Docker engine ($probe)." ;;
  esac
}

# The provider settings, as configure.ts's providerSettings() writes them. With
# no key in the environment it is the practice model, as with --fake.
choose_provider() {
  PROVIDER=fake
  PROVIDER_KEY_NAME=''
  local name provider
  for name in FIREWORKS_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY; do
    local value="${!name:-}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    [ -n "$value" ] || continue
    case "$value" in *[[:space:]]*)
      fail "$name contains a space or a line break, so it is not a key as written. Set it again and run this again." ;;
    esac
    case "$name" in
      FIREWORKS_API_KEY) provider=fireworks ;;
      ANTHROPIC_API_KEY) provider=anthropic ;;
      OPENAI_API_KEY) provider=openai ;;
      GOOGLE_API_KEY) provider=google ;;
    esac
    if [ "$provider" != fireworks ] && [ -z "${MELETE_MODEL:-}" ]; then
      say "Found $name. To use it, set MELETE_MODEL to the model id, written exactly as the $provider API expects it, or add it later in Settings → Models."
      continue
    fi
    PROVIDER="$provider"
    PROVIDER_KEY_NAME="$name"
    export MELETE_INSTALL_PROVIDER_KEY="$value"
    return
  done
}

write_env() {
  local template="$DEPLOY/.env.example"
  value() { sed -n "s/^$1=//p" "$template" | head -n 1; }
  local pg_user pg_db password
  pg_user="$(value POSTGRES_USER)"
  pg_db="$(value POSTGRES_DB)"
  pg_user="${pg_user:-melete}"
  pg_db="${pg_db:-melete}"
  password="$(hex 24)"

  choose_provider
  local model fake=false
  if [ "$PROVIDER" = fake ]; then
    fake=true
    model=scripted
  elif [ "$PROVIDER" = "$(value MELETE_DEFAULT_PROVIDER)" ] && [ -z "${MELETE_MODEL:-}" ]; then
    model="$(value MELETE_DEFAULT_MODEL)"
  else
    model="${MELETE_MODEL:-}"
  fi
  case "$model" in *[[:space:]]*) fail 'MELETE_MODEL contains a space.' ;; esac

  VAPID_PUBLIC=''
  VAPID_PRIVATE=''
  vapid_keys || say 'openssl was not found, so phone notifications start off. They can be set up later in deploy/.env.'

  local gid
  gid="$(docker_gid)"

  local voice="${ELEVENLABS_API_KEY:-}"
  case "$voice" in *[[:space:]]*)
    fail 'ELEVENLABS_API_KEY contains a space or a line break, so it is not a key as written. Set it again and run this again.' ;;
  esac

  # Passed to awk through its environment, never on a command line.
  local settings
  settings="MELETE_VAPID_PUBLIC_KEY=$VAPID_PUBLIC
MELETE_VAPID_PRIVATE_KEY=$VAPID_PRIVATE
MELETE_MASTER_KEY=$(base64_bytes 32)
MELETE_CAPABILITY_KEY=$(hex 32)
MELETE_SANDBOX_PROJECT=melete-$(hex 4)
MELETE_APPROVAL_KEY=$(hex 32)
MELETE_RUNTIME_KEY=$(hex 32)
POSTGRES_PASSWORD=$password
DATABASE_URL=postgres://$pg_user:$password@postgres:5432/$pg_db
DOCKER_GID=$gid
MELETE_IMAGE_TAG=$IMAGE_TAG
MELETE_DEFAULT_PROVIDER=$PROVIDER
MELETE_DEFAULT_MODEL=$model
MELETE_ENABLE_FAKE_PROVIDER=$fake
MELETE_ENABLE_TEST_CONNECTOR=$fake"
  if [ -n "$PROVIDER_KEY_NAME" ]; then
    settings="$settings
$PROVIDER_KEY_NAME=@KEY"
  fi
  if [ -n "$voice" ]; then
    export MELETE_INSTALL_VOICE_KEY="$voice"
    settings="$settings
ELEVENLABS_API_KEY=@VOICE"
  fi

  local partial="$DEPLOY/.env.partial"
  rm -f "$partial"
  (
    umask 077
    MELETE_INSTALL_SETTINGS="$settings" awk '
      BEGIN {
        n = split(ENVIRON["MELETE_INSTALL_SETTINGS"], lines, "\n")
        for (i = 1; i <= n; i++) {
          eq = index(lines[i], "=")
          v = substr(lines[i], eq + 1)
          if (v == "@KEY") v = ENVIRON["MELETE_INSTALL_PROVIDER_KEY"]
          if (v == "@VOICE") v = ENVIRON["MELETE_INSTALL_VOICE_KEY"]
          values[substr(lines[i], 1, eq - 1)] = v
        }
      }
      match($0, /^[A-Z_]+=/) {
        name = substr($0, 1, RLENGTH - 1)
        if (name in values) { print name "=" values[name]; next }
      }
      { print }
    ' "$template" >"$partial"
  )
  unset MELETE_INSTALL_PROVIDER_KEY MELETE_INSTALL_VOICE_KEY
  # Written once: a second run, or a race, keeps the file already there.
  if ! ln "$partial" "$DEPLOY/.env" 2>/dev/null; then
    rm -f "$partial"
    fail 'deploy/.env appeared while this ran. Run this again to keep it and start Melete.'
  fi
  rm -f "$partial"
  if [ "$PROVIDER" = fake ]; then
    say 'Created deploy/.env with the practice model.'
  else
    say "Created deploy/.env for the $PROVIDER provider."
  fi
}

open_browser() {
  [ "${MELETE_NO_OPEN:-}" = 1 ] && return 0
  [ -t 1 ] || return 0
  if command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    xdg-open "$1" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then
    open "$1" >/dev/null 2>&1 || true
  fi
}

main() {
  local dir="${MELETE_DIR:-$HOME/melete}"
  local ref="${MELETE_REF:-main}"
  IMAGE_TAG="${MELETE_IMAGE_TAG:-main}"
  BASE_URL="https://raw.githubusercontent.com/ychampion/melete/$ref"
  DEPLOY="$dir/deploy"

  check_docker

  say "Installing Melete into $dir from $ref."
  mkdir -p "$DEPLOY/config" "$dir/packages/runtime-hermes"
  download deploy/docker-compose.yml "$DEPLOY/docker-compose.yml"
  download deploy/.env.example "$DEPLOY/.env.example"
  # Configuration a person may have edited is kept on a second run.
  local file
  for file in connections.json tailscale-serve.json browser-seccomp.json; do
    [ -f "$DEPLOY/config/$file" ] || download "deploy/config/$file" "$DEPLOY/config/$file"
  done

  if [ -f "$DEPLOY/.env" ]; then
    say 'Keeping deploy/.env and your data.'
    if [ -n "${MELETE_IMAGE_TAG:-}" ] || ! grep -q '^MELETE_IMAGE_TAG=.' "$DEPLOY/.env"; then
      local updated="$DEPLOY/.env.partial"
      (umask 077 && sed "s/^MELETE_IMAGE_TAG=.*/MELETE_IMAGE_TAG=$IMAGE_TAG/" "$DEPLOY/.env" >"$updated")
      grep -q '^MELETE_IMAGE_TAG=' "$updated" || printf 'MELETE_IMAGE_TAG=%s\n' "$IMAGE_TAG" >>"$updated"
      mv -f "$updated" "$DEPLOY/.env"
    fi
  else
    write_env
  fi

  local compose=(docker compose -f "$DEPLOY/docker-compose.yml")
  say 'Downloading the images. The first time takes a few minutes.'
  "${compose[@]}" pull --quiet ||
    fail 'Could not pull the images. Check the network, then run this again.'
  say 'Starting Melete.'
  "${compose[@]}" up -d --no-build --remove-orphans --wait --wait-timeout 600 ||
    fail "Melete did not start. See why with: docker compose -f $DEPLOY/docker-compose.yml logs --tail=100"

  local port
  port="$(sed -n 's/^WEB_PORT=//p' "$DEPLOY/.env" | head -n 1)"
  local url="http://localhost:${port:-3101}"
  say ''
  say "Melete is running at $url"
  if grep -q '^MELETE_DEFAULT_PROVIDER=fake$' "$DEPLOY/.env"; then
    say 'Open it and create your account. It starts with a practice model; add your own key in Settings → Models.'
  else
    say 'Open it and create your account.'
  fi
  say "Run this command again to update. Stop it with: docker compose -f $DEPLOY/docker-compose.yml down"
  open_browser "$url"
}

main "$@"
