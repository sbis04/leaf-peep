#!/usr/bin/env bash
# Creates (or reuses) the leaf-peep Droplet and deploys the app to it.
# Needs: doctl (authenticated), ~/.ssh/leafpeep_ed25519, and ../.env with MODEL_KEY.
# Cost: an s-1vcpu-2gb Droplet is $12/month, billed until you run deploy/down.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=leaf-peep REGION=tor1 SIZE=s-1vcpu-2gb KEY=~/.ssh/leafpeep_ed25519
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

grep -q '^MODEL_KEY=.\+' .env || { echo "Set MODEL_KEY in .env first"; exit 1; }

IP=$(doctl compute droplet list --tag-name "$NAME" --format PublicIPv4 --no-header | head -1)
if [[ -z "$IP" ]]; then
  KEY_ID=$(doctl compute ssh-key list --format ID,Name --no-header | awk '$2=="leaf-peep-deploy"{print $1}')
  [[ -n "$KEY_ID" ]] || KEY_ID=$(doctl compute ssh-key import leaf-peep-deploy --public-key-file "$KEY.pub" --format ID --no-header)
  echo "Creating Droplet ($SIZE in $REGION)…"
  IP=$(doctl compute droplet create "$NAME" --region "$REGION" --size "$SIZE" --image ubuntu-24-04-x64 \
    --ssh-keys "$KEY_ID" --user-data-file deploy/cloud-init.yml --enable-monitoring --tag-name "$NAME" \
    --wait --format PublicIPv4 --no-header)
fi
echo "Droplet: $IP"

echo "Waiting for Docker…"
until $SSH root@"$IP" 'test -f /root/cloud-init-done && docker --version' >/dev/null 2>&1; do sleep 10; done

rsync -az --delete -e "$SSH" --exclude node_modules --exclude uploads --exclude .git ./ root@"$IP":/opt/leaf-peep/
$SSH root@"$IP" "cd /opt/leaf-peep && sed -i 's|^SITE=.*|SITE=$IP.sslip.io|' .env && chmod 600 .env && cd deploy && docker compose --env-file ../.env up -d --build"

until curl -fsS "https://$IP.sslip.io/healthz" >/dev/null 2>&1; do sleep 5; done
echo "Live: https://$IP.sslip.io"
