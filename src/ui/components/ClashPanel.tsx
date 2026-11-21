import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookmarkPlus, Play, X } from 'lucide-react';
import type { ClashReport, ClashRule } from '../../domain/clash/ClashTypes';
import type { KernelPort, SpatialTree } from '../../domain/kernel/KernelPort';
import type { ModelId, ModelRecord } from '../../domain/models/ModelRecord';
import {
  buildClashDisplayEntries,
  buildClashRequest,
  collectClashCatalog,
  createPresetRule,
  PIPE_CLASH_CLASSES,
  STRUCTURE_CLASH_CLASSES,
  summarizeClashes,
  type ClashDisplayEntry,
  type ClashPresetId
} from '../viewer/clashDetector';
import { formatNumber, t } from '../i18n';

interface ClashPanelProps {
  models: ModelRecord[];
  spatialTrees: Record<ModelId, SpatialTree>;
  kernel: Pick<KernelPort, 'detectClashes'>;
  onInspectPair: (entry: ClashDisplayEntry) => void;
  onClearClashView: () => void;
  onSaveAsBcf: (entry: ClashDisplayEntry) => Promise<void>;
}

const MAX_DISPLAY_ROWS = 200;
const PRESET_PIPES_SENTINEL = '__preset_pipes__';
const PRESET_STRUCTURE_SENTINEL = '__preset_structure__';

export const ClashPanel: React.FC<ClashPanelProps> = ({
  models,
  spatialTrees,
  kernel,
  onInspectPair,
  onClearClashView,
  onSaveAsBcf
}) => {
  const readyModels = useMemo(() => models.filter((m) => m.status === 'ready'), [models]);
  const catalog = useMemo(
    () => collectClashCatalog(readyModels, spatialTrees),
    [readyModels, spatialTrees]
  );

  const [preset, setPreset] = useState<ClashPresetId>('all-vs-all');
  const [modelA, setModelA] = useState<ModelId | '*'>('*');
  const [modelB, setModelB] = useState<ModelId | '*'>('*');
  const [classA, setClassA] = useState<string>('');
  const [classB, setClassB] = useState<string>('');
  const [storeyA, setStoreyA] = useState<string>('');
  const [storeyB, setStoreyB] = useState<string>('');
  const [clearanceText, setClearanceText] = useState<string>('0');

  const [report, setReport] = useState<ClashReport | null>(null);
  const [entries, setEntries] = useState<ClashDisplayEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<'all' | 'hard' | 'soft'>('all');
  const [busy, setBusy] = useState(false);
  const [savingBcfId, setSavingBcfId] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const latestRun = useRef(0);
  const initializedModelsCountRef = useRef(0);

  // Sync sensible default pair when models are loaded or removed.
  useEffect(() => {
    const validIds = new Set(readyModels.map((m) => m.id));
    if (readyModels.length === 0) {
      setReport(null);
      setEntries([]);
      setActiveId(null);
      initializedModelsCountRef.current = 0;
      return;
    }
    if (initializedModelsCountRef.current !== readyModels.length && preset === 'all-vs-all') {
      initializedModelsCountRef.current = readyModels.length;
      setModelA(readyModels[0].id);
      setModelB(readyModels[1]?.id ?? readyModels[0].id);
      return;
    }
    if (modelA !== '*' && !validIds.has(modelA)) setModelA(readyModels[0].id);
    if (modelB !== '*' && !validIds.has(modelB)) setModelB(readyModels[1]?.id ?? readyModels[0].id);
  }, [readyModels, modelA, modelB, preset]);

  const applyPreset = (nextPreset: ClashPresetId) => {
    setPreset(nextPreset);
    if (nextPreset === 'custom') return;
    const rule = createPresetRule(nextPreset, readyModels, catalog.classes);
    setModelA(rule.setA.modelId);
    setModelB(rule.setB.modelId);
    setStoreyA('');
    setStoreyB('');
    if (nextPreset === 'pipes-vs-structure') {
      setClassA(PRESET_PIPES_SENTINEL);
      setClassB(PRESET_STRUCTURE_SENTINEL);
    } else {
      setClassA('');
      setClassB('');
    }
  };

  const resolveClassList = (val: string): string[] => {
    if (!val) return [];
    if (val === PRESET_PIPES_SENTINEL) {
      const present = PIPE_CLASH_CLASSES.filter((c) => catalog.classes.includes(c));
      return present.length > 0 ? present : [...PIPE_CLASH_CLASSES];
    }
    if (val === PRESET_STRUCTURE_SENTINEL) {
      const present = STRUCTURE_CLASH_CLASSES.filter((c) => catalog.classes.includes(c));
      return present.length > 0 ? present : [...STRUCTURE_CLASH_CLASSES];
    }
    return [val];
  };

  const handleRun = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!kernel.detectClashes) {
      setError(t('clash.unsupportedKernel'));
      return;
    }
    const ticket = ++latestRun.current;
    setBusy(true);
    setError(null);
    setProgressText('');
    try {
      const parsedClearance = Number(clearanceText.replace(',', '.'));
      const clearanceMm = Number.isFinite(parsedClearance) && parsedClearance > 0 ? parsedClearance : 0;
      const rule: ClashRule = {
        name: preset,
        setA: {
          modelId: modelA,
          ifcClasses: resolveClassList(classA),
          storeys: storeyA ? [storeyA] : []
        },
        setB: {
          modelId: modelB,
          ifcClasses: resolveClassList(classB),
          storeys: storeyB ? [storeyB] : []
        },
        clearanceMm
      };
      const request = buildClashRequest(rule, readyModels, catalog);
      const result = await kernel.detectClashes(request, (phase, pct) => {
        if (ticket === latestRun.current) {
          setProgressText(t('app.statusPhaseProgress', { phase, pct }));
        }
      });
      if (ticket !== latestRun.current) return;
      const built = buildClashDisplayEntries(result, catalog);
      setReport(result);
      setEntries(built);
      setActiveId(null);
      setKindFilter('all');
    } catch (err) {
      if (ticket !== latestRun.current) return;
      setError(err instanceof Error ? err.message : t('clash.errorFallback'));
    } finally {
      if (ticket === latestRun.current) {
        setBusy(false);
        setProgressText('');
      }
    }
  };

  const handleClear = () => {
    latestRun.current++;
    setReport(null);
    setEntries([]);
    setActiveId(null);
    setError(null);
    onClearClashView();
  };

  const handleSelectEntry = (entry: ClashDisplayEntry) => {
    setActiveId(entry.id);
    onInspectPair(entry);
  };

  const handleSaveEntryBcf = async (
    event: React.MouseEvent,
    entry: ClashDisplayEntry
  ) => {
    event.stopPropagation();
    setSavingBcfId(entry.id);
    setActiveId(entry.id);
    try {
      await onSaveAsBcf(entry);
    } finally {
      setSavingBcfId(null);
    }
  };

  const summary = useMemo(() => summarizeClashes(entries), [entries]);
  const filteredEntries = useMemo(() => {
    if (kindFilter === 'all') return entries;
    return entries.filter((e) => e.kind === kindFilter);
  }, [entries, kindFilter]);

  if (readyModels.length === 0) {
    return <div className="clash-empty">{t('clash.needModel')}</div>;
  }

  const pipeMatchCount = PIPE_CLASH_CLASSES.filter((c) => catalog.classes.includes(c)).length;
  const structMatchCount = STRUCTURE_CLASH_CLASSES.filter((c) => catalog.classes.includes(c)).length;
  const visibleEntries = filteredEntries.slice(0, MAX_DISPLAY_ROWS);
  const hiddenCount = Math.max(0, filteredEntries.length - visibleEntries.length);

  return (
    <div className="clash-panel">
      <form className="clash-form" onSubmit={(e) => void handleRun(e)}>
        <label className="clash-field">
          <span className="clash-label">{t('clash.presetLabel')}</span>
          <select
            className="select clash-preset-select"
            value={preset}
            onChange={(e) => applyPreset(e.target.value as ClashPresetId)}
          >
            <option value="all-vs-all">{t('clash.presetAllVsAll')}</option>
            <option value="pipes-vs-structure">{t('clash.presetPipesVsStructure')}</option>
            <option value="custom">{t('clash.presetCustom')}</option>
          </select>
        </label>

        <div className="clash-set-box">
          <div className="clash-set-title">{t('clash.setALabel')}</div>
          <select
            className="select clash-model-a"
            value={modelA}
            onChange={(e) => {
              setPreset('custom');
              setModelA(e.target.value);
            }}
            title={t('clash.modelSelectTitle', { set: t('clash.setALabel') })}
          >
            <option value="*">{t('clash.modelAll')}</option>
            {readyModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.fileName}
              </option>
            ))}
          </select>
          <select
            className="select clash-class-a"
            value={classA}
            onChange={(e) => {
              setPreset('custom');
              setClassA(e.target.value);
            }}
            title={t('clash.classSelectTitle', { set: t('clash.setALabel') })}
          >
            <option value="">{t('clash.classAll')}</option>
            <option value={PRESET_PIPES_SENTINEL}>
              {t('clash.classPresetPipes', { count: pipeMatchCount })}
            </option>
            <option value={PRESET_STRUCTURE_SENTINEL}>
              {t('clash.classPresetStructure', { count: structMatchCount })}
            </option>
            {catalog.classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {catalog.storeys.length > 0 && (
            <select
              className="select clash-storey-a"
              value={storeyA}
              onChange={(e) => {
                setPreset('custom');
                setStoreyA(e.target.value);
              }}
              title={t('clash.storeySelectTitle', { set: t('clash.setALabel') })}
            >
              <option value="">{t('clash.storeyAll')}</option>
              {catalog.storeys.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="clash-set-box">
          <div className="clash-set-title">{t('clash.setBLabel')}</div>
          <select
            className="select clash-model-b"
            value={modelB}
            onChange={(e) => {
              setPreset('custom');
              setModelB(e.target.value);
            }}
            title={t('clash.modelSelectTitle', { set: t('clash.setBLabel') })}
          >
            <option value="*">{t('clash.modelAll')}</option>
            {readyModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.fileName}
              </option>
            ))}
          </select>
          <select
            className="select clash-class-b"
            value={classB}
            onChange={(e) => {
              setPreset('custom');
              setClassB(e.target.value);
            }}
            title={t('clash.classSelectTitle', { set: t('clash.setBLabel') })}
          >
            <option value="">{t('clash.classAll')}</option>
            <option value={PRESET_PIPES_SENTINEL}>
              {t('clash.classPresetPipes', { count: pipeMatchCount })}
            </option>
            <option value={PRESET_STRUCTURE_SENTINEL}>
              {t('clash.classPresetStructure', { count: structMatchCount })}
            </option>
            {catalog.classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {catalog.storeys.length > 0 && (
            <select
              className="select clash-storey-b"
              value={storeyB}
              onChange={(e) => {
                setPreset('custom');
                setStoreyB(e.target.value);
              }}
              title={t('clash.storeySelectTitle', { set: t('clash.setBLabel') })}
            >
              <option value="">{t('clash.storeyAll')}</option>
              {catalog.storeys.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>

        <label className="clash-field">
          <span className="clash-label">{t('clash.clearanceLabel')}</span>
          <input
            type="number"
            min={0}
            step={5}
            className="input clash-clearance-input"
            value={clearanceText}
            onChange={(e) => setClearanceText(e.target.value)}
            title={t('clash.clearanceTitle')}
          />
        </label>

        <div className="clash-actions">
          <button
            type="submit"
            className="btn btn-primary clash-run-btn"
            style={{ flex: 1, justifyContent: 'center' }}
            disabled={busy}
          >
            <Play size={13} />
            <span>{busy ? t('clash.running') : t('clash.runBtn')}</span>
          </button>
          {report && (
            <button
              type="button"
              className="btn btn-secondary clash-clear-btn"
              onClick={handleClear}
              title={t('clash.clearTitle')}
            >
              <X size={13} />
              <span>{t('clash.clearBtn')}</span>
            </button>
          )}
        </div>

        {busy && progressText && <div className="clash-progress">{progressText}</div>}
      </form>

      {error && <div className="clash-error">{error}</div>}

      {report && (
        <div className="clash-results">
          <div className="clash-summary">
            <div className="clash-summary-stats">
              {t('clash.summaryStats', {
                total: summary.total,
                broad: report.broadPhasePairs,
                ms: report.elapsedMs
              })}
            </div>
            <div className="clash-filter-pills">
              <button
                type="button"
                className={`clash-pill ${kindFilter === 'all' ? 'active' : ''}`}
                onClick={() => setKindFilter('all')}
              >
                {t('clash.filterAll', { count: summary.total })}
              </button>
              <button
                type="button"
                className={`clash-pill hard ${kindFilter === 'hard' ? 'active' : ''}`}
                onClick={() => setKindFilter('hard')}
              >
                {t('clash.filterHard', { count: summary.hard })}
              </button>
              <button
                type="button"
                className={`clash-pill soft ${kindFilter === 'soft' ? 'active' : ''}`}
                onClick={() => setKindFilter('soft')}
              >
                {t('clash.filterSoft', { count: summary.soft })}
              </button>
            </div>
          </div>

          {report.truncated && (
            <div className="clash-notice">
              {t('clash.truncatedNotice', { count: entries.length })}
            </div>
          )}

          {filteredEntries.length === 0 ? (
            <div className="clash-empty">{t('clash.noClashes')}</div>
          ) : (
            <div className="clash-list">
              {visibleEntries.map((entry) => {
                const isSelected = activeId === entry.id;
                const mmVal =
                  entry.kind === 'hard'
                    ? formatNumber(entry.penetrationM * 1000, { maximumFractionDigits: 1 })
                    : formatNumber(entry.gapM * 1000, { maximumFractionDigits: 1 });
                return (
                  <div
                    key={entry.id}
                    className={`clash-card ${entry.kind} ${isSelected ? 'active' : ''}`}
                    onClick={() => handleSelectEntry(entry)}
                    title={t('clash.inspectPairTitle')}
                    data-clash-id={entry.id}
                    data-clash-kind={entry.kind}
                  >
                    <div className="clash-card-top">
                      <span className={`clash-badge ${entry.kind}`}>
                        <AlertTriangle size={11} />
                        <span>
                          {entry.kind === 'hard' ? t('clash.kindHard') : t('clash.kindSoft')}
                        </span>
                      </span>
                      <span className="clash-metric">
                        {entry.kind === 'hard'
                          ? t('clash.penetrationLabel', { mm: mmVal })
                          : t('clash.gapLabel', { mm: mmVal })}
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs clash-bcf-btn"
                        disabled={savingBcfId === entry.id}
                        onClick={(e) => void handleSaveEntryBcf(e, entry)}
                        title={t('clash.saveBcfTitle')}
                      >
                        <BookmarkPlus size={12} />
                        <span>{t('clash.saveBcfBtn')}</span>
                      </button>
                    </div>

                    <div className="clash-pair-body">
                      <div className="clash-elem clash-elem-a">
                        <div className="clash-elem-name">
                          {t('clash.pairElementLine', {
                            name: entry.metaA.name,
                            type: entry.metaA.type
                          })}
                        </div>
                        <div className="clash-elem-meta">
                          {entry.metaA.storey
                            ? t('clash.pairMetaLine', {
                                model: entry.metaA.modelName,
                                storey: entry.metaA.storey
                              })
                            : t('clash.pairMetaNoStorey', { model: entry.metaA.modelName })}
                        </div>
                      </div>
                      <div className="clash-elem clash-elem-b">
                        <div className="clash-elem-name">
                          {t('clash.pairElementLine', {
                            name: entry.metaB.name,
                            type: entry.metaB.type
                          })}
                        </div>
                        <div className="clash-elem-meta">
                          {entry.metaB.storey
                            ? t('clash.pairMetaLine', {
                                model: entry.metaB.modelName,
                                storey: entry.metaB.storey
                              })
                            : t('clash.pairMetaNoStorey', { model: entry.metaB.modelName })}
                        </div>
                      </div>
                      {entry.volumeM3 !== undefined && (
                        <div className="clash-volume">
                          {t('clash.volumeLabel', {
                            cm3: formatNumber(entry.volumeM3 * 1e6, { maximumFractionDigits: 1 })
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {hiddenCount > 0 && (
                <div className="clash-more">
                  {t('common.ellipsisAndMore', { count: hiddenCount })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
