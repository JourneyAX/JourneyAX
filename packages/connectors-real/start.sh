#!/bin/bash
# Starts the real connector server (port 4020) with the vendors' settings from .env.connectors in the project's top folder.
# The settings stay in this one process: the runtime, the gateway and the web app never read that file.
# Stop it with Ctrl-C. See docs/connectors/REAL-SETUP.md.
cd "$(dirname "$0")/../.." || exit 1
if [ ! -f .env.connectors ]; then
  echo "There is no .env.connectors yet. Copy packages/connectors-real/connectors.env.example to .env.connectors and fill in what you have."
  exit 1
fi
exec npx tsx --env-file=.env.connectors packages/connectors-real/src/cli.ts
