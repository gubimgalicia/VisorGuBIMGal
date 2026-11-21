import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GitCompareArrows, X } from 'lucide-react';
import type { ElementChange } from '../../domain/compare/modelDiff';
import type { KernelPort } from '../../domain/kernel/KernelPort';
import type { ElementRef, ModelId, ModelRecord } from '../../domain/models/ModelRecord';
import type { ColorSchemeResult } from '../viewer/colorByProperty';
import {
  buildCompareView,
  CHANGE_KIND_ORDER,
  COMPARE_STATUS_HEX,
  defaultComparePair,
  type CompareCategory,
  type CompareEntry,
  type CompareResultView
} from '../viewer/compareView';
import { t } from '../i18n';

interface ComparePanelProps {
  models: ModelRecord[];
  kernel: Pick<KernelPort, 'getElementSnapshots'>;
  selectedRef: ElementRef | null;
  onSelectAndFrame: (ref: ElementRef) => void;
  onApplyCompareColors: (scheme: ColorSchemeResult) => void;
  onClearCompareColors: () => void;
}

const MAX_GROUP_ROWS = 200;

function categoryLabel(category: CompareCategory): string {
  switch (category) {
    case 'added':
      return t('compare.statusAdded');
    case 'removed':
      return t('compare.statusRemoved');
    case 'changed':
      return t('compare.statusChanged');
  }
}

function changeKindLabel(kind: ElementChange): string {
  switch (kind) {
    case 'type':
      return t('compare.changeKindType');
    case 'name':
      return t('compare.changeKindName');
    case 'properties':
      return t('compare.changeKindProperties');
    case 'geometry':
      return t('compare.changeKindGeometry');
  }
}

export const ComparePanel: React.FC<ComparePanelProps> = ({
  models,
  kernel,
  selectedRef,
  onSelectAndFrame,
  onApplyCompareColors,
  onClearCompareColors
}) => {
  const readyModels = useMemo(() => models.filter((m) => m.status === 'ready'), [models]);
  const [beforeId, setBeforeId] = useState<ModelId>('');
  const [afterId, setAfterId] = useState<ModelId>('');
  const [result, setResult] = useState<CompareResultView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<CompareCategory, boolean>>({
    added: true,
    removed: true,
    changed: true
  });
  const latestRun = useRef(0);

  // Keep selected models valid as models are added or removed.
  useEffect(() => {
    const next = defaultComparePair(models, beforeId, afterId);
    if (next.beforeId !== beforeId) setBeforeId(next.beforeId);
    if (next.afterId !== afterId) setAfterId(next.afterId);
  }, [models, beforeId, afterId]);

  // Clear the active comparison if either compared model is removed.
  useEffect(() => {
    if (!result) return;
    const hasBefore = readyModels.some((m) => m.id === result.beforeModelId);
    const hasAfter = readyModels.some((m) => m.id === result.afterModelId);
    if (!hasBefore || !hasAfter) {
      setResult(null);
      onClearCompareColors();
    }
  }, [readyModels, result, onClearCompareColors]);

  const modelName = (id: ModelId) => models.find((m) => m.id === id)?.fileName ?? id;

  const handleRun = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!beforeId || !afterId || beforeId === afterId) return;
    const ticket = ++latestRun.current;
    setBusy(true);
    setError(null);
    try {
      const [beforeSnapshots, afterSnapshots] = await Promise.all([
        kernel.getElementSnapshots(beforeId),
        kernel.getElementSnapshots(afterId)
      ]);
      if (ticket !== latestRun.current) return;
      const view = buildCompareView(beforeId, afterId, beforeSnapshots, afterSnapshots, {
        added: t('compare.statusAdded'),
        removed: t('compare.statusRemoved'),
        changed: t('compare.statusChanged'),
        unchanged: t('compare.statusUnchanged')
      });
      setResult(view);
      setOpenGroups({ added: true, removed: true, changed: true });
      onApplyCompareColors(view.colorScheme);
    } catch (err) {
      if (ticket !== latestRun.current) return;
      setError(err instanceof Error ? err.message : t('compare.errorFallback'));
    } finally {
      if (ticket === latestRun.current) setBusy(false);
    }
  };

  const handleClear = () => {
    latestRun.current++;
    setResult(null);
    setError(null);
    onClearCompareColors();
  };

  const toggleGroup = (category: CompareCategory) => {
    setOpenGroups((prev) => ({ ...prev, [category]: !prev[category] }));
  };

  const entryTooltip = (entry: CompareEntry): string => {
    const name = modelName(entry.ref.modelId);
    return entry.category === 'removed'
      ? t('compare.entryTitleBefore', { modelName: name })
      : t('compare.entryTitleAfter', { modelName: name });
  };

  if (readyModels.length < 2) {
    return (
      <div className="compare-empty">
        {t('compare.needTwoModels')}
      </div>
    );
  }

  const sameModel = beforeId !== '' && beforeId === afterId;

  return (
    <div className="compare-panel">
      <form className="compare-form" onSubmit={(e) => void handleRun(e)}>
        <label className="compare-field">
          <span className="compare-label">{t('compare.beforeLabel')}</span>
          <select
            className="select compare-before-select"
            value={beforeId}
            onChange={(e) => setBeforeId(e.target.value)}
            title={t('compare.beforeTitle')}
          >
            {readyModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.fileName}
              </option>
            ))}
          </select>
        </label>

        <label className="compare-field">
          <span className="compare-label">{t('compare.afterLabel')}</span>
          <select
            className="select compare-after-select"
            value={afterId}
            onChange={(e) => setAfterId(e.target.value)}
            title={t('compare.afterTitle')}
          >
            {readyModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.fileName}
              </option>
            ))}
          </select>
        </label>

        {sameModel && <div className="compare-hint">{t('compare.sameModelHint')}</div>}

        <div className="compare-actions">
          <button
            type="submit"
            className="btn btn-primary compare-run-btn"
            style={{ flex: 1, justifyContent: 'center' }}
            disabled={busy || !beforeId || !afterId || sameModel}
          >
            <GitCompareArrows size={14} />
            <span>{busy ? t('compare.running') : t('compare.runBtn')}</span>
          </button>
          {result && (
            <button
              type="button"
              className="btn btn-secondary compare-clear-btn"
              onClick={handleClear}
              title={t('compare.clearTitle')}
            >
              <X size={14} />
              <span>{t('compare.clearBtn')}</span>
            </button>
          )}
        </div>
      </form>

      {error && <div className="compare-error">{error}</div>}

      {result && (
        <>
          <div className="compare-summary">
            <div className="compare-counts">
              <span className="compare-count-pill compare-count-added" data-count={result.counts.added}>
                <span className="compare-dot" style={{ backgroundColor: COMPARE_STATUS_HEX.added }} />
                <span>{t('compare.addedCount', { count: result.counts.added })}</span>
              </span>
              <span className="compare-count-pill compare-count-removed" data-count={result.counts.removed}>
                <span className="compare-dot" style={{ backgroundColor: COMPARE_STATUS_HEX.removed }} />
                <span>{t('compare.removedCount', { count: result.counts.removed })}</span>
              </span>
              <span className="compare-count-pill compare-count-changed" data-count={result.counts.changed}>
                <span className="compare-dot" style={{ backgroundColor: COMPARE_STATUS_HEX.changed }} />
                <span>{t('compare.changedCount', { count: result.counts.changed })}</span>
              </span>
              <span className="compare-count-pill compare-count-unchanged" data-count={result.counts.unchanged}>
                <span className="compare-dot" style={{ backgroundColor: COMPARE_STATUS_HEX.unchanged }} />
                <span>{t('compare.unchangedCount', { count: result.counts.unchanged })}</span>
              </span>
            </div>

            {result.counts.changed > 0 && (
              <div className="compare-change-kinds">
                {CHANGE_KIND_ORDER.map((kind) => {
                  const count = result.counts.byChangeKind[kind];
                  return (
                    <span
                      key={kind}
                      className={`compare-kind-badge ${count === 0 ? 'zero' : ''}`}
                      data-change-kind={kind}
                      data-count={count}
                    >
                      {t('compare.changeKindCount', { kind: changeKindLabel(kind), count })}
                    </span>
                  );
                })}
              </div>
            )}

            {result.counts.duplicates > 0 && (
              <div className="compare-duplicates">
                {t('compare.duplicatesNote', { count: result.counts.duplicates })}
              </div>
            )}
          </div>

          {result.counts.added === 0 && result.counts.removed === 0 && result.counts.changed === 0 ? (
            <div className="compare-no-diff">{t('compare.noDifferences')}</div>
          ) : (
            <div className="compare-groups">
              {result.groups.map((group) => {
                if (group.entries.length === 0) return null;
                const isOpen = openGroups[group.category];
                const visible = group.entries.slice(0, MAX_GROUP_ROWS);
                return (
                  <section
                    key={group.category}
                    className="compare-group"
                    data-category={group.category}
                  >
                    <button
                      type="button"
                      className="compare-group-header"
                      onClick={() => toggleGroup(group.category)}
                    >
                      {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <span
                        className="compare-dot"
                        style={{ backgroundColor: COMPARE_STATUS_HEX[group.category] }}
                      />
                      <span className="compare-group-title">
                        {t('compare.groupHeader', {
                          label: categoryLabel(group.category),
                          count: group.entries.length
                        })}
                      </span>
                    </button>

                    {isOpen && (
                      <ul className="compare-entry-list">
                        {visible.map((entry) => {
                          const isSelected =
                            selectedRef?.modelId === entry.ref.modelId &&
                            selectedRef.expressId === entry.ref.expressId;
                          return (
                            <li
                              key={`${entry.category}:${entry.globalId}`}
                              className={`compare-entry ${isSelected ? 'selected' : ''}`}
                              data-category={entry.category}
                              data-global-id={entry.globalId}
                              data-model-id={entry.ref.modelId}
                              data-express-id={entry.ref.expressId}
                              title={entryTooltip(entry)}
                              onClick={() => onSelectAndFrame(entry.ref)}
                            >
                              <div className="compare-entry-top">
                                <span className="compare-entry-name">
                                  {entry.name?.trim() || t('compare.unnamed')}
                                </span>
                                <span className="compare-entry-meta">
                                  {entry.ifcType} #{entry.ref.expressId}
                                </span>
                              </div>
                              {entry.category === 'changed' && (
                                <div className="compare-entry-details">
                                  <div className="compare-entry-tags">
                                    {entry.changes.map((kind) => (
                                      <span key={kind} className="compare-entry-tag" data-kind={kind}>
                                        {changeKindLabel(kind)}
                                      </span>
                                    ))}
                                  </div>
                                  {entry.changes.includes('name') && (
                                    <div className="compare-entry-sub">
                                      {t('compare.transitionDetail', {
                                        before: entry.beforeName?.trim() || t('compare.unnamed'),
                                        after: entry.name?.trim() || t('compare.unnamed')
                                      })}
                                    </div>
                                  )}
                                  {entry.changes.includes('type') && (
                                    <div className="compare-entry-sub">
                                      {t('compare.transitionDetail', {
                                        before: entry.beforeIfcType ?? '',
                                        after: entry.ifcType
                                      })}
                                    </div>
                                  )}
                                  {entry.properties.length > 0 && (
                                    <div className="compare-entry-sub">
                                      {t('compare.propsChangedCount', { count: entry.properties.length })}
                                    </div>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                        {group.entries.length > visible.length && (
                          <li className="compare-more">
                            {t('common.ellipsisAndMore', {
                              count: group.entries.length - visible.length
                            })}
                          </li>
                        )}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};
