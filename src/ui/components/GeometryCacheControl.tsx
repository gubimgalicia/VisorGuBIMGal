import React, { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { cacheUsage, clearCache } from '../../infrastructure/kernel/geometryCache';
import { formatNumber, t } from '../i18n';

const megabytes = (bytes: number) =>
  t('cache.megabytes', {
    value: formatNumber(bytes / 1048576, { maximumFractionDigits: 1 })
  });

/**
 * What the geometry cache holds in this browser, and a way to empty it. Reopening a cached model
 * replays its geometry instead of evaluating it; the files never leave the browser.
 */
export const GeometryCacheControl: React.FC = () => {
  const [usage, setUsage] = useState<{ models: number; bytes: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    cacheUsage()
      .then(setUsage)
      .catch(() => setUsage(null));
  };
  useEffect(refresh, []);

  const empty = async () => {
    setBusy(true);
    try {
      await clearCache();
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const label =
    usage === null
      ? t('cache.unavailable')
      : t('cache.summary', { count: usage.models, size: megabytes(usage.bytes) });

  return (
    <div className="geometry-cache" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#94a3b8' }}>
      <span title={t('cache.tooltip')}>
        {label}
      </span>
      {usage !== null && usage.models > 0 && (
        <button className="btn btn-ghost" onClick={empty} disabled={busy} title={t('cache.emptyTitle')}>
          <Trash2 size={14} />
          <span>{t('common.empty')}</span>
        </button>
      )}
    </div>
  );
};
