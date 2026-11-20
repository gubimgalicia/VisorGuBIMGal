import React from 'react';
import type { ColorByMode, ColorLegendItem } from '../viewer/colorByProperty';
import { t } from '../i18n';

interface ColorByBarProps {
  mode: ColorByMode;
  propertyName: string;
  availableProperties: readonly string[];
  legend: readonly ColorLegendItem[];
  compareActive?: boolean;
  onChangeMode: (mode: ColorByMode) => void;
  onChangePropertyName: (name: string) => void;
}

export const ColorByBar: React.FC<ColorByBarProps> = ({
  mode,
  propertyName,
  availableProperties,
  legend,
  compareActive = false,
  onChangeMode,
  onChangePropertyName
}) => {
  return (
    <div
      className="display-bar color-by-bar"
      role="region"
      aria-label={t('colorBy.regionAriaLabel')}
    >
      <div className="display-bar-row">
        <span className="display-bar-label">{t('colorBy.label')}</span>
        <select
          className="select color-by-select"
          value={compareActive ? 'compare' : mode}
          onChange={(e) => {
            if (e.target.value !== 'compare') onChangeMode(e.target.value as ColorByMode);
          }}
          title={t('colorBy.selectTitle')}
        >
          <option value="none">{t('colorBy.modeNone')}</option>
          <option value="class">{t('colorBy.modeClass')}</option>
          <option value="storey">{t('colorBy.modeStorey')}</option>
          <option value="material">{t('colorBy.modeMaterial')}</option>
          <option value="property">{t('colorBy.modeProperty')}</option>
          {compareActive && <option value="compare">{t('colorBy.modeCompare')}</option>}
        </select>
      </div>

      {!compareActive && mode === 'property' && (
        <div className="display-bar-row" style={{ marginTop: '2px' }}>
          <input
            type="text"
            className="input color-prop-input"
            list="color-prop-suggestions"
            value={propertyName}
            onChange={(e) => onChangePropertyName(e.target.value)}
            placeholder={t('colorBy.propertyPlaceholder')}
            style={{
              flex: 1,
              minWidth: 0,
              height: '24px',
              padding: '2px 6px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              backgroundColor: 'rgba(30, 41, 59, 0.9)',
              color: '#f8fafc'
            }}
          />
          <datalist id="color-prop-suggestions">
            {availableProperties.map((prop) => (
              <option key={prop} value={prop} />
            ))}
          </datalist>
        </div>
      )}

      {legend.length > 0 && (
        <ul
          className="color-legend"
          style={{
            listStyle: 'none',
            padding: '4px 4px 2px',
            margin: 0,
            maxHeight: '140px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '3px'
          }}
        >
          {legend.map((item) => (
            <li
              key={item.label}
              className="color-legend-item"
              data-label={item.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '6px',
                fontSize: '11px',
                color: '#e2e8f0'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: 1 }}>
                <span
                  className="color-legend-swatch"
                  style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '2px',
                    backgroundColor: item.hex,
                    flexShrink: 0,
                    border: '1px solid rgba(255, 255, 255, 0.25)'
                  }}
                />
                <span
                  className="color-legend-label"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={item.label}
                >
                  {item.label}
                </span>
              </div>
              <span
                className="color-legend-count"
                style={{
                  color: '#94a3b8',
                  fontSize: '10px',
                  fontVariantNumeric: 'tabular-nums',
                  flexShrink: 0
                }}
              >
                {item.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
