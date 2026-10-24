import { useEffect, useState } from 'react';
import { Button } from '../components/Button.tsx';
import { Dialog } from '../components/Dialog.tsx';
import { ApiError } from '../lib/api.ts';
import { api } from '../session.tsx';

interface ConsentCategory {
  name: string;
  purpose: string;
  dataDescription: string;
  retention: string;
  recipients: string;
  policyVersion: number;
  requiredForService: boolean;
  enabled: boolean;
  updatedAt: string | null;
}

interface ConsentEvent {
  category: string;
  purpose: string;
  enabled: boolean;
  policyVersion: number;
  source: string;
  changedAt: string;
}

interface PersonalGraphNode {
  id: string;
  category: string;
  entityType: string;
  label: string;
  createdAt: string;
}

interface PersonalSignal {
  id: string;
  category: string;
  signalType: string;
  subjectId: string | null;
  value: Record<string, unknown>;
  source: string;
  occurredAt: string;
  expiresAt: string;
}

const personalTypeByCategory: Record<string, string> = {
  learning_expertise: 'skill',
  ownership: 'ownership',
  purchase_history: 'purchase',
  travel_preferences: 'country_travelled',
  commercial_personalization: 'brand_preference',
  notification_preferences: 'notification_preference',
};

export default function PrivacySettings() {
  const [categories, setCategories] = useState<ConsentCategory[]>([]);
  const [history, setHistory] = useState<ConsentEvent[]>([]);
  const [nodes, setNodes] = useState<PersonalGraphNode[]>([]);
  const [signals, setSignals] = useState<PersonalSignal[]>([]);
  const [itemCategory, setItemCategory] = useState('');
  const [itemLabel, setItemLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmGraphDelete, setConfirmGraphDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const itemType = personalTypeByCategory[itemCategory] ?? '';

  useEffect(() => {
    let active = true;
    void Promise.all([
      api<{ categories: ConsentCategory[] }>('/me/consents', { signedIn: true }),
      api<{ history: ConsentEvent[] }>('/me/consents/audit', { signedIn: true }),
      api<{ graph: { nodes: PersonalGraphNode[]; signals: PersonalSignal[] } }>('/me/graph', { signedIn: true }),
    ])
      .then(([consents, audit, graph]) => {
        if (!active) return;
        setCategories(consents.categories);
        setHistory(audit.history);
        setNodes(graph.graph.nodes);
        setSignals(graph.graph.signals);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Your privacy settings could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function change(category: ConsentCategory, enabled: boolean) {
    setSaving(category.name);
    setError(null);
    try {
      await api('/me/consents', {
        method: 'PUT',
        signedIn: true,
        body: { choices: [{ category: category.name, enabled }] },
      });
      setCategories(current => current.map(item => (item.name === category.name ? { ...item, enabled } : item)));
      const refreshed = await api<{ history: ConsentEvent[] }>('/me/consents/audit', { signedIn: true });
      setHistory(refreshed.history);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your choice could not be saved. Try again.');
    } finally {
      setSaving(null);
    }
  }

  async function addPersonalItem() {
    setError(null);
    setSaving('personal-item');
    try {
      const result = await api<{ node: PersonalGraphNode }>('/me/graph/nodes', {
        method: 'POST',
        signedIn: true,
        body: { category: itemCategory, entityType: itemType, label: itemLabel, source: 'user_entered' },
      });
      setNodes(current => [result.node, ...current]);
      setItemLabel('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'This item could not be saved. Try again.');
    } finally {
      setSaving(null);
    }
  }

  async function deletePersonalItem(node: PersonalGraphNode) {
    setError(null);
    setSaving(node.id);
    try {
      await api(`/me/graph/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE', signedIn: true });
      setNodes(current => current.filter(item => item.id !== node.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'This item could not be deleted. Try again.');
    } finally {
      setSaving(null);
    }
  }

  async function deleteSignal(signal: PersonalSignal) {
    setError(null);
    setSaving(signal.id);
    try {
      await api(`/me/graph/signals/${encodeURIComponent(signal.id)}`, { method: 'DELETE', signedIn: true });
      setSignals(current => current.filter(item => item.id !== signal.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'This activity record could not be deleted. Try again.');
    } finally {
      setSaving(null);
    }
  }

  async function deleteAllPersonalData() {
    setSaving('all-personal-data');
    setError(null);
    try {
      await api('/me/graph', { method: 'DELETE', signedIn: true });
      setNodes([]);
      setSignals([]);
      setConfirmGraphDelete(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your personal graph data could not be deleted. Try again.');
    } finally {
      setSaving(null);
    }
  }

  async function exportData() {
    setExporting(true);
    setError(null);
    try {
      const data = await api<Record<string, unknown>>('/me/data-export', { signedIn: true });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'graphinity-data-export.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your data could not be exported. Try again.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <main className="page legal">
      <h1 className="text-title1">Your data choices</h1>
      <p className="text-body secondary">
        Optional uses start off. Choose separately what Graphinity may use to personalize your experience or support
        commercial programs. Your choices are saved with a history you can review below.
      </p>
      {loading && (
        <p className="text-body" role="status">
          Loading your choices…
        </p>
      )}
      {error && (
        <p className="form-note tone-bad" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn-secondary" onClick={() => void exportData()} disabled={exporting}>
        {exporting ? 'Preparing export…' : 'Download your data'}
      </button>
      {!loading && (
        <section aria-label="Data use choices">
          {categories.map(category => (
            <article className="profile-section" key={category.name}>
              <h2 className="text-headline">{category.name.replaceAll('_', ' ')}</h2>
              <p className="text-body">{category.purpose}</p>
              <dl className="text-subhead">
                <dt>
                  <strong>Information</strong>
                </dt>
                <dd>{category.dataDescription}</dd>
                <dt>
                  <strong>How long</strong>
                </dt>
                <dd>{category.retention}</dd>
                <dt>
                  <strong>Who receives it</strong>
                </dt>
                <dd>{category.recipients}</dd>
              </dl>
              <label className="text-body consent-choice">
                <input
                  type="checkbox"
                  checked={category.enabled}
                  disabled={category.requiredForService || saving !== null}
                  onChange={event => void change(category, event.currentTarget.checked)}
                />
                {category.requiredForService ? 'Needed to provide your account' : 'Allow this use'}
                {saving === category.name ? ' — saving…' : ''}
              </label>
            </article>
          ))}
        </section>
      )}
      <section className="profile-section" aria-labelledby="consent-history-title">
        <h2 id="consent-history-title" className="text-headline">
          Choice history
        </h2>
        {history.length === 0 ? (
          <p className="text-body secondary">No optional choices have been changed yet.</p>
        ) : (
          <ol className="text-subhead">
            {history.map((event, index) => (
              <li key={`${event.category}-${event.changedAt}-${index}`}>
                {event.purpose}: {event.enabled ? 'allowed' : 'turned off'} —{' '}
                <time dateTime={event.changedAt}>{new Date(event.changedAt).toLocaleString()}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="profile-section" aria-labelledby="personal-graph-title">
        <h2 id="personal-graph-title" className="text-headline">
          Your personal knowledge graph
        </h2>
        <p className="text-body secondary">
          Add information you choose to save. Each item requires active consent for its category. Turning a choice off
          stops new collection and use; you can still inspect and remove stored items here.
        </p>
        {categories.some(category => category.enabled && !category.requiredForService) && (
          <form
            className="onboarding"
            onSubmit={event => {
              event.preventDefault();
              void addPersonalItem();
            }}
          >
            <label className="field text-subhead">
              <span>Data category</span>
              <select
                className="design-input"
                value={itemCategory}
                onChange={event => {
                  setItemCategory(event.currentTarget.value);
                }}
                required
              >
                <option value="" disabled>
                  Choose an allowed category
                </option>
                {categories
                  .filter(
                    category =>
                      category.enabled && !category.requiredForService && personalTypeByCategory[category.name],
                  )
                  .map(category => (
                    <option key={category.name} value={category.name}>
                      {category.name.replaceAll('_', ' ')}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field text-subhead">
              <span>What would you like to remember?</span>
              <input
                className="design-input"
                value={itemLabel}
                onChange={event => {
                  setItemLabel(event.currentTarget.value);
                }}
                maxLength={240}
                required
              />
            </label>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={!itemCategory || !itemLabel.trim() || saving !== null}
            >
              {saving === 'personal-item' ? 'Saving…' : 'Save to my graph'}
            </button>
          </form>
        )}
        {nodes.length === 0 ? (
          <p className="text-body secondary">No personal graph items are stored.</p>
        ) : (
          <ul className="personal-graph-items">
            {nodes.map(node => (
              <li key={node.id}>
                <span>
                  <strong>{node.label}</strong>
                  <small>
                    {node.category.replaceAll('_', ' ')} · {node.entityType.replaceAll('_', ' ')}
                  </small>
                </span>
                <button
                  className="btn btn-plain danger"
                  type="button"
                  onClick={() => void deletePersonalItem(node)}
                  disabled={saving !== null}
                >
                  {saving === node.id ? 'Deleting…' : 'Delete'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <h3 className="text-headline">First-party activity</h3>
        {signals.length === 0 ? (
          <p className="text-body secondary">No optional activity has been recorded.</p>
        ) : (
          <ul className="personal-signal-list">
            {signals.map(signal => (
              <li className="personal-signal" key={signal.id}>
                <div>
                  <p className="text-body">{signal.signalType.replaceAll('_', ' ')}</p>
                  {typeof signal.value.query === 'string' && (
                    <p className="text-footnote">Saved search: {signal.value.query}</p>
                  )}
                  {signal.subjectId && <p className="text-footnote">Question or item: {signal.subjectId}</p>}
                  <p className="text-footnote secondary">
                    {signal.category.replaceAll('_', ' ')} · {signal.source.replaceAll('_', ' ')} ·{' '}
                    <time dateTime={signal.occurredAt}>{new Date(signal.occurredAt).toLocaleString()}</time>
                  </p>
                  <p className="text-footnote secondary">
                    Expires <time dateTime={signal.expiresAt}>{new Date(signal.expiresAt).toLocaleDateString()}</time>
                  </p>
                </div>
                <Button variant="secondary" disabled={saving !== null} onClick={() => void deleteSignal(signal)}>
                  {saving === signal.id ? 'Deleting…' : 'Delete activity'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <button
          className="btn btn-plain danger"
          type="button"
          onClick={() => {
            setConfirmGraphDelete(true);
          }}
          disabled={(nodes.length === 0 && signals.length === 0) || saving !== null}
        >
          Delete all personal graph data…
        </button>
      </section>
      <Dialog
        open={confirmGraphDelete}
        onClose={() => {
          if (saving !== 'all-personal-data') setConfirmGraphDelete(false);
        }}
        title="Delete your personal graph data?"
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmGraphDelete(false);
              }}
              disabled={saving !== null}
            >
              Keep it
            </Button>
            <Button className="btn-destructive" onClick={() => void deleteAllPersonalData()} disabled={saving !== null}>
              {saving === 'all-personal-data' ? 'Deleting…' : 'Delete graph data'}
            </Button>
          </>
        }
      >
        <p>This permanently removes the personal graph items, saved collections, and signal events stored for you.</p>
        <p>Your profile, questions, answers, and consent history will remain.</p>
      </Dialog>
    </main>
  );
}
