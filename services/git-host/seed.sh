#!/usr/bin/env bash
# Seeds the demo Git host with the course repositories that do not exist yet.
# Needs no network: everything comes from the files in the image.
#
# The setup scripts of the Session 6 and Session 8 worksheets are run unchanged. They
# create their project in ~/claims-build and ~/claims-review, so HOME points to a
# temporary folder here. Fixed commit dates give the same commit hashes after a restart.
set -euo pipefail

data="${GIT_HOST_DATA:-/data}"
seed="${GIT_HOST_SEED:-/opt/git-host/seed}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
mkdir -p "$HOME" "$data"
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_DATE="2026-11-02T09:00:00+00:00"
export GIT_COMMITTER_DATE="2026-11-02T09:00:00+00:00"
git config --global init.defaultBranch main
git config --global commit.gpgsign false
git config --global advice.detachedHead false

# publish <name> <folder>: the project folder becomes the bare repository <name>.git.
publish() {
    local name="$1" folder="$2" target="$data/$1.git"
    rm -rf "$target.new"
    git clone --quiet --bare "$folder" "$target.new"
    git -C "$target.new" config http.receivepack true
    git -C "$target.new" remote remove origin
    mv "$target.new" "$target"
    echo "Seeded $name.git ($(git -C "$target" symbolic-ref --short HEAD), $(git -C "$target" rev-list --count HEAD) commits)"
}

if [ ! -d "$data/claims-build.git" ]; then
    bash "$seed/session6-setup.sh" >/dev/null
    publish claims-build "$HOME/claims-build"
fi

if [ ! -d "$data/claims-review.git" ]; then
    bash "$seed/session8-setup.sh" >/dev/null
    publish claims-review "$HOME/claims-review"
fi

if [ ! -d "$data/claims-portal.git" ]; then
    cp -R "$seed/claims-portal" "$work/claims-portal"
    cd "$work/claims-portal"
    chmod +x handover.sh panel.sh
    git init --quiet
    git add -A
    git -c user.name="Factory" -c user.email="factory@example.com" commit --quiet \
        -m "Claim status panel after the incident, with the check for CL-7"
    cd "$work"
    publish claims-portal "$work/claims-portal"
fi
