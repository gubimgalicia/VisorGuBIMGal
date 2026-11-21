import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Box, Focus, EyeOff } from 'lucide-react';
import type { ElementQuery, KernelPort, SpatialTree } from '../../domain/kernel/KernelPort';
import type { ElementRef, ModelId, ModelRecord } from '../../domain/models/ModelRecord';
import type { DisplayTarget } from '../viewer/displayRule';
import {
  getSearchFields,
  describeQuery,
  elementLabels,
  isSearchable,
  searchModels
} from '../viewer/search';
import { t } from '../i18n';

interface SearchPanelProps {
  models: ModelRecord[];
  spatialTrees: Record<ModelId, SpatialTree>;
  kernel: Pick<KernelPort, 'findElements'>;
  selectedRef: ElementRef | null;
  onSelectElement: (ref: ElementRef) => void;
  onIsolate: (target: DisplayTarget) => void;
  onHide: (target: DisplayTarget) => void;
}

/** Rows listed; the count and the isolate and hide actions cover every match. */
const MAX_ROWS = 200;

interface Results {
  query: ElementQuery;
  matches: Record<ModelId, number[]>;
  failed: ModelId[];
}

export const SearchPanel: React.FC<SearchPanelProps> = ({
  models,
  spatialTrees,
  kernel,
  selectedRef,
  onSelectElement,
  onIsolate,
  onHide
}) => {
  const [field, setField] = useState<ElementQuery['field']>('any');
  const [text, setText] = useState('');
  const [propertyName, setPropertyName] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the latest search may show its answer.
  const latest = useRef(0);

  const modelIds = useMemo(() => models.map((model) => model.id), [models]);
  const modelKey = modelIds.join('|');
  const draft: ElementQuery =
    field === 'property' && propertyName.trim() ? { field, text, propertyName } : { field, text };

  const run = (query: ElementQuery) => {
    const ticket = ++latest.current;
    setBusy(true);
    setError(null);
    searchModels(kernel, modelIds, query)
      .then(({ matches, failed }) => {
        if (ticket === latest.current) setResults({ query, matches, failed });
      })
      .catch((reason: unknown) => {
        if (ticket === latest.current) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (ticket === latest.current) setBusy(false);
      });
  };

  // A model loaded or removed changes what the last search finds.
  const lastQuery = results?.query;
  useEffect(() => {
    if (lastQuery) run(lastQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  const labels = useMemo(() => {
    const byModel = new Map<ModelId, ReturnType<typeof elementLabels>>();
    for (const modelId of modelIds) byModel.set(modelId, elementLabels(spatialTrees[modelId]));
    return byModel;
  }, [modelIds, spatialTrees]);

  const rows = useMemo(() => {
    if (!results) return [];
    const out: ElementRef[] = [];
    for (const modelId of modelIds) {
      for (const expressId of results.matches[modelId] ?? []) {
        if (out.length >= MAX_ROWS) return out;
        out.push({ modelId, expressId });
      }
    }
    return out;
  }, [results, modelIds]);

  const total = results ? Object.values(results.matches).reduce((sum, ids) => sum + ids.length, 0) : 0;
  const target: DisplayTarget | null =
    results && total > 0 ? { by: 'search', label: describeQuery(results.query), matches: results.matches } : null;
  const searchFields = getSearchFields();
  const fileName = (modelId: ModelId) => models.find((model) => model.id === modelId)?.fileName ?? modelId;

  if (models.length === 0) {
    return (
      <div style={{ padding: '24px 12px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
        {t('search.emptyModels')}
      </div>
    );
  }

  return (
    <div className="search-panel">
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (isSearchable(draft)) run(draft);
        }}
      >
        <select
          className="select search-field"
          value={field}
          onChange={(event) => setField(event.target.value as ElementQuery['field'])}
          title={t('search.fieldTitle')}
        >
          {searchFields.map((item) => (
            <option key={item.field} value={item.field}>
              {item.label}
            </option>
          ))}
        </select>
        {field === 'property' && (
          <input
            className="input search-property-name"
            value={propertyName}
            onChange={(event) => setPropertyName(event.target.value)}
            placeholder={t('search.propertyPlaceholder')}
            title={t('search.propertyTitle')}
          />
        )}
        <div className="search-row">
          <input
            className="input search-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              field === 'globalId' ? t('search.globalIdPlaceholder') : t('search.textPlaceholder')
            }
            title={t('search.textPlaceholder')}
          />
          <button
            type="submit"
            className="btn btn-primary btn-icon search-submit"
            disabled={!isSearchable(draft) || busy}
            title={t('search.submitTitle')}
          >
            <Search size={14} />
          </button>
        </div>
      </form>

      {busy && <div className="search-busy">{t('search.busy')}</div>}
      {error && <div className="search-error">{error}</div>}

      {results && (
        <>
          <div className="search-summary">
            <span className="search-count">
              {t('search.resultCount', { count: total })}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-icon search-isolate"
              disabled={!target}
              onClick={() => target && onIsolate(target)}
              title={t('search.isolateResultsTitle')}
            >
              <Focus size={14} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon search-hide"
              disabled={!target}
              onClick={() => target && onHide(target)}
              title={t('search.hideResultsTitle')}
            >
              <EyeOff size={14} />
            </button>
          </div>
          {results.failed.length > 0 && (
            <div className="search-error">
              {t('search.failedModels', { models: results.failed.map(fileName).join(', ') })}
            </div>
          )}
          <div className="search-results">
            {rows.map((ref) => {
              const label = labels.get(ref.modelId)?.get(ref.expressId);
              const selected = selectedRef?.modelId === ref.modelId && selectedRef.expressId === ref.expressId;
              return (
                <div
                  key={`${ref.modelId}-${ref.expressId}`}
                  className={`search-result ${selected ? 'selected' : ''}`}
                  data-model-id={ref.modelId}
                  data-express-id={ref.expressId}
                  onClick={() => onSelectElement(ref)}
                  title={models.length > 1 ? fileName(ref.modelId) : undefined}
                >
                  <Box size={11} />
                  <span className="search-result-type">{label?.type ?? `#${ref.expressId}`}</span>
                  <span className="search-result-name">{label?.name ?? `#${ref.expressId}`}</span>
                </div>
              );
            })}
            {total > rows.length && (
              <div className="search-more">{t('search.moreResults', { count: total - rows.length })}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
