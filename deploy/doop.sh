#!/usr/bin/env bash
#
# Doop on your own server, with Docker.
#
#   Install:   curl -fsSL https://raw.githubusercontent.com/rbonweb/doop/main/deploy/doop.sh | sudo bash
#   or, from a clone of the repository:   sudo ./deploy/doop.sh setup
#
#   setup             ask a few questions, generate the secrets, start Doop
#   invite EMAIL...   make an invite link for each address (nobody signs up without one)
#   admin EMAIL       make an account an admin, creating it if it does not exist
#   admin --remove EMAIL   take the admin role away again
#   update [TAG]      back up the database, then install the latest release (or TAG)
#   backup            save the database to $DOOP_DATA_DIR/backups
#   restore FILE      replace the database with a backup (asks first)
#   restart           restart Doop, applying any change made to deploy/.env
#   models [agent|distill NAME]   show or change the models (also on the Admin page)
#   status            what runs, and which release
#   logs              follow the app's logs
#
# Every answer can be given in the environment instead (DOOP_URL,
# DOOP_ADMIN_EMAIL, DOOP_ADMIN_NAME, DOOP_ADMIN_PASSWORD, DOOP_ANTHROPIC_KEY,
# DOOP_ANTHROPIC_BASE_URL, DOOP_AGENT_MODEL, DOOP_DISTILL_MODEL, DOOP_PROXY=caddy|own,
# DOOP_DATA_DIR), which is how it runs with no terminal. Everything it keeps
# lives in DOOP_DATA_DIR (default /srv/doop): uploads, the database,
# certificates, backups, and the update requests the Admin page leaves for
# the updater.
set -euo pipefail

REPO_URL=${DOOP_REPO_URL:-https://github.com/rbonweb/doop.git}
INSTALL_DIR=${DOOP_INSTALL_DIR:-/opt/doop}
TAG_PATTERN='^v[0-9A-Za-z][0-9A-Za-z.-]*$'

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '%s\n' "$*"; }
fail() {
  printf '\033[31mError:\033[0m %s\n' "$*" >&2
  exit 1
}
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
secret() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

# ---------------------------------------------------------------- the checkout

# Piped from curl, or a lone copy: fetch the repository (at its latest release
# when there is one) and run the copy inside it.
bootstrap() {
  command -v git >/dev/null || fail "git is not installed (apt install git)"
  if [[ -d $INSTALL_DIR/.git ]]; then
    say "Using the copy of Doop in $INSTALL_DIR"
  else
    local slug tag
    slug=$(printf '%s' "$REPO_URL" | sed -E 's#\.git$##; s#^.*github\.com[:/]##')
    tag=$(latest_tag "$slug")
    say "Downloading Doop ${tag:-(main)} into $INSTALL_DIR"
    git clone --quiet ${tag:+--branch "$tag"} "$REPO_URL" "$INSTALL_DIR"
  fi
  exec bash "$INSTALL_DIR/deploy/doop.sh" "$@"
}

DEPLOY_DIR=
ROOT=
ENV_FILE=
REPO_SLUG=

locate() {
  DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  ROOT=$(dirname "$DEPLOY_DIR")
  ENV_FILE=$DEPLOY_DIR/.env
  REPO_SLUG=${DOOP_UPDATE_REPO:-$(env_get DOOP_UPDATE_REPO)}
  if [[ -z $REPO_SLUG ]]; then
    REPO_SLUG=$(git_ remote get-url origin 2>/dev/null | sed -n -E 's#\.git$##; s#^.*github\.com[:/]##p' || true)
  fi
}

git_() { git -c safe.directory="$ROOT" -C "$ROOT" "$@"; }

# Every compose call runs from this folder, where it reads .env.
compose() { (cd "$DEPLOY_DIR" && docker compose "$@"); }

# ------------------------------------------------------------------ settings

env_get() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1 || true; }

env_set() {
  local tmp
  tmp=$(mktemp "$DEPLOY_DIR/.env.XXXXXX")
  awk -v k="$1" -v v="$2" '
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

data_dir() { env_get DOOP_DATA_DIR; }

# ask VAR "question" [default]: a VAR already in the environment answers it.
ask() {
  local var=$1 question=$2 default=${3:-} answer
  if [[ -n ${!var+set} ]]; then return 0; fi
  need_tty "$var"
  if [[ -n $default ]]; then question+=" [$default]"; fi
  read -r -p "$question: " answer </dev/tty
  printf -v "$var" '%s' "${answer:-$default}"
}

ask_password() {
  local var=$1 question=$2 first second
  if [[ -z ${!var+set} ]]; then
    need_tty "$var"
    while true; do
      read -r -s -p "$question: " first </dev/tty
      printf '\n' >/dev/tty
      read -r -s -p "Once more: " second </dev/tty
      printf '\n' >/dev/tty
      if [[ $first == "$second" && ${#first} -ge 8 ]]; then break; fi
      printf 'The two differ, or are shorter than 8 characters. Again.\n' >/dev/tty
    done
    printf -v "$var" '%s' "$first"
  fi
  local value=${!var}
  if ((${#value} < 8)); then fail "The password must be 8 characters or more"; fi
}

need_tty() { { : </dev/tty; } 2>/dev/null || fail "$1 is not set, and there is no terminal to ask on"; }

# Addresses, given with commas or spaces: lowercase, checked, without repeats.
emails() {
  local e out=()
  for e in $(lower "$1" | tr ',;' '  '); do
    [[ $e =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || fail "\"$e\" is not an email address"
    if [[ " ${out[*]-} " != *" $e "* ]]; then out+=("$e"); fi
  done
  ((${#out[@]})) || fail "Give at least one email address"
  (
    IFS=,
    printf '%s' "${out[*]}"
  )
}

# --------------------------------------------------------------------- checks

need_tools() {
  command -v docker >/dev/null || fail "Docker is not installed: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is not installed (docker compose)"
  docker info >/dev/null 2>&1 || fail "Cannot reach Docker. Run this with sudo, or as a user in the docker group."
  command -v curl >/dev/null || fail "curl is not installed (apt install curl)"
}

need_setup() {
  [[ -f $ENV_FILE ]] || fail "Doop is not set up here yet. Run: $DEPLOY_DIR/doop.sh setup"
}

ports_taken() {
  command -v ss >/dev/null && [[ -n $(ss -Hltn '( sport = :80 or sport = :443 )' 2>/dev/null) ]]
}

# The newest release's tag, or nothing when there is none (or no network).
latest_tag() {
  [[ -n $1 ]] || return 0
  curl -fsSL --max-time 15 -H 'Accept: application/vnd.github+json' \
    "${DOOP_UPDATE_API:-https://api.github.com}/repos/$1/releases/latest" 2>/dev/null |
    grep -o '"tag_name": *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true
}

wait_healthy() {
  local id state
  for _ in $(seq 1 72); do
    id=$(compose ps -q doop 2>/dev/null || true)
    state=$(if [[ -n $id ]]; then docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null; fi || true)
    if [[ $state == healthy ]]; then return 0; fi
    if [[ $state == unhealthy ]]; then return 1; fi
    sleep 5
  done
  return 1
}

# --------------------------------------------------------------- the database

# sql "statement" [name=value...]: the values are quoted by psql (:'name').
sql() {
  local statement=$1 vars=() kv
  shift
  for kv in "$@"; do vars+=(-v "$kv"); done
  printf '%s\n' "$statement" |
    compose exec -T db psql -X -q -t -A -v ON_ERROR_STOP=1 -U doop -d doop "${vars[@]}"
}

backup() {
  need_setup
  local dir file
  dir="$(data_dir)/backups"
  mkdir -p "$dir"
  file="$dir/doop-$(date -u +%Y%m%d-%H%M%S).sql.gz"
  if ! compose exec -T db pg_dump -U doop -d doop | gzip >"$file"; then
    rm -f "$file"
    fail "The database could not be backed up"
  fi
  find "$dir" -name 'doop-*.sql.gz' -mtime +"${DOOP_KEEP_DAYS:-14}" -delete
  note "Database saved to $file"
}

# Replace the database with a backup, saving the current one first.
restore() {
  need_setup
  local file=${1:-} answer
  [[ -f $file ]] || fail "Usage: doop.sh restore $(data_dir)/backups/doop-YYYYMMDD-HHMMSS.sql.gz"
  gzip -t "$file" 2>/dev/null || fail "$file is not a readable backup"
  say "This replaces every account, canvas and setting in the database with $file"
  if [[ ${DOOP_CONFIRM:-} != yes ]]; then
    need_tty DOOP_CONFIRM
    read -r -p "Type yes to go on: " answer </dev/tty
    [[ $answer == yes ]] || fail "Nothing was changed"
  fi
  note "First, the database as it is now:"
  backup
  compose stop doop >/dev/null 2>&1
  if ! compose exec -T db psql -X -q -v ON_ERROR_STOP=1 -U doop -d postgres \
    -c 'DROP DATABASE doop WITH (FORCE)' -c 'CREATE DATABASE doop OWNER doop' >/dev/null ||
    ! gunzip -c "$file" | compose exec -T db psql -X -q -v ON_ERROR_STOP=1 -U doop -d doop >/dev/null; then
    fail "The backup could not be loaded and Doop is stopped. Restore the backup saved just above to go back."
  fi
  compose start doop >/dev/null 2>&1
  wait_healthy || fail "Doop did not start after the restore; see: $DEPLOY_DIR/doop.sh logs"
  note "Restored $file. Uploaded images were not touched: they live in $(data_dir)/data."
}

restart() {
  need_setup
  compose up -d --no-build
  wait_healthy || fail "Doop did not come back; see: $DEPLOY_DIR/doop.sh logs"
  note "Doop is running with the settings in $ENV_FILE"
}

# --------------------------------------------------------------------- people

# The instance settings the Admin page also changes: invites and models
# (server/instanceCli.ts, run inside the app, so nothing restarts).
instance() { compose exec -T doop node_modules/.bin/tsx server/instanceCli.ts "$@"; }

has_account() {
  [[ $(sql 'select count(*) from "user" where lower(email) = :'"'email'" email="$1") != 0 ]]
}

invite() {
  need_setup
  [[ $# -gt 0 ]] || fail "Usage: doop.sh invite EMAIL..."
  local list e fresh=()
  list=$(emails "$*")
  for e in ${list//,/ }; do
    if has_account "$e"; then note "$e already has an account."; else fresh+=("$e"); fi
  done
  ((${#fresh[@]})) || return 0
  note "Send each person their link. It opens the sign-up form for that address, works once and expires in 7 days:"
  instance invite "${fresh[@]}"
}

models() {
  need_setup
  instance models "$@"
}

# Through the app's own sign-up, with an invite, so the account is made
# exactly as one made in the browser.
create_account() {
  printf '%s\n%s\n%s\n%s\n' "$1" "$2" "$3" "$4" | compose exec -T doop node -e '
const [email, name, password, invite] = require("fs").readFileSync(0, "utf8").split("\n")
fetch("http://127.0.0.1:4400/api/auth/sign-up/email", {
  method: "POST",
  headers: { "content-type": "application/json", origin: process.env.BETTER_AUTH_URL, "x-doop-invite": invite },
  body: JSON.stringify({ email, name, password }),
})
  .then(async (res) => { if (!res.ok) throw new Error(await res.text()) })
  .catch((e) => { console.error(String(e.message || e)); process.exit(1) })'
}

admin() {
  need_setup
  if [[ ${1:-} == --remove ]]; then
    [[ $# -eq 2 ]] || fail "Usage: doop.sh admin --remove EMAIL"
    local former
    former=$(emails "$2")
    [[ -n $(sql "update \"user\" set role = 'user' where lower(email) = :'email' and role = 'admin' returning id" email="$former") ]] ||
      fail "$former is not an admin"
    note "$former is no longer an admin."
    return 0
  fi
  [[ $# -eq 1 ]] || fail "Usage: doop.sh admin EMAIL"
  local email
  email=$(emails "$1")
  if ! has_account "$email"; then
    say "$email has no account yet; creating it"
    ask DOOP_ADMIN_NAME "Name for $email"
    ask_password DOOP_ADMIN_PASSWORD "Password for $email (8 characters or more)"
    local token
    token=$(instance invite-token "$email") || fail "The account could not be created"
    create_account "$email" "$DOOP_ADMIN_NAME" "$DOOP_ADMIN_PASSWORD" "$token" || fail "The account could not be created"
  fi
  [[ -n $(sql "update \"user\" set role = 'admin' where lower(email) = :'email' returning id" email="$email") ]] ||
    fail "No account for $email"
  note "$email is an admin: Admin is in the account menu."
}

# ------------------------------------------------------------------ releases

# What the Admin page shows while an update runs (server/selfUpdate.ts).
report() {
  local dir message
  dir="$(data_dir)/updates"
  mkdir -p "$dir"
  message=$(printf '%s' "${3:-}" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   ')
  printf '{"state":"%s","tag":"%s","at":%s,"message":"%s"}\n' "$1" "$2" "$(date +%s%3N)" "$message" >"$dir/status.json.tmp"
  mv "$dir/status.json.tmp" "$dir/status.json"
}

# Pull TAG's image, or build TAG from this checkout when it cannot be pulled.
use_release() {
  local tag=$1 image
  image="ghcr.io/$(lower "$REPO_SLUG"):$1"
  if [[ -n $REPO_SLUG ]] && docker pull --quiet "$image" >/dev/null 2>&1; then
    env_set DOOP_IMAGE "$image"
    note "Using the release image $image"
  else
    note "No image for $tag could be pulled from GHCR; building it on this server (5-10 minutes)."
    build_here "$tag"
  fi
}

# One image per version, so going back to the previous one still finds it.
build_here() {
  env_set DOOP_IMAGE "doop:$1"
  env_set DOOP_BUILD_VERSION "$1"
  compose build doop
}

update() {
  need_setup
  need_tools
  local tag=${1:-}
  if [[ -z $tag ]]; then tag=$(latest_tag "$REPO_SLUG"); fi
  [[ -n $tag ]] || fail "No release of ${REPO_SLUG:-this repository} was found"
  [[ $tag =~ $TAG_PATTERN ]] || fail "\"$tag\" is not a release tag"
  report running "$tag" "Downloading $tag"
  local previous_ref
  previous_ref=$(git_ rev-parse HEAD)
  if ! git_ fetch --quiet --force --tags origin || ! git_ -c advice.detachedHead=false checkout --quiet "refs/tags/$tag"; then
    report failed "$tag" "$tag could not be fetched from $REPO_URL"
    fail "$tag could not be fetched"
  fi
  # the release's own copy of this script installs it
  exec bash "$DEPLOY_DIR/doop.sh" install-release "$tag" "$previous_ref"
}

INSTALLING=

# Whatever stops an install early, the Admin page must not show it running forever.
# shellcheck disable=SC2317 # run by the EXIT trap
on_install_exit() {
  local code=$?
  if ((code != 0)) && grep -q '"state":"running"' "$(data_dir)/updates/status.json" 2>/dev/null; then
    report failed "$INSTALLING" "Installing $INSTALLING stopped with an error, so nothing changed. See: journalctl -u doop-update"
  fi
}

# Put the previous image and checkout back after a release that failed.
put_back() {
  env_set DOOP_IMAGE "$1"
  if [[ -n $2 ]]; then git_ -c advice.detachedHead=false checkout --quiet "$2" || true; fi
}

install_release() {
  local tag=$1 previous_ref=${2:-} previous
  INSTALLING=$tag
  previous=$(env_get DOOP_IMAGE)
  trap on_install_exit EXIT
  report running "$tag" "Backing up the database"
  backup
  report running "$tag" "Installing $tag"
  if ! use_release "$tag"; then
    put_back "$previous" "$previous_ref"
    report failed "$tag" "$tag could not be built, so nothing changed"
    fail "$tag could not be built"
  fi
  compose up -d --no-build >/dev/null 2>&1 || true
  if wait_healthy; then
    report succeeded "$tag" "Installed $tag"
    note "Doop $tag is running."
    return 0
  fi
  report running "$tag" "$tag did not start; going back to the previous version"
  put_back "$previous" "$previous_ref"
  compose up -d --no-build >/dev/null 2>&1 || true
  wait_healthy || true
  report failed "$tag" "$tag did not start, so the previous version is back. See: doop.sh logs"
  fail "$tag did not start; the previous version is running again"
}

# Run by the doop-update systemd unit when the Admin page asks for an update.
apply_request() {
  need_setup
  local request tag latest
  request="$(data_dir)/updates/request.json"
  [[ -f $request ]] || return 0
  tag=$(grep -o '"tag":"[^"]*"' "$request" | head -n 1 | cut -d'"' -f4 || true)
  rm -f "$request"
  latest=$(latest_tag "$REPO_SLUG")
  if [[ -z $tag || $tag != "$latest" ]]; then
    report failed "$tag" "Only the latest release can be installed from the Admin page"
    fail "Refused a request for \"$tag\": the latest release is \"$latest\""
  fi
  update "$tag"
}

# The Admin page's Update now leaves a request; this unit acts on it as root.
install_updater() {
  if [[ $(id -u) != 0 || ! -d /run/systemd/system ]]; then
    note "Updates will be installed from this command line only (no systemd, or not root)."
    return 1
  fi
  cat >/etc/systemd/system/doop-update.path <<EOF
[Unit]
Description=Watch for a Doop update requested from its Admin page

[Path]
PathExists=$1/updates/request.json
Unit=doop-update.service

[Install]
WantedBy=multi-user.target
EOF
  cat >/etc/systemd/system/doop-update.service <<EOF
[Unit]
Description=Install the Doop release its Admin page asked for

[Service]
Type=oneshot
ExecStart=/bin/bash $DEPLOY_DIR/doop.sh apply-request
EOF
  systemctl daemon-reload
  systemctl enable --now doop-update.path >/dev/null 2>&1
  if [[ -d /etc/cron.d ]]; then
    printf '17 3 * * * root /bin/bash %s/doop.sh backup >/dev/null 2>&1\n' "$DEPLOY_DIR" >/etc/cron.d/doop-backup
  fi
}

# --------------------------------------------------------------------- setup

setup() {
  need_tools
  [[ ! -f $ENV_FILE ]] || fail "Doop is already set up here; $ENV_FILE holds its secrets. Use invite, admin or update."
  say "Setting up Doop"

  ask DOOP_URL "The address people will open, e.g. https://doop.yourbrand.com"
  local url domain
  url=$(lower "${DOOP_URL%/}")
  [[ $url =~ ^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$ ]] ||
    fail "Give the full https:// address of the (sub)domain, with no path, e.g. https://doop.yourbrand.com"
  domain=${BASH_REMATCH[1]}

  ask DOOP_ADMIN_EMAIL "Your email, for the admin account (everyone else joins through an invite link)"
  local admin_email
  admin_email=$(emails "$DOOP_ADMIN_EMAIL")
  [[ $admin_email != *,* ]] || fail "Give one email address for the admin account"

  ask DOOP_ANTHROPIC_KEY "Anthropic API key for the built-in agent (Enter to skip)"
  local base=
  if [[ -n $DOOP_ANTHROPIC_KEY ]]; then
    ask DOOP_ANTHROPIC_BASE_URL "Anthropic base URL, for a proxy or compatible endpoint (Enter for Anthropic itself)"
    base=${DOOP_ANTHROPIC_BASE_URL%/}
    note "Model names (Enter keeps the one shown; you can change them any time on the Admin page):"
    ask DOOP_AGENT_MODEL "  Model for the agent" claude-opus-5
    ask DOOP_DISTILL_MODEL "  Model for style-rule suggestions" claude-haiku-4-5-20251001
  fi

  local proxy=${DOOP_PROXY:-}
  if [[ -z $proxy ]]; then
    if ports_taken; then proxy=own; else proxy=caddy; fi
  fi
  [[ $proxy == caddy || $proxy == own ]] || fail "DOOP_PROXY is caddy or own"

  local data=${DOOP_DATA_DIR:-/srv/doop}
  mkdir -p "$data"/{data,postgres,caddy,updates,backups}

  local updater=0
  if install_updater "$data"; then updater=1; fi

  (
    umask 077
    {
      echo "# Written by deploy/doop.sh setup on $(date -u +%F). It holds this server's secrets: keep it private."
      echo "BETTER_AUTH_URL=$url"
      echo "DOOP_DOMAIN=$domain"
      echo "DOOP_INVITE_ONLY=1"
      echo "BETTER_AUTH_SECRET=$(secret)"
      echo "POSTGRES_PASSWORD=$(secret)"
      echo "DOOP_DATA_DIR=$data"
      echo "DOOP_NOINDEX=1"
      echo "COMPOSE_PROFILES=$(if [[ $proxy == caddy ]]; then echo caddy; fi)"
      echo "DOOP_UPDATE_REPO=$REPO_SLUG"
      if ((updater)); then echo "DOOP_UPDATE_DIR=/app/updates"; fi
      if [[ -n $DOOP_ANTHROPIC_KEY ]]; then
        echo "ANTHROPIC_API_KEY=$DOOP_ANTHROPIC_KEY"
        echo "RESIDENT_TASK_LIMIT=1000000"
        echo "DOOP_AGENT_MODEL=$DOOP_AGENT_MODEL"
        echo "DOOP_DISTILL_MODEL=$DOOP_DISTILL_MODEL"
        if [[ -n $base ]]; then echo "ANTHROPIC_BASE_URL=$base"; fi
      fi
    } >"$ENV_FILE"
  )

  say "Starting Doop"
  local tag
  tag=$(latest_tag "$REPO_SLUG")
  if [[ -n $tag ]]; then
    use_release "$tag"
  else
    note "No release is published yet; building this checkout on the server (5-10 minutes)."
    build_here "$(git_ describe --tags --always 2>/dev/null || echo dev)"
  fi
  compose up -d --no-build
  wait_healthy || fail "Doop did not start; see: $DEPLOY_DIR/doop.sh logs"

  say "Your admin account"
  admin "$admin_email"

  say "Doop is running"
  note "  Open           $url"
  if [[ $proxy == caddy ]]; then
    note "                 (its DNS A record must point at this server; the certificate follows by itself)"
  else
    note "                 Ports 80/443 are taken here, so point your proxy at http://127.0.0.1:${DOOP_PORT:-4400}"
    note "                 (deploy/README.md has an nginx example)"
  fi
  note "  Invite         Admin page -> Accounts -> Invite someone, or $DEPLOY_DIR/doop.sh invite friend@example.com"
  note "  Make an admin  $DEPLOY_DIR/doop.sh admin someone@example.com"
  if ((updater)); then
    note "  Update         Admin page -> Update now, or $DEPLOY_DIR/doop.sh update"
  else
    note "  Update         $DEPLOY_DIR/doop.sh update"
  fi
  note "  Back up        $DEPLOY_DIR/doop.sh backup$(if ((updater)); then echo ' (also runs every night)'; fi)"
  note "  Your data      $data"
}

status() {
  need_setup
  note "Release: $(compose exec -T doop printenv DOOP_VERSION 2>/dev/null || echo unknown)"
  note "Image:   $(env_get DOOP_IMAGE)"
  compose ps
}

usage() { sed -n '3,/^set -e/{/^#/p}' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

main() {
  # no checkout around this copy: fetch one and run its script
  if [[ -z ${BASH_SOURCE[0]:-} || ! -f "$(dirname "${BASH_SOURCE[0]}")/docker-compose.yml" ]]; then
    bootstrap "${@:-setup}"
  fi
  locate
  local command=${1:-help}
  shift || true
  case $command in
    setup) setup ;;
    invite) invite "$@" ;;
    admin) admin "$@" ;;
    update) update "$@" ;;
    install-release) install_release "$@" ;;
    apply-request) apply_request ;;
    backup) backup ;;
    restore) restore "$@" ;;
    restart) restart ;;
    models) models "$@" ;;
    status) status ;;
    logs) compose logs -f --tail=200 "${@:-doop}" ;;
    help | -h | --help) usage ;;
    *) fail "Unknown command \"$command\". Run: doop.sh help" ;;
  esac
}

# one line, so a checkout replacing this file mid-run cannot change what runs
main "$@"; exit $?
