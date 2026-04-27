#!/usr/bin/env bash
set -e

# Kill any running instance, ignoring errors if none found
pkill -f 'node index.js' || true

# Wait for the process and its children (GPIO daemons) to exit
sleep 1

# Start the server
exec node index.js
