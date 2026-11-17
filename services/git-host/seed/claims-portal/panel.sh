#!/usr/bin/env bash
# Shows the claim status panel for one claim, as a customer sees it.
cd "$(dirname "$0")"
python3 -m src.panel "$1"
