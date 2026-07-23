#!/usr/bin/env node
/**
 * substrat — authenticated deploy tooling for the platform.
 *
 *   substrat login  [--cp <url>] [--token <serviceToken>]
 *   substrat push   <verticalDir> --slug <slug> --version <v> [--name <name>]
 *                   [--cp <url>] [--token <serviceToken>]
 *
 * Auth is a service token (the control plane's SERVICE_TOKEN), sent as x-service-token
 * and resolved to the platform's service actor. `login` stores it in ~/.substrat/config.json
 * so `push` just works; any command also accepts --cp/--token or SUBSTRAT_CP_URL /
 * SUBSTRAT_SERVICE_TOKEN. A push is not a deploy — the version lands PENDING; admission
 * (in the console) still gates serving.
 */
import { createInterface } from 'node:readline';
import { loadConfig, saveConfig, resolveAuth } from './config.js';
import { browserLogin } from './login.js';
import { push } from './push.js';

const argv = process.argv.slice(2);

/** `--name value` → value, else undefined. */
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Prompt on the TTY for a plain (non-secret) value. */
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const USAGE = `substrat — authenticated deploy tooling

Usage:
  substrat login  [--cp <url>]              sign in via the browser (per-human)
  substrat login  --token <serviceToken>    store a service credential (CI)
  substrat push   <verticalDir> --slug <slug> --version <v> [--name <name>]

Options (any command):
  --cp <url>       control-plane API base, e.g. https://console.substrat.net/api
  --token <tok>    the control plane's SERVICE_TOKEN (service-actor credential, for CI)

Auth resolves: explicit --token/SUBSTRAT_SERVICE_TOKEN → stored browser session →
stored service token. URL resolves flag → SUBSTRAT_CP_URL → ~/.substrat/config.json.
`;

async function cmdLogin(): Promise<void> {
  const existing = loadConfig();
  const cpDefault = existing.controlPlaneUrl ?? 'https://console.substrat.net/api';
  const cp = ((flag('cp') ?? (await ask(`control-plane URL [${cpDefault}]: `))) || cpDefault).replace(/\/$/, '');

  // CI path: a service credential, no browser.
  const serviceToken = flag('token');
  if (serviceToken) {
    const path = saveConfig({ ...existing, controlPlaneUrl: cp, serviceToken });
    console.log(`✓ saved service credential → ${path}`);
    return;
  }

  // Default: browser loopback login → a per-human session token.
  const bearerToken = await browserLogin(cp);
  const path = saveConfig({ ...existing, controlPlaneUrl: cp, bearerToken });
  console.log(`✓ signed in. session saved to ${path}`);
}

async function cmdPush(): Promise<void> {
  const dir = argv[1];
  if (!dir || dir.startsWith('--')) {
    console.error('usage: substrat push <verticalDir> --slug <slug> --version <v> [--name <name>]');
    process.exit(1);
  }
  const slug = flag('slug');
  const version = flag('version');
  if (!slug || !version) {
    console.error('missing --slug and/or --version');
    process.exit(1);
  }
  const { controlPlaneUrl, header, as } = resolveAuth({ cp: flag('cp'), token: flag('token') });
  console.log(`authenticating with ${as}`);
  const v = await push({ dir, slug, version, name: flag('name'), controlPlaneUrl, authHeader: header });
  console.log(`✓ pushed. version ${v.id} is ${v.admission}; deploymentRef=${v.deploymentRef}`);
  console.log('  admit it in the console to let a scope bind it.');
}

async function main(): Promise<void> {
  const command = argv[0];
  switch (command) {
    case 'login':
      return cmdLogin();
    case 'push':
      return cmdPush();
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(USAGE);
      return;
    default:
      console.error(`unknown command '${command}'\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
