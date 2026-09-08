/**
 * The shell: pick a collection, then move between the four views.
 *
 * A collection is chosen first and is never implicit. It is the boundary within which
 * comparisons run (plan 0.1 and 6.1), and an interface that let a reviewer drift between
 * collections without noticing would invite exactly the cross-dataset comparison the
 * system itself refuses to make.
 *
 * The views are the three plan 7.2 names, plus the issues view plan 7.3 asks for. Issues
 * are a tab rather than a panel because a real observed failure is part of what the work
 * has to demonstrate, and a collapsed panel is not where a reviewer would find it.
 */

import { useCallback, useState } from 'react';

import type { CollectionResponse } from '@superjoin/contracts';

import { createCollection, listCollections } from './api.ts';
import { DocumentsView } from './DocumentsView.tsx';
import { FactsView } from './FactsView.tsx';
import { IssuesView } from './IssuesView.tsx';
import { ProviderToggle } from './ProviderToggle.tsx';
import { RelationshipsView } from './RelationshipsView.tsx';
import { ErrorNotice, Spinner, useAsync } from './ui.tsx';

type Tab = 'documents' | 'facts' | 'relationships' | 'issues';

const TABS: { id: Tab; label: string }[] = [
  { id: 'documents', label: 'Documents' },
  { id: 'facts', label: 'Facts' },
  { id: 'relationships', label: 'Relationships' },
  { id: 'issues', label: 'Issues' },
];

export function App() {
  const collections = useAsync(listCollections, 'collections');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('documents');
  const [focusClaimId, setFocusClaimId] = useState<string | undefined>(undefined);
  // Bumped when processing finishes, to remount the data views so they refetch.
  const [generation, setGeneration] = useState(0);
  const [creating, setCreating] = useState(false);

  const items = collections.data ?? [];
  // Falls back to the first collection so a reviewer opening the app for the first time
  // lands somewhere real rather than on an empty chooser.
  const collectionId = selectedId ?? items[0]?.id ?? null;

  const createNamed = useCallback(async () => {
    const name = window.prompt('Name the collection');
    if (name === null || name.trim() === '') return;
    setCreating(true);
    try {
      const created: CollectionResponse = await createCollection(name.trim());
      collections.reload();
      setSelectedId(created.id);
      setTab('documents');
    } finally {
      setCreating(false);
    }
  }, [collections]);

  const showRelationshipsFor = useCallback((claimId: string) => {
    setFocusClaimId(claimId);
    setTab('relationships');
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          TruthMesh
          <span>facts and relationships across documents</span>
        </div>

        <span className="spacer" />

        <ProviderToggle />

        {collections.loading && items.length === 0 ? <Spinner label="loading collections" /> : null}

        <label className="row small">
          <span className="muted">Collection</span>
          <select
            value={collectionId ?? ''}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setFocusClaimId(undefined);
            }}
          >
            {items.length === 0 ? <option value="">none yet</option> : null}
            {items.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="btn" disabled={creating} onClick={() => void createNamed()}>
          New collection
        </button>
      </header>

      {collectionId !== null ? (
        <nav className="tabs" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === entry.id}
              onClick={() => {
                setTab(entry.id);
                if (entry.id !== 'relationships') setFocusClaimId(undefined);
              }}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      ) : null}

      <main className="main">
        {collections.error !== null ? (
          <div className="column">
            <ErrorNotice error={collections.error} />
            <p className="muted small">
              The API did not answer. Check that it is running and reachable, then reload.
            </p>
          </div>
        ) : collectionId === null ? (
          <div className="column">
            <section className="card">
              <div className="card-body stack">
                <h2 style={{ margin: 0, fontSize: 16 }}>No collections yet</h2>
                <p className="muted" style={{ margin: 0 }}>
                  A collection is the boundary within which documents are compared. Create
                  one, then upload the PDFs that belong together — two unrelated datasets
                  should be two collections, so claims from one are never compared with
                  claims from the other.
                </p>
                <div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={creating}
                    onClick={() => void createNamed()}
                  >
                    Create a collection
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : tab === 'documents' ? (
          <DocumentsView
            key={`documents-${collectionId}-${generation}`}
            collectionId={collectionId}
            onProcessingSettled={() => setGeneration((value) => value + 1)}
          />
        ) : tab === 'facts' ? (
          <FactsView
            key={`facts-${collectionId}-${generation}`}
            collectionId={collectionId}
            onShowRelationships={showRelationshipsFor}
          />
        ) : tab === 'relationships' ? (
          <RelationshipsView
            key={`relationships-${collectionId}-${generation}-${focusClaimId ?? ''}`}
            collectionId={collectionId}
            focusClaimId={focusClaimId}
            onClearFocus={() => setFocusClaimId(undefined)}
          />
        ) : (
          <IssuesView key={`issues-${collectionId}-${generation}`} collectionId={collectionId} />
        )}
      </main>
    </div>
  );
}
