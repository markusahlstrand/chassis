import { useState } from 'react';
import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { Badge, Dialog, Input, Select } from '../components';
import type { Api } from '../lib/api';
import {
  createInstance,
  INSTANCE_STEPS,
  InstanceStepError,
  type InstanceStep,
} from '../lib/create-instance';

/**
 * Create one instance of a vertical — the end of the flow this whole milestone was
 * for: sign up, pick a template, get something that answers on a URL.
 *
 * Five steps in a fixed order, and the order is load-bearing:
 *
 *   1. tenant            — the directory root everything else hangs from
 *   2. instance          — the VERTICAL provisions, because only it can create a
 *                          usable scope DO (K-31); the DO class bundles the modules
 *                          and lives in the vertical's deployment
 *   3. scope row         — the directory record, written AFTER the vertical succeeds
 *                          so a failure leaves an invisible orphan rather than a row
 *                          promising a scope that is not there
 *   4. bind hostname     — recorded, not yet serving
 *   5. activate          — last, because a hostname must never resolve before the
 *                          thing behind it exists (K-26)
 *
 * Every id is minted here rather than server-side: caller-supplied ids are what make
 * these operations idempotent, so a retry re-sends the same one instead of creating a
 * second of everything (§4.1).
 */

export interface CreateInstanceProps {
  api: Api;
  open: boolean;
  onCancel: () => void;
  onDone: (summary: string) => void;
  onFailed: (message: string) => void;
}

type StepState = 'todo' | 'doing' | 'done' | 'failed';

/** Derived from the step list, so adding a step cannot leave the map behind. */
const freshSteps = (): Record<InstanceStep, StepState> =>
  Object.fromEntries(INSTANCE_STEPS.map((s) => [s.key, 'todo'])) as Record<
    InstanceStep,
    StepState
  >;


export function CreateInstance({ api, open, onCancel, onDone, onFailed }: CreateInstanceProps) {
  const [verticalSlug, setVerticalSlug] = useState('fsm');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  // Fixed at provisioning (K-7). Only `global` is selectable today; `eu`/`us` are
  // shown but disabled, because their enforcement (Regional Services, an Enterprise
  // add-on) is not in place and the control plane refuses them (K-32).
  const [jurisdiction, setJurisdiction] = useState<'eu' | 'us' | 'global'>('global');
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<Record<InstanceStep, StepState>>(freshSteps);

  const mark = (key: InstanceStep, s: StepState) => setState((prev) => ({ ...prev, [key]: s }));

  async function run() {
    setBusy(true);
    try {
      // The sequence lives in lib/create-instance so it can be tested; this only
      // renders how far it got.
      const result = await createInstance(
        api,
        {
          verticalSlug,
          slug,
          name,
          jurisdiction,
          hostname,
          tenantId: ulid() as TenantId,
          scopeId: ulid() as ScopeId,
          owner: ulid() as PrincipalId,
        },
        (step, s) => mark(step, s === 'doing' ? 'doing' : 'done'),
      );
      onDone(result.url ? `${name} — ${result.url}` : `${name} — no hostname bound`);
      reset();
    } catch (e) {
      if (e instanceof InstanceStepError) mark(e.step, 'failed');
      onFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setSlug('');
    setName('');
    setJurisdiction('global');
    setHostname('');
    setState(freshSteps());
  }

  return (
    <Dialog
      open={open}
      title="New instance"
      description="Creates a tenant, provisions the vertical, and puts it on a hostname."
      confirmLabel={busy ? 'Working…' : 'Create instance'}
      onConfirm={() => void run()}
      onCancel={() => {
        reset();
        onCancel();
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input
          label="Vertical"
          mono
          placeholder="fsm"
          hint="Must have a deployment bound on the control plane, or this reports 501."
          value={verticalSlug}
          onChange={(e) => setVerticalSlug(e.target.value)}
        />
        <Input
          label="Slug"
          mono
          placeholder="acme"
          hint="Stable, URL-safe, unique across the platform."
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
        <Input
          label="Name"
          placeholder="Acme Fastigheter"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div>
          <Select
            label="Jurisdiction"
            value={jurisdiction}
            onChange={(e) => setJurisdiction(e.target.value as 'eu' | 'us' | 'global')}
            options={[
              { value: 'global', label: 'Global — unconstrained' },
              { value: 'eu', label: 'EU — Enterprise (not yet available)', disabled: true },
              { value: 'us', label: 'US — Enterprise (not yet available)', disabled: true },
            ]}
          />
          <span
            style={{ display: 'block', marginTop: 4, fontSize: 12, color: 'var(--text-tertiary)' }}
          >
            Fixed at provisioning and never editable. Pinned regions need Regional
            Services, an Enterprise add-on.
          </span>
        </div>
        <Input
          label="Hostname"
          mono
          placeholder="acme.substrat.run"
          hint="Optional. Left blank, the instance exists but is unreachable."
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
        />

        {/* Shown throughout, not just on failure: the operator needs to know how far
            it got, because the steps span two systems and a partial result is a real
            state rather than a transient one. */}
        <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
          {INSTANCE_STEPS.map((s) => {
            const st = state[s.key];
            const skipped = !hostname.trim() && (s.key === 'hostname' || s.key === 'activate');
            return (
              <div
                key={s.key}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  fontSize: 12.5,
                  color: skipped ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                }}
              >
                <Badge
                  status={
                    st === 'done'
                      ? 'success'
                      : st === 'failed'
                        ? 'danger'
                        : st === 'doing'
                          ? 'warning'
                          : 'neutral'
                  }
                  dot
                >
                  {st === 'todo' && skipped ? 'skipped' : st}
                </Badge>
                <span>{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
