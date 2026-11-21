import React from 'react';
import { Info, Tag, Hash, FileSpreadsheet } from 'lucide-react';
import type { AttributeValue, SelectedElementDetails } from '../../domain/models/ModelRecord';
import { t } from '../i18n';

interface PropertiesPanelProps {
  element: SelectedElementDetails | null;
}

function formatAttributeValue(val: AttributeValue): string {
  if (val === null) return '-';
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  if (Array.isArray(val)) {
    return val.map(formatAttributeValue).join(', ');
  }
  if ('ref' in val) {
    return `#${val.ref}`;
  }
  if ('enum' in val) {
    return `.${val.enum}.`;
  }
  return `${val.type}(${formatAttributeValue(val.value)})`;
}

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({ element }) => {
  if (!element) {
    return (
      <div style={{ padding: '24px 12px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
        <Info size={32} style={{ margin: '0 auto 10px', opacity: 0.4 }} />
        <p style={{ fontWeight: 500 }}>{t('properties.emptyTitle')}</p>
        <p style={{ fontSize: '11px', marginTop: '4px' }}>
          {t('properties.emptyHint')}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Element identification header */}
      <div
        style={{
          background: 'rgba(30, 41, 59, 0.9)',
          padding: '12px',
          borderRadius: '6px',
          border: '1px solid #334155',
          marginBottom: '12px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#38bdf8', marginBottom: '4px' }}>
          <Tag size={14} />
          <span style={{ fontSize: '13px', fontWeight: 600 }}>{element.type}</span>
        </div>
        <div style={{ fontSize: '12px', fontWeight: 500, color: '#f8fafc', marginBottom: '8px' }}>
          {element.name || t('properties.unnamed')}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', fontSize: '11px' }}>
          <span className="meta-chip">
            <Hash size={10} style={{ display: 'inline', marginRight: '2px' }} />
            #{element.expressId}
          </span>
          {element.globalId && (
            <span className="meta-chip" title={element.globalId}>
              {element.globalId.slice(0, 14)}...
            </span>
          )}
          <span className="meta-chip" style={{ color: '#94a3b8' }}>
            {element.modelName}
          </span>
        </div>
      </div>

      {/* Property Sets */}
      <div style={{ marginBottom: '8px' }}>
        <span style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>
          {t('properties.propertySetsHeading', { count: element.propertySets.length })}
        </span>
      </div>

      {element.propertySets.map((pset, idx) => (
        <div key={idx} className="pset-card">
          <div className="pset-header">
            <span>{pset.name}</span>
            {pset.properties.length > 0 && (
              <span style={{ fontSize: '10px', color: '#94a3b8' }}>
                {t('properties.propsCount', { count: pset.properties.length })}
              </span>
            )}
          </div>
          <table className="pset-table">
            <tbody>
              {pset.properties.map((prop, pIdx) => {
                const hasValue = prop.value !== null && prop.value !== undefined;
                const text = hasValue
                  ? [prop.value, prop.unit].filter((part) => part !== undefined).join(' ')
                  : '-';
                return (
                  <tr key={pIdx}>
                    <td title={prop.name}>{prop.name}</td>
                    <td title={text}>{text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {/* Attributes */}
      {Object.keys(element.attributes).length > 0 && (
        <div className="pset-card" style={{ marginTop: '12px' }}>
          <div className="pset-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <FileSpreadsheet size={13} />
              <span>{t('properties.attributesHeading')}</span>
            </div>
          </div>
          <table className="pset-table">
            <tbody>
              {Object.entries(element.attributes).map(([key, val], aIdx) => (
                <tr key={aIdx}>
                  <td>{key}</td>
                  <td>{formatAttributeValue(val)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
