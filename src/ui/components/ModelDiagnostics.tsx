import React, { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type { KernelDiagnostic } from '../../domain/kernel/KernelPort';
import type { ElementRef, ModelId } from '../../domain/models/ModelRecord';
import { t } from '../i18n';

interface ModelDiagnosticsProps {
  modelId: ModelId;
  diagnostics: readonly KernelDiagnostic[];
  onSelectElement: (ref: ElementRef) => void;
}

/** Entries shown per code: a large model can have a thousand of the same warning. */
const ENTRIES_PER_GROUP = 20;

const SEVERITIES = ['error', 'warning', 'info'] as const;

const SEVERITY_KEYS = {
  error: 'diagnostics.severityError',
  warning: 'diagnostics.severityWarning',
  info: 'diagnostics.severityInfo'
} as const;

const COLORS: Record<KernelDiagnostic['severity'], string> = {
  error: 'var(--danger)',
  warning: 'var(--warning)',
  info: 'var(--text-muted)'
};

interface Group {
  severity: KernelDiagnostic['severity'];
  code: string;
  items: KernelDiagnostic[];
}

/** One group per severity and code, the most severe first, then the most frequent. */
function groupDiagnostics(diagnostics: readonly KernelDiagnostic[]): Group[] {
  const groups = new Map<string, Group>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.severity}\u0000${diagnostic.code}`;
    let group = groups.get(key);
    if (!group) {
      group = { severity: diagnostic.severity, code: diagnostic.code, items: [] };
      groups.set(key, group);
    }
    group.items.push(diagnostic);
  }
  return [...groups.values()].sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      b.items.length - a.items.length ||
      a.code.localeCompare(b.code)
  );
}

/** Load diagnostics of one model: a count by severity that opens a list grouped by code. */
export const ModelDiagnostics: React.FC<ModelDiagnosticsProps> = ({ modelId, diagnostics, onSelectElement }) => {
  const [open, setOpen] = useState(false);
  // A large model has thousands: count and group them once per list, not on every render.
  const counts = useMemo(
    () =>
      SEVERITIES.map((severity) => ({
        severity,
        count: diagnostics.filter((item) => item.severity === severity).length
      })).filter(({ count }) => count > 0),
    [diagnostics]
  );
  const groups = useMemo(() => (open ? groupDiagnostics(diagnostics) : []), [open, diagnostics]);
  if (diagnostics.length === 0) return null;

  // Severity comes from the Worker as data: a value outside the three still shows, uncounted.
  const worst = counts[0]?.severity ?? 'info';
  const summary =
    counts.map(({ severity, count }) => t(SEVERITY_KEYS[severity], { count })).join(' · ') ||
    t('diagnostics.summaryFallback', { count: diagnostics.length });

  return (
    <div className="model-diagnostics">
      <button
        type="button"
        className="model-diagnostics-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        title={open ? t('diagnostics.hideTitle') : t('diagnostics.showTitle')}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <AlertTriangle size={12} color={COLORS[worst]} />
        <span>{summary}</span>
      </button>

      {open &&
        groups.map((group) => (
          <div key={`${group.severity}:${group.code}`} className="model-diagnostics-group">
            <div className="model-diagnostics-code" style={{ color: COLORS[group.severity] }}>
              <code>{group.code}</code>
              <span>{group.items.length}</span>
            </div>
            {group.items.slice(0, ENTRIES_PER_GROUP).map((item, index) => (
              <div key={index} className="model-diagnostics-item">
                {item.expressId !== undefined && (
                  <button
                    type="button"
                    className="model-diagnostics-element"
                    onClick={() => onSelectElement({ modelId, expressId: item.expressId! })}
                    title={t('diagnostics.selectElementTitle')}
                  >
                    #{item.expressId}
                  </button>
                )}
                <span>{item.message}</span>
              </div>
            ))}
            {group.items.length > ENTRIES_PER_GROUP && (
              <div className="model-diagnostics-more">
                {t('common.andMore', { count: group.items.length - ENTRIES_PER_GROUP })}
              </div>
            )}
          </div>
        ))}
    </div>
  );
};
