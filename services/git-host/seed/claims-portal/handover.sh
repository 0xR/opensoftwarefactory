#!/usr/bin/env bash
# The handover: runs the required checks on the whole result, whatever tool changed it.
# Prints "Accepted" (exit code 0) or "Rejected: <reason>" (exit code 1).
cd "$(dirname "$0")"
if reason=$(python3 checks/check_cl7.py 2>&1); then
  echo "Accepted"
  exit 0
fi
echo "Rejected: $(printf '%s\n' "$reason" | tail -n 1)"
exit 1
