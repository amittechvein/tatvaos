#!/usr/bin/env bash
#
# TatvaOS Mail - WSL2 / Ubuntu provisioning
#
# Installs the Linux side of the dev environment: build tools, mail testing
# utilities, DNS tools, Node 22 via fnm, pnpm, and the .NET 10 SDK.
#
# Called automatically by setup-dev-env.ps1, or run directly inside WSL:
#     bash setup-wsl.sh
#
# Idempotent - safe to re-run. Doubles as a repair/verify pass.

set -uo pipefail

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
    C_RESET=$'\033[0m'; C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'
    C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_GRAY=$'\033[90m'
else
    C_RESET=''; C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_GRAY=''
fi

FAILURES=0

banner() { printf '\n%s%s%s\n%s  %s%s\n%s%s%s\n' \
    "$C_CYAN" "------------------------------------------------------------------------" "$C_RESET" \
    "$C_CYAN" "$1" "$C_RESET" \
    "$C_CYAN" "------------------------------------------------------------------------" "$C_RESET"; }
ok()   { printf '    %s[ ok ]%s %s\n' "$C_GREEN"  "$C_RESET" "$1"; }
skip() { printf '    %s[skip]%s %s\n' "$C_GRAY"   "$C_RESET" "$1"; }
note() { printf '    %s[note]%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
bad()  { printf '    %s[FAIL]%s %s\n' "$C_RED"    "$C_RESET" "$1"; FAILURES=$((FAILURES + 1)); }
step() { printf '\n  %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

banner "TatvaOS Mail - Ubuntu provisioning"

if [ "$(id -u)" -eq 0 ]; then
    bad "Do not run this as root. Run as your normal user; it will sudo when needed."
    exit 1
fi

if ! grep -qi microsoft /proc/version 2>/dev/null; then
    note "Not detected as WSL - continuing anyway (fine on a plain Ubuntu VM)."
fi

if ! sudo -v; then
    bad "sudo authentication failed."
    exit 1
fi

# Keep sudo alive for the duration
while true; do sudo -n true; sleep 60; kill -0 "$$" 2>/dev/null || exit; done 2>/dev/null &
SUDO_KEEPALIVE=$!
trap 'kill "$SUDO_KEEPALIVE" 2>/dev/null || true' EXIT

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------

banner "System packages"

step "Updating apt"
if sudo apt-get update -qq; then ok "apt index updated"; else bad "apt update failed"; fi

step "Upgrading existing packages (this can take a few minutes)"
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq >/dev/null 2>&1 \
    && ok "system upgraded" || note "upgrade reported issues - usually harmless"

APT_PACKAGES=(
    build-essential          # compilers, make
    ca-certificates
    curl wget git unzip zip
    jq                       # JSON on the command line
    htop
    dnsutils                 # dig, nslookup - you will live in these
    net-tools                # netstat
    telnet                   # raw SMTP poking
    swaks                    # THE SMTP testing tool
    postgresql-client        # psql
    redis-tools              # redis-cli
    openssl                  # DKIM keys, cert inspection
    pkg-config
    python3 python3-pip
)

step "Installing tooling"
for pkg in "${APT_PACKAGES[@]}"; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then
        skip "$pkg"
    else
        if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg" >/dev/null 2>&1; then
            ok "$pkg"
        else
            bad "$pkg"
        fi
    fi
done

# ---------------------------------------------------------------------------
# Node via fnm
# ---------------------------------------------------------------------------

banner "Node.js 22 + pnpm"

export FNM_DIR="$HOME/.local/share/fnm"
export PATH="$FNM_DIR:$PATH"

if have fnm; then
    skip "fnm already installed"
else
    step "Installing fnm"
    if curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell >/dev/null 2>&1; then
        ok "fnm installed"
    else
        bad "fnm install failed"
    fi
fi

if have fnm || [ -x "$FNM_DIR/fnm" ]; then
    eval "$("$FNM_DIR/fnm" env --use-on-cd --shell bash 2>/dev/null || true)"

    if "$FNM_DIR/fnm" list 2>/dev/null | grep -q 'v22'; then
        skip "Node 22 already installed"
    else
        step "Installing Node 22 LTS"
        "$FNM_DIR/fnm" install 22 >/dev/null 2>&1 && ok "Node 22" || bad "Node 22 install failed"
    fi
    "$FNM_DIR/fnm" default 22 >/dev/null 2>&1 || true
fi

# pnpm via corepack
if have corepack; then
    step "Enabling pnpm"
    if sudo "$(command -v corepack)" enable >/dev/null 2>&1 || corepack enable >/dev/null 2>&1; then
        corepack prepare pnpm@latest --activate >/dev/null 2>&1 && ok "pnpm activated" || note "pnpm activation deferred"
    else
        note "corepack enable failed - run it manually after restarting the shell"
    fi
else
    note "corepack not available yet - restart the shell, then: corepack enable"
fi

# ---------------------------------------------------------------------------
# .NET 10 SDK
# ---------------------------------------------------------------------------

banner ".NET 10 SDK"

export DOTNET_ROOT="$HOME/.dotnet"

if [ -x "$DOTNET_ROOT/dotnet" ] && "$DOTNET_ROOT/dotnet" --list-sdks 2>/dev/null | grep -q '^10\.'; then
    skip ".NET 10 SDK already installed"
else
    step "Installing .NET 10 SDK"
    if wget -q https://dot.net/v1/dotnet-install.sh -O /tmp/dotnet-install.sh; then
        chmod +x /tmp/dotnet-install.sh
        if /tmp/dotnet-install.sh --channel 10.0 --install-dir "$DOTNET_ROOT" >/dev/null 2>&1; then
            ok ".NET 10 SDK"
        else
            bad ".NET install script failed"
        fi
        rm -f /tmp/dotnet-install.sh
    else
        bad "could not download dotnet-install.sh"
    fi
fi

# ---------------------------------------------------------------------------
# Shell configuration (idempotent)
# ---------------------------------------------------------------------------

banner "Shell configuration"

BASHRC="$HOME/.bashrc"
MARKER="# >>> tatvaos dev env >>>"

if grep -qF "$MARKER" "$BASHRC" 2>/dev/null; then
    skip ".bashrc already configured"
else
    step "Appending environment to .bashrc"
    cat >> "$BASHRC" <<'BASHRC_BLOCK'

# >>> tatvaos dev env >>>
# fnm - Node version manager
export FNM_DIR="$HOME/.local/share/fnm"
if [ -d "$FNM_DIR" ]; then
    export PATH="$FNM_DIR:$PATH"
    eval "$(fnm env --use-on-cd --shell bash)"
fi

# .NET
export DOTNET_ROOT="$HOME/.dotnet"
if [ -d "$DOTNET_ROOT" ]; then
    export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
fi
export DOTNET_CLI_TELEMETRY_OPTOUT=1

# Project shortcut
export TATVAOS_HOME="$HOME/code/tatvaOS"
alias tv='cd "$TATVAOS_HOME"'
# <<< tatvaos dev env <<<
BASHRC_BLOCK
    ok ".bashrc updated"
fi

# ---------------------------------------------------------------------------
# Project directory
# ---------------------------------------------------------------------------

banner "Project directory"

PROJECT_DIR="$HOME/code/tatvaOS"
if [ -d "$PROJECT_DIR" ]; then
    skip "$PROJECT_DIR exists"
else
    mkdir -p "$PROJECT_DIR" && ok "created $PROJECT_DIR"
fi

note "Keep the repo HERE, inside WSL - never on /mnt/c."
note "Cross-filesystem I/O is ~10x slower and you will feel it every day."

# ---------------------------------------------------------------------------
# Docker integration check
# ---------------------------------------------------------------------------

banner "Docker"

if have docker; then
    if docker info >/dev/null 2>&1; then
        ok "Docker reachable from WSL"
    else
        note "docker CLI present but daemon unreachable."
        note "Docker Desktop > Settings > Resources > WSL Integration > enable Ubuntu-24.04"
    fi
else
    note "docker not found in WSL."
    note "Docker Desktop > Settings > Resources > WSL Integration > enable Ubuntu-24.04"
fi

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

banner "Verification"

check() {
    local label="$1"; shift
    local out
    if out=$("$@" 2>/dev/null | head -1); then
        [ -n "$out" ] && ok "$label: $out" || ok "$label"
    else
        bad "$label not working"
    fi
}

# shellcheck disable=SC1090
[ -f "$BASHRC" ] && source "$BASHRC" >/dev/null 2>&1 || true

have git    && check "git"    git --version                  || bad "git missing"
have dig    && ok    "dig: $(dig -v 2>&1 | head -1)"         || bad "dig missing"
have swaks  && check "swaks"  swaks --version                || bad "swaks missing"
have psql   && check "psql"   psql --version                 || bad "psql missing"
have openssl && check "openssl" openssl version              || bad "openssl missing"

if [ -x "$DOTNET_ROOT/dotnet" ]; then
    ok "dotnet: $("$DOTNET_ROOT/dotnet" --version 2>/dev/null)"
else
    bad "dotnet missing"
fi

if have node; then ok "node: $(node --version)"; else note "node - restart the shell, then check again"; fi
if have pnpm; then ok "pnpm: $(pnpm --version)"; else note "pnpm - restart the shell, then check again"; fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

banner "Done"

if [ "$FAILURES" -eq 0 ]; then
    printf '  %sEverything provisioned.%s\n' "$C_GREEN" "$C_RESET"
else
    printf '  %s%d item(s) failed - see [FAIL] lines above.%s\n' "$C_YELLOW" "$FAILURES" "$C_RESET"
fi

cat <<'NEXT'

  Next:
    1. Restart your shell:   exec bash
    2. Confirm Docker:       docker run --rm hello-world
    3. Smoke-test Postgres:
         docker run --rm -d --name pgtest -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17
         sleep 5
         PGPASSWORD=dev psql -h localhost -U postgres -c "SELECT version();"
         docker stop pgtest
    4. Open the project:     tv && code .
    5. Start Sprint 0.1 of the delivery plan.

NEXT

exit 0
