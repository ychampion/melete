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
#   MELETE_BROWSER    set to 1, once your account exists, to turn on the browser
#                     worker: the agent's own browser
#   MELETE_BROWSER_SPACE  with MELETE_BROWSER=1, the space the worker works for
#                     (default the first person's own)
#
# deploy/.env holds the same settings deploy/scripts/configure.ts writes. Once
# the browser worker's space is named there, by MELETE_BROWSER=1 or by
# `bun run melete browser enable`, every run starts the worker too, with
# deploy/docker-compose.browser.yml.
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

# The stack's own pinned Postgres image, which the one-shot helper containers run.
postgres_image() {
  local image
  image="$(sed -n 's/^ *image: *\(postgres:[^ ]*\) *$/\1/p' "$DEPLOY/docker-compose.yml" | head -n 1)"
  [ -n "$image" ] || fail 'Could not find the Postgres image in docker-compose.yml.'
  printf '%s\n' "$image"
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
  image="$(postgres_image)"
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

# A setting in deploy/.env, as deploy/scripts/set-env.ts's withSetting() sets it:
# rewritten where it first stands, or appended. The value reaches awk through its
# environment, never a command line, and the file is replaced in one rename.
set_env() {
  local name="$1" partial="$DEPLOY/.env.partial"
  rm -f "$partial"
  (
    umask 077
    MELETE_INSTALL_NAME="$name" MELETE_INSTALL_VALUE="$2" awk '
      BEGIN { name = ENVIRON["MELETE_INSTALL_NAME"]; done = 0 }
      !done && match($0, "^[ \t]*(export[ \t]+)?" name "[ \t]*=") {
        print name "=" ENVIRON["MELETE_INSTALL_VALUE"]; done = 1; next
      }
      { print }
      END { if (!done) print name "=" ENVIRON["MELETE_INSTALL_VALUE"] }
    ' "$DEPLOY/.env" >"$partial"
  )
  mv -f "$partial" "$DEPLOY/.env"
}

# A setting's value in deploy/.env, or nothing.
env_value() { sed -n "s/^$1=//p" "$DEPLOY/.env" | tail -n 1 | tr -d '\r'; }

# A file's text, or a line of text, as one line of base64; `-` for a missing file.
base64_line() { base64 | tr -d '\n'; }
file_line() {
  if [ -f "$1" ]; then base64_line <"$1"; else printf -- -; fi
  printf '\n'
}
unbase64() {
  if printf 'eA==' | base64 -d >/dev/null 2>&1; then base64 -d; else base64 -D; fi
}

# Replaces a deployment file with new text in one rename, readable by everyone
# (the service reads deploy/config as another user).
replace_public() {
  local target="$1" partial="$1.partial"
  rm -f "$partial"
  (umask 022 && printf '%s' "$2" | unbase64 >"$partial")
  mv -f "$partial" "$target"
}

# The browser worker's uid and gid, as deploy/docker-compose.browser.yml runs it.
BROWSER_UID=10003

# Run as root in a container that sees only the space's own directory at /space.
# The same script as PROVISION_SCRIPT in packages/cli/src/commands/browser.ts: a
# link is refused rather than followed, and only `browser` itself is given to the
# worker, never anything under it nor the space root, whose owner and mode are
# printed so the worker's way through it can be checked.
# shellcheck disable=SC2016 # expanded by the container's shell, not this one
PROVISION_SCRIPT='set -eu
d=/space/browser
if [ -L "$d" ]; then echo "$d is a link" >&2; exit 3; fi
if [ ! -e "$d" ]; then mkdir -m 0700 "$d"; fi
if [ -L "$d" ] || [ ! -d "$d" ]; then echo "$d is not a directory" >&2; exit 3; fi
chown -h 10003:10003 "$d"
chmod 0700 "$d"
stat -c "%u:%g %a" /space "$d"'

# The one-shot container that gives the worker its directory, and nothing more,
# as provisionCommand() in packages/cli/src/commands/browser.ts runs it.
provision_browser_dir() {
  local volume="$1" space="$2" image="$3"
  MSYS_NO_PATHCONV=1 docker run --rm --network none --user 0:0 \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges:true --read-only \
    --mount "type=volume,source=$volume,target=/space,volume-subpath=$space" \
    --entrypoint /bin/sh "$image" -c "$PROVISION_SCRIPT"
}

# Turns on the browser worker, as `bun run melete browser enable` does, with only
# this shell, Docker and the service image: the service makes the space's
# connection and directory, the service image works out the deploy contract and
# the connections file, a one-shot root container makes the worker's directory,
# and the settings are written here. Running it again changes nothing.
enable_browser() {
  local space="$1"
  local base=(docker compose -f "$DEPLOY/docker-compose.yml")
  local overlay=("${base[@]}" -f "$DEPLOY/docker-compose.browser.yml")
  local errors
  errors="$(mktemp)"
  local stop="The browser worker was not turned on"

  # 1. The service makes the space's browser connection and its directory.
  say 'Turning on the browser worker.'
  local answer code=0
  if [ -n "$space" ]; then
    answer="$(MSYS_NO_PATHCONV=1 "${base[@]}" exec -T melete bun run apps/melete/src/workers/browser/enable.ts --space "$space" 2>"$errors")" || code=$?
  else
    answer="$(MSYS_NO_PATHCONV=1 "${base[@]}" exec -T melete bun run apps/melete/src/workers/browser/enable.ts 2>"$errors")" || code=$?
  fi
  local said
  said="$(tr -d '\r' <"$errors" | sed '/^[[:space:]]*$/d' | tail -n 1)"
  if [ "$code" = 2 ]; then
    rm -f "$errors"
    fail "$stop: $said Nothing was changed."
  elif [ "$code" != 0 ]; then
    rm -f "$errors"
    fail "$stop: the service did not answer (${said:-exit $code}). Check that Melete is running and your account exists, then run this again. Nothing was changed."
  fi
  local line pattern='^[{]"space_id":"(sp_[A-Za-z0-9_-]+)","connection_id":"(conn_[A-Za-z0-9_-]+)","created":(true|false)[}]$'
  line="$(printf '%s\n' "$answer" | tr -d '\r' | sed '/^[[:space:]]*$/d' | tail -n 1)"
  [[ "$line" =~ $pattern ]] || {
    rm -f "$errors"
    fail "$stop: the service answered with something other than its result."
  }
  space="${BASH_REMATCH[1]}"
  local connection="${BASH_REMATCH[2]}"

  # 2. The deploy contract and the connections file, worked out by the service
  # image from the files here: only the contract's own settings leave deploy/.env.
  local settings changes
  settings="$(grep -E '^(COMPOSE_PROJECT_NAME|MELETE_IMAGE_TAG|MELETE_IMAGE_REGISTRY|MELETE_SANDBOX_PROVIDER)=' "$DEPLOY/.env" || true)"
  code=0
  changes="$({
    printf '%s' "$settings" | base64_line
    printf '\n'
    file_line "$DEPLOY/melete.deploy.json"
    file_line "$DEPLOY/config/connections.json"
  } | "${base[@]}" exec -T melete bun run melete browser files --connection "$connection" 2>"$errors")" || code=$?
  said="$(tr -d '\r' <"$errors" | sed '/^[[:space:]]*$/d' | tail -n 1)"
  rm -f "$errors"
  [ "$code" = 0 ] || fail "$stop: ${said:-the service image did not work out the files (exit $code)}. deploy/.env and the Compose files were not changed."
  local contract connections
  contract="$(printf '%s\n' "$changes" | tr -d '\r' | sed -n 1p)"
  connections="$(printf '%s\n' "$changes" | tr -d '\r' | sed -n 2p)"
  local b64='^(-|[A-Za-z0-9+/]*={0,2})$'
  if ! [[ "$contract" =~ $b64 && "$connections" =~ $b64 && -n "$contract" && -n "$connections" ]]; then
    fail "$stop: the service image answered with something other than the files. deploy/.env and the Compose files were not changed."
  fi

  # 3. The worker's image: pulled, or the copy already here, or built from a
  # checkout. Compose reads the two settings from this environment first; they
  # only let it read the overlay here, and nothing is started with them.
  local image
  image="$(MELETE_BROWSER_SPACE="$space" MELETE_BROWSER_TOKEN=pull "${overlay[@]}" config --images 2>/dev/null | grep -- '-browser' | head -n 1 || true)"
  if ! MELETE_BROWSER_SPACE="$space" MELETE_BROWSER_TOKEN=pull "${overlay[@]}" pull --quiet browser; then
    if [ -n "$image" ] && docker image inspect "$image" >/dev/null 2>&1; then
      say "Could not pull ${image}; using the copy already on this machine."
    elif [ -f "$DIR/deploy/Dockerfile.browser" ] && [ -f "$DIR/package.json" ]; then
      say "Could not pull ${image:-the browser worker image}; building it from the checkout in $DIR."
      MELETE_BROWSER_SPACE="$space" MELETE_BROWSER_TOKEN=pull "${overlay[@]}" build browser ||
        fail "$stop: the browser worker image did not build. deploy/.env and the Compose files were not changed."
    else
      fail "$stop: the browser worker image ${image:-ghcr.io/ychampion/melete-browser} could not be pulled, so it may not be published yet. Run this again once it is. deploy/.env and the Compose files were not changed."
    fi
  fi

  # 4. The worker's directory, as root on that one subpath of the spaces volume.
  local project volume made
  project="${COMPOSE_PROJECT_NAME:-$(env_value COMPOSE_PROJECT_NAME)}"
  volume="${project:-melete}_spaces"
  docker volume inspect --format '{{.Name}}' "$volume" >/dev/null 2>&1 ||
    fail "$stop: there is no $volume volume on this engine, so Melete has not started here yet."
  made="$(provision_browser_dir "$volume" "$space" "$(postgres_image)" 2>&1)" ||
    fail "$stop: the worker's directory could not be made: $(printf '%s\n' "$made" | tail -n 1). deploy/.env and the Compose files were not changed."
  local root_line browser_line mode
  root_line="$(printf '%s\n' "$made" | sed -n 1p)"
  browser_line="$(printf '%s\n' "$made" | sed -n 2p)"
  [ "$browser_line" = "$BROWSER_UID:$BROWSER_UID 700" ] ||
    fail "$stop: the space's browser directory reads ${browser_line:-nothing}, not $BROWSER_UID:$BROWSER_UID 700. deploy/.env and the Compose files were not changed."
  mode="${root_line##* }"
  if ! [[ "$mode" =~ ^[0-7]+$ ]] || (((8#$mode & 1) == 0)); then
    fail "$stop: the space's own directory (${root_line:-unknown}) cannot be passed through by uid $BROWSER_UID; it was left as it is. deploy/.env and the Compose files were not changed."
  fi

  # 5. The settings: the space and a token (one already there is kept), the
  # overlay in the deploy contract, then the connections file, last, since a
  # start without the overlay refuses it. The token is never printed.
  [ "$(env_value MELETE_BROWSER_SPACE)" = "$space" ] || set_env MELETE_BROWSER_SPACE "$space"
  local token
  token="$(env_value MELETE_BROWSER_TOKEN)"
  token="${token#"${token%%[![:space:]]*}"}"
  token="${token%"${token##*[![:space:]]}"}"
  if [ "${#token}" -lt 32 ] || [[ "$token" =~ [[:space:]] ]]; then
    set_env MELETE_BROWSER_TOKEN "$(hex 32)"
  fi
  [ "$contract" = - ] || replace_public "$DEPLOY/melete.deploy.json" "$contract"
  [ "$connections" = - ] || replace_public "$DEPLOY/config/connections.json" "$connections"

  # 6. The stack, with the worker.
  "${overlay[@]}" up -d --no-build --remove-orphans --wait --wait-timeout 600 ||
    fail "The browser worker's settings are written, but the stack did not become healthy. See why with: ${overlay[*]} logs --tail=100 browser melete, then run this again."
  say "The browser worker is on for $space."
}

main() {
  local dir="${MELETE_DIR:-$HOME/melete}"
  local ref="${MELETE_REF:-main}"
  IMAGE_TAG="${MELETE_IMAGE_TAG:-main}"
  BASE_URL="https://raw.githubusercontent.com/ychampion/melete/$ref"
  DIR="$dir"
  DEPLOY="$dir/deploy"

  # Read once and taken out of the environment, where Compose would read it
  # before deploy/.env.
  local want_browser=0 requested="${MELETE_BROWSER_SPACE:-}"
  unset MELETE_BROWSER_SPACE
  case "${MELETE_BROWSER:-}" in
    1 | true | yes) want_browser=1 ;;
    '' | 0 | false | no) ;;
    *) fail 'MELETE_BROWSER takes 1 to turn on the browser worker.' ;;
  esac
  if [ -n "$requested" ]; then
    [ "$want_browser" = 1 ] || fail 'MELETE_BROWSER_SPACE is read with MELETE_BROWSER=1.'
    [[ "$requested" =~ ^sp_[A-Za-z0-9_-]+$ ]] || fail "MELETE_BROWSER_SPACE takes a space id such as sp_..., not $requested."
  fi

  check_docker

  say "Installing Melete into $dir from $ref."
  mkdir -p "$DEPLOY/config" "$dir/packages/runtime-hermes"
  download deploy/docker-compose.yml "$DEPLOY/docker-compose.yml"
  download deploy/docker-compose.browser.yml "$DEPLOY/docker-compose.browser.yml"
  download deploy/.env.example "$DEPLOY/.env.example"
  # Configuration a person may have edited is kept on a second run.
  local file
  for file in connections.json tailscale-serve.json browser-seccomp.json; do
    [ -f "$DEPLOY/config/$file" ] || download "deploy/config/$file" "$DEPLOY/config/$file"
  done

  if [ -f "$DEPLOY/.env" ]; then
    say 'Keeping deploy/.env and your data.'
    if [ -n "${MELETE_IMAGE_TAG:-}" ] || ! grep -q '^MELETE_IMAGE_TAG=.' "$DEPLOY/.env"; then
      set_env MELETE_IMAGE_TAG "$IMAGE_TAG"
    fi
  else
    write_env
  fi

  # One worker serves one space; a second space runs a worker of its own.
  local configured
  configured="$(env_value MELETE_BROWSER_SPACE)"
  if [ -n "$requested" ] && [ -n "$configured" ] && [ "$requested" != "$configured" ]; then
    fail "The browser worker already works for $configured. One worker serves one space; docs/browser-worker.md shows how to run another for $requested. Nothing was changed."
  fi

  # The browser worker, once turned on, is part of the stack: without its file
  # --remove-orphans would remove it, and the service would refuse to start.
  local compose=(docker compose -f "$DEPLOY/docker-compose.yml") browser=0
  local browser_compose=("${compose[@]}" -f "$DEPLOY/docker-compose.browser.yml")
  if grep -q '^MELETE_BROWSER_SPACE=[^[:space:]]' "$DEPLOY/.env"; then
    browser=1
    compose=("${browser_compose[@]}")
  fi
  say 'Downloading the images. The first time takes a few minutes.'
  if ! "${compose[@]}" pull --quiet; then
    # The browser worker's image may not be published yet: the rest of the
    # stack is pulled, and the worker runs the copy already on this machine.
    local worker
    worker="$("${compose[@]}" config --images 2>/dev/null | grep -- '-browser' | head -n 1 || true)"
    if [ "$browser" = 1 ] && [ -n "$worker" ] && docker image inspect "$worker" >/dev/null 2>&1 &&
      docker compose -f "$DEPLOY/docker-compose.yml" pull --quiet; then
      say "Could not pull ${worker}; the browser worker runs the copy already on this machine."
    else
      fail 'Could not pull the images. Check the network, then run this again.'
    fi
  fi
  say 'Starting Melete.'
  "${compose[@]}" up -d --no-build --remove-orphans --wait --wait-timeout 600 ||
    fail "Melete did not start. See why with: ${compose[*]} logs --tail=100"

  local port
  port="$(sed -n 's/^WEB_PORT=//p' "$DEPLOY/.env" | head -n 1)"
  local url="http://localhost:${port:-3101}"
  if [ "$want_browser" = 1 ]; then
    enable_browser "${requested:-$configured}"
    browser=1
    compose=("${browser_compose[@]}")
  fi
  local shown="${compose[*]}"
  say ''
  say "Melete is running at $url"
  if grep -q '^MELETE_DEFAULT_PROVIDER=fake$' "$DEPLOY/.env"; then
    say 'Open it and create your account. It starts with a practice model; add your own key in Settings → Models.'
  else
    say 'Open it and create your account.'
  fi
  say "Run this command again to update. Stop it with: $shown down"
  if [ "$browser" = 0 ]; then
    say 'To give the agent a browser of its own once your account exists, run this again with MELETE_BROWSER=1:'
    local options='MELETE_BROWSER=1'
    [ -z "${MELETE_DIR:-}" ] || options="$options MELETE_DIR=$dir"
    say "  $options curl -fsSL https://raw.githubusercontent.com/ychampion/melete/$ref/install.sh | bash"
  fi
  open_browser "$url"
}

main "$@"
