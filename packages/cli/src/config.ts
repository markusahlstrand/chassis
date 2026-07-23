import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The CLI's stored credentials. A service token is a machine credential (the same
 * `SERVICE_TOKEN` the control plane holds); it resolves to the platform's service
 * actor. Kept in `~/.substrat/config.json`, chmod 600 — a home-dir file, never in a
 * repo. A push reads it so you authenticate once with `substrat login`, not per call.
 */
export interface CliConfig {
  controlPlaneUrl?: string;
  serviceToken?: string;
}

const configDir = (): string => join(homedir(), '.substrat');
const configFile = (): string => join(configDir(), 'config.json');

export function loadConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

/** Write the config 0600 (best-effort chmod — a no-op on platforms without it). */
export function saveConfig(cfg: CliConfig): string {
  mkdirSync(configDir(), { recursive: true });
  const path = configFile();
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  return path;
}

export interface ResolvedAuth {
  controlPlaneUrl: string;
  serviceToken: string;
}

/**
 * Resolve the control-plane URL + service token, in precedence order:
 * explicit flag → environment → stored config. Throws a clear, actionable error
 * (pointing at `substrat login`) when either is missing, rather than a 401 later.
 */
export function resolveAuth(flags: { cp?: string; token?: string }): ResolvedAuth {
  const cfg = loadConfig();
  const controlPlaneUrl = flags.cp ?? process.env.SUBSTRAT_CP_URL ?? cfg.controlPlaneUrl;
  const serviceToken = flags.token ?? process.env.SUBSTRAT_SERVICE_TOKEN ?? cfg.serviceToken;
  if (!controlPlaneUrl) {
    throw new Error('no control-plane URL — pass --cp, set SUBSTRAT_CP_URL, or run `substrat login`');
  }
  if (!serviceToken) {
    throw new Error('no service token — pass --token, set SUBSTRAT_SERVICE_TOKEN, or run `substrat login`');
  }
  return { controlPlaneUrl: controlPlaneUrl.replace(/\/$/, ''), serviceToken };
}
