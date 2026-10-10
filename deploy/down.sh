#!/usr/bin/env bash
# Destroys the leaf-peep Droplet so billing stops. Data and photos on it are deleted.
set -euo pipefail
doctl compute droplet delete --tag-name leaf-peep --force
doctl compute droplet list --tag-name leaf-peep --format Name,Status
echo "Destroyed. Billing for the Droplet has stopped."
