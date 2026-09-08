/**
 * The inference provider switch, in the header.
 *
 * It sits next to the collection chooser because both are session-wide context rather
 * than a property of whatever view is open: which documents are being compared, and which
 * model is doing the comparing.
 *
 * Two things it deliberately does not do. It does not hide a provider the deployment has
 * no credentials for — a greyed control that explains itself is more useful than a
 * missing one, because "why is there no Groq option" is a question the interface should
 * answer. And it does not claim the switch is retroactive: claims already extracted keep
 * the provider that produced them, which the run's stored model name records.
 */

import { useCallback, useState } from 'react';

import { readSettings, setProvider, type ProviderId, type SettingsResponse } from './api.ts';
import { useAsync } from './ui.tsx';

const LABELS: Record<ProviderId, string> = {
  bedrock: 'Bedrock',
  groq: 'Groq',
};

export function ProviderToggle() {
  const settings = useAsync(readSettings, 'settings');
  const [pending, setPending] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Held locally so the button reflects the click immediately rather than after a refetch.
  const [local, setLocal] = useState<SettingsResponse | null>(null);

  const current = local ?? settings.data ?? null;

  const choose = useCallback(
    async (provider: ProviderId) => {
      if (current === null || provider === current.activeProvider) return;
      setPending(provider);
      setError(null);
      try {
        setLocal(await setProvider(provider));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'could not switch provider');
      } finally {
        setPending(null);
      }
    },
    [current],
  );

  /**
   * Loading and failure are shown, not hidden.
   *
   * Returning null on error made the control disappear whenever `/settings` failed, which
   * reads as "this build has no provider switch" rather than "the API did not answer" —
   * and the second is the one a person can act on.
   */
  if (current === null) {
    return (
      <div className="row small provider-toggle">
        <span className="muted">Model</span>
        <span className="muted">
          {settings.error !== null ? 'unavailable' : 'loading…'}
        </span>
      </div>
    );
  }

  const activeModel =
    current.providers.find((provider) => provider.id === current.activeProvider)?.model ?? null;

  return (
    <div className="row small provider-toggle">
      <span className="muted">Model</span>

      <div className="segmented" role="group" aria-label="Inference provider">
        {current.providers.map((provider) => {
          const active = provider.id === current.activeProvider;
          return (
            <button
              key={provider.id}
              type="button"
              className="segment"
              aria-pressed={active}
              disabled={!provider.configured || pending !== null}
              // The model name is the useful detail here, and it is what a reviewer needs
              // when asking which model produced a given claim.
              title={
                provider.configured
                  ? `${LABELS[provider.id]}${provider.model === null ? '' : ` — ${provider.model}`}`
                  : `${LABELS[provider.id]} has no credentials configured on this deployment`
              }
              onClick={() => void choose(provider.id)}
            >
              {LABELS[provider.id]}
              {!provider.configured ? <span className="muted"> (not configured)</span> : null}
            </button>
          );
        })}
      </div>

      {/* The model name, because "Groq" does not tell a reviewer what produced a claim. */}
      {error === null && activeModel !== null ? (
        <span className="muted provider-model" title={activeModel}>
          {activeModel}
        </span>
      ) : null}

      {error !== null ? (
        <span className="muted" role="status">
          {error}
        </span>
      ) : null}
    </div>
  );
}
