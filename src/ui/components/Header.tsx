import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Upload,
  Layers,
  MapPin,
  Box,
  Eye,
  RefreshCw,
  Compass,
  Info,
  X
} from 'lucide-react';
import type { ViewPreset } from '../../domain/kernel/RendererPort';
import noticeText from '../../../NOTICE.md?raw';
import { GeometryCacheControl } from './GeometryCacheControl';
import { t } from '../i18n';

interface HeaderProps {
  onOpenFile: (file: File) => void;
  onLoadSample: (samplePath: string, name: string) => void;
  onSetPreset: (preset: ViewPreset) => void;
  onFitView: () => void;
  isGisExpanded: boolean;
  onToggleGis: () => void;
  isWorking: boolean;
  activeBackend?: 'webgpu' | 'webgl2' | null;
  isWebGpuAvailable?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenFile,
  onLoadSample,
  onSetPreset,
  onFitView,
  isGisExpanded,
  onToggleGis,
  isWorking,
  activeBackend,
  isWebGpuAvailable
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const backend =
    activeBackend !== undefined
      ? activeBackend
      : (isWebGpuAvailable ?? (typeof navigator !== 'undefined' && 'gpu' in navigator))
      ? 'webgpu'
      : null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onOpenFile(file);
      e.target.value = '';
    }
  };

  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand-icon">
          <Layers size={18} />
        </div>
        <div>
          <span className="brand-title">VisorGuBIMGal</span>
        </div>
      </div>

      <div className="header-actions">
        {/* WebGPU / WebGL2 Status Indicator */}
        <span
          className={`status-badge ${backend ? 'ready' : 'error'}`}
          title={
            backend === 'webgpu'
              ? t('header.backendTitleWebGpu')
              : backend === 'webgl2'
              ? t('header.backendTitleWebGl2')
              : t('header.backendTitleNone')
          }
        >
          {backend === 'webgpu'
            ? t('header.backendBadgeWebGpu')
            : backend === 'webgl2'
            ? t('header.backendBadgeWebGl2')
            : t('header.backendBadgeNone')}
        </span>

        {/* View presets */}
        <div style={{ display: 'flex', gap: '2px', background: '#1e293b', padding: '2px', borderRadius: '6px' }}>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => onSetPreset('iso')}
            title={t('header.presetIsoTitle')}
          >
            <Box size={16} />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => onSetPreset('top')}
            title={t('header.presetTopTitle')}
          >
            <Compass size={16} />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => onSetPreset('front')}
            title={t('header.presetFrontTitle')}
          >
            <Eye size={16} />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={onFitView}
            title={t('header.fitAllTitle')}
          >
            <RefreshCw size={15} />
          </button>
        </div>

        {/* Sample models */}
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            className="btn btn-secondary"
            disabled={isWorking}
            onClick={() =>
              onLoadSample(
                `${import.meta.env.BASE_URL}samples/SimpleWall.ifc`,
                t('header.sampleSimpleWallName')
              )
            }
            title={t('header.sampleSimpleWallTitle')}
          >
            <span>SimpleWall</span>
          </button>
          <button
            className="btn btn-secondary"
            disabled={isWorking}
            onClick={() =>
              onLoadSample(
                `${import.meta.env.BASE_URL}samples/ManySimpleWalls.ifc`,
                t('header.sampleManyWallsName')
              )
            }
            title={t('header.sampleManyWallsTitle')}
          >
            <span>ManySimpleWalls</span>
          </button>
        </div>

        {/* Upload Button */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".ifc"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <button
          className="btn btn-primary"
          disabled={isWorking}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={15} />
          <span>{isWorking ? t('header.loadingEllipsis') : t('header.openIfc')}</span>
        </button>

        {/* GIS Toggle */}
        <button
          className={`btn ${isGisExpanded ? 'btn-primary' : 'btn-secondary'}`}
          onClick={onToggleGis}
          title={t('header.gisTitle')}
        >
          <MapPin size={15} />
          <span>{t('header.gisLabel')}</span>
        </button>

        {/* Acerca de Button */}
        <button
          className="btn btn-secondary"
          onClick={() => setShowAbout(true)}
          title={t('header.aboutTitle')}
        >
          <Info size={15} />
          <span>{t('header.aboutLabel')}</span>
        </button>
      </div>

      {/* Acerca de modal panel */}
      {showAbout && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '20px'
          }}
          onClick={() => setShowAbout(false)}
        >
          <div
            style={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '8px',
              maxWidth: '680px',
              width: '100%',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
              overflow: 'hidden'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                borderBottom: '1px solid #1e293b',
                backgroundColor: '#1e293b'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '14px', color: '#f8fafc' }}>
                <Info size={16} color="#38bdf8" />
                <span>{t('header.aboutModalTitle')}</span>
              </div>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setShowAbout(false)}
                title={t('common.close')}
                style={{ padding: '4px' }}
              >
                <X size={18} />
              </button>
            </div>
            <div
              style={{
                padding: '16px',
                overflowY: 'auto',
                fontSize: '12px',
                lineHeight: 1.6,
                color: '#cbd5e1'
              }}
            >
              <pre
                style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: 0
                }}
              >
                {noticeText}
              </pre>
            </div>
            <div
              style={{
                padding: '10px 16px',
                borderTop: '1px solid #1e293b',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
                backgroundColor: '#0f172a'
              }}
            >
              <GeometryCacheControl />
              <button className="btn btn-secondary" onClick={() => setShowAbout(false)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </header>
  );
};
