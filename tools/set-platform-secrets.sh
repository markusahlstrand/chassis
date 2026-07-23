#!/usr/bin/env bash
#
# Set the SHARED platform secrets across the control plane, dashboard, and router in one
# shot. These must MATCH across the services that share them, so a value is generated
# ONCE here and set (under the right name) on every service that needs it — removing the
# "wrong value / wrong name" class of error (e.g. the CP's SERVICE_TOKEN vs the
# dashboard's CP_SERVICE_TOKEN).
#
#   value            control plane            dashboard             router
#   ---------------  -----------------------  --------------------  -----------------
#   service token    SERVICE_TOKEN            CP_SERVICE_TOKEN      —
#   platform secret  PLATFORM_SECRET          —                     —        (+ injected into verticals)
#   router secret    ROUTER_SECRET            —                     ROUTER_SECRET  (+ injected into verticals)
#
# PLATFORM_SECRET and ROUTER_SECRET are injected into every pushed vertical by the
# control plane's WfP uploader (control-plane-api/src/wfp.ts), so verticals need no
# secret setup of their own — but the control plane must hold the values, which is why
# they are set here.
#
# NOT touched: per-service secrets (SESSION_SECRET) and external ones (OIDC_*, CF_API_TOKEN)
# — those are not generatable-to-match and rotating SESSION_SECRET would sign everyone out.
#
# DELIBERATELY EXCLUDED — SECRET_BOX_KEY (dashboard). It is an encryption-AT-REST key, the
# opposite of the shared secrets here: these re-agree on a fresh value, but SECRET_BOX_KEY's
# OLD value must SURVIVE to decrypt already-sealed connection credentials. The deployed
# webCryptoSecretBox holds ONE key and open() throws on a keyId mismatch, so replacing it
# irreversibly orphans every stored credential (recovery = reconnect each provider). Real
# rotation needs a keyring SecretBox (seal under the new keyId; open by the ciphertext's
# keyId, holding old+new) + a re-seal sweep — the keyId field is ready; the impl is not.
# Until then: set SECRET_BOX_KEY once, back it up, and leave it out of any rotation.
#
# ROTATES: running this replaces the current values. Afterwards:
#   1. redeploy the control plane   (so the injector reads the new PLATFORM_SECRET/ROUTER_SECRET)
#   2. re-push any verticals         (their injected secrets change with the values above)
#
# Usage:  tools/set-platform-secrets.sh
#   CLOUDFLARE_ACCOUNT_ID overrides the default account; -y skips the confirmation.
set -euo pipefail

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-8cbb7553a78d4d4bc4159906c77214a3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" != "-y" ]; then
  echo "This ROTATES the shared platform secrets on substrat-control-plane, substrat-dashboard,"
  echo "and substrat-router (account ${CLOUDFLARE_ACCOUNT_ID}). Current values are replaced."
  read -r -p "Proceed? [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "aborted."; exit 1; }
fi

gen() { openssl rand -hex 32; }

# One value per shared secret; the SAME value goes to every service that needs it.
SERVICE_TOKEN="$(gen)"
PLATFORM_SECRET="$(gen)"
ROUTER_SECRET="$(gen)"

# put <app-dir> <secret-name> <value> — the value is piped so wrangler runs non-interactively;
# printf (no trailing newline) keeps the stored value exactly the generated string.
put() {
  printf '%s' "$3" | ( cd "$ROOT/$1" && pnpm exec wrangler secret put "$2" >/dev/null )
  echo "  ✓ $2 → $(basename "$1")"
}

echo "control plane:"
put apps/control-plane SERVICE_TOKEN   "$SERVICE_TOKEN"
put apps/control-plane PLATFORM_SECRET "$PLATFORM_SECRET"
put apps/control-plane ROUTER_SECRET   "$ROUTER_SECRET"

echo "dashboard:"
put apps/dashboard CP_SERVICE_TOKEN "$SERVICE_TOKEN"

echo "router:"
put apps/router ROUTER_SECRET "$ROUTER_SECRET"

echo
echo "✓ shared secrets set consistently. Next:"
echo "    pnpm --filter @substrat-run/control-plane cf:deploy      # injector picks up the new values"
echo "    pnpm substrat push demos/callout --slug callout --version <next>   # vertical re-gets the injected secrets"
