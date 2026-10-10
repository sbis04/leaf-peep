#!/usr/bin/env bash
# Creates (or reuses) the leaf-peep Droplet and deploys the app to it.
#   ./deploy/up.sh            Gemma 4 on DigitalOcean serverless inference ($12/mo Droplet, needs MODEL_KEY)
#   MODE=cpu ./deploy/up.sh   Gemma 4 e2b via Ollama on the Droplet's CPU ($48/mo Droplet, no inference API needed)
#   MODE=gemini ./deploy/up.sh  Gemma 4 31B via Google AI Studio (GEMINI_API_KEY in .env), $12/mo Droplet
# Needs: doctl (authenticated), ~/.ssh/leafpeep_ed25519, and ../.env. Billing runs until deploy/down.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=${MODE:-serverless}
NAME=leaf-peep KEY=~/.ssh/leafpeep_ed25519
if [[ $MODE == cpu ]]; then REGION=${REGION:-nyc3} SIZE=${SIZE:-s-4vcpu-8gb} CPU_MODEL=${CPU_MODEL:-gemma4:e2b}
else REGION=${REGION:-tor1} SIZE=${SIZE:-s-1vcpu-2gb}; fi
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

case $MODE in
  cpu) ;;
  gemini) grep -q '^GEMINI_API_KEY=.\+' .env || { echo "Set GEMINI_API_KEY in .env first"; exit 1; } ;;
  *) grep -q '^MODEL_KEY=.\+' .env || { echo "Set MODEL_KEY in .env first (or use MODE=cpu / MODE=gemini)"; exit 1; } ;;
esac

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

rsync -az --delete -e "$SSH" --exclude node_modules --exclude uploads --exclude .git --exclude .drafts --exclude docs ./ root@"$IP":/opt/leaf-peep/
REMOTE_ENV="sed -i 's|^SITE=.*|SITE=$IP.sslip.io|' .env"
PROFILE=""
if [[ $MODE == gemini ]]; then
  REMOTE_ENV+=" && GK=\$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2-) && sed -i -e 's|^MODEL_API=.*|MODEL_API=openai|' -e 's|^MODEL_URL=.*|MODEL_URL=https://generativelanguage.googleapis.com/v1beta/openai|' -e 's|^MODEL_NAME=.*|MODEL_NAME=gemma-4-31b-it|' -e \"s|^MODEL_KEY=.*|MODEL_KEY=\$GK|\" .env && grep -q '^MODEL_JSON_MODE=' .env || echo MODEL_JSON_MODE=false >> .env"
fi
if [[ $MODE == cpu ]]; then
  REMOTE_ENV+=" && sed -i -e 's|^MODEL_API=.*|MODEL_API=ollama|' -e 's|^MODEL_URL=.*|MODEL_URL=http://ollama:11434|' -e 's|^MODEL_NAME=.*|MODEL_NAME=$CPU_MODEL|' .env"
  PROFILE="--profile ollama"
fi
$SSH root@"$IP" "cd /opt/leaf-peep && $REMOTE_ENV && chmod 600 .env && cd deploy && docker compose --env-file ../.env $PROFILE up -d --build"
if [[ $MODE == cpu ]]; then
  echo "Pulling $CPU_MODEL into Ollama…"
  $SSH root@"$IP" "cd /opt/leaf-peep/deploy && docker compose --env-file ../.env --profile ollama exec -T ollama ollama pull $CPU_MODEL"
fi

until curl -fsS "https://$IP.sslip.io/healthz" >/dev/null 2>&1; do sleep 5; done
echo "Live: https://$IP.sslip.io"
