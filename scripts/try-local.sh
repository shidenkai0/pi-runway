#!/usr/bin/env bash
# Thin wrapper; see scripts/try-local.mjs.
exec node "$(dirname "$0")/try-local.mjs" "$@"
