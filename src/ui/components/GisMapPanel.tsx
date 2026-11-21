import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, RefreshCw, WifiOff, X, Navigation } from 'lucide-react';
import { leafletService } from '../../infrastructure/gis/LeafletService';
import type { ModelRecord } from '../../domain/models/ModelRecord';
import {
  initialGisOnlineState,
  reduceGisOnlineState,
  type GisOnlineState
} from '../viewer/gisOnline';
import { formatFixed, t } from '../i18n';

interface GisMapPanelProps {
  models: ModelRecord[];
  onClose: () => void;
  onUpdateModelLocation?: (modelId: string, lat: number, lng: number) => void;
}

export const GisMapPanel: React.FC<GisMapPanelProps> = ({
  models,
  onClose,
  onUpdateModelLocation
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const onUpdateRef = useRef(onUpdateModelLocation);
  onUpdateRef.current = onUpdateModelLocation;
  const [clickedCoords, setClickedCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [conn, setConn] = useState<GisOnlineState>(() =>
    initialGisOnlineState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => {
      setConn((prev) => reduceGisOnlineState(prev, 'browser-online'));
      leafletService.redrawTiles();
    };
    const handleOffline = () => {
      setConn((prev) => reduceGisOnlineState(prev, 'browser-offline'));
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    leafletService.initialize(
      mapContainerRef.current,
      (lat, lng) => {
        setClickedCoords({ lat, lng });
        const current = modelsRef.current;
        if (current.length > 0 && onUpdateRef.current) {
          onUpdateRef.current(current[0].id, lat, lng);
        }
      },
      (ok) => {
        setConn((prev) => reduceGisOnlineState(prev, ok ? 'tile-load' : 'tile-error'));
      }
    );

    const raf = requestAnimationFrame(() => leafletService.invalidateSize());
    const timer = setTimeout(() => {
      leafletService.invalidateSize();
    }, 200);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      leafletService.destroy();
    };
  }, []);

  useEffect(() => {
    const markers = models
      .filter((m) => m.coordinateReference?.latLng)
      .map((m) => ({
        id: m.id,
        title: m.fileName,
        lat: m.coordinateReference!.latLng![0],
        lng: m.coordinateReference!.latLng![1]
      }));

    leafletService.updateModelMarkers(markers);
  }, [models]);

  const handleCenterModel = () => {
    const firstWithCoords = models.find((m) => m.coordinateReference?.latLng);
    if (firstWithCoords?.coordinateReference?.latLng) {
      const [lat, lng] = firstWithCoords.coordinateReference.latLng;
      leafletService.setCenter(lat, lng, 16);
    }
  };

  const handleRetryTiles = useCallback(() => {
    setConn((prev) => reduceGisOnlineState(prev, 'retry'));
    leafletService.redrawTiles();
  }, []);

  const georefModels = useMemo(
    () => models.filter((m) => m.coordinateReference?.latLng),
    [models]
  );

  return (
    <div className="gis-drawer">
      <div
        style={{
          padding: '6px 12px',
          background: '#0f172a',
          borderBottom: '1px solid #334155',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '12px',
          color: '#cbd5e1'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <MapPin size={14} color="#38bdf8" />
          <span style={{ fontWeight: 600 }}>{t('gis.headerTitle')}</span>
          {conn.status === 'offline' && (
            <span className="gis-offline-badge">
              <WifiOff size={12} />
              <span>{t('gis.offlineBadge')}</span>
            </span>
          )}
          {clickedCoords && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: '#94a3b8' }}>
              {t('gis.coordsLabel', {
                lat: formatFixed(clickedCoords.lat, 5),
                lng: formatFixed(clickedCoords.lng, 5)
              })}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            className="btn btn-ghost btn-icon"
            onClick={handleCenterModel}
            title={t('gis.centerModelTitle')}
          >
            <Navigation size={14} />
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title={t('gis.closeTitle')}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="gis-map-stage">
        <div ref={mapContainerRef} className="gis-map-view" />
        {conn.status === 'offline' && (
          <div className="gis-offline-banner" role="status">
            <div className="gis-offline-title">
              <WifiOff size={15} />
              <span>{t('gis.offlineTitle')}</span>
            </div>
            <p className="gis-offline-desc">{t('gis.offlineDescription')}</p>
            {georefModels.length > 0 && (
              <div className="gis-offline-coords">
                {georefModels.map((m) => (
                  <div key={m.id} className="gis-offline-coord-row">
                    <span>
                      {t('gis.offlineModelCoord', {
                        fileName: m.fileName,
                        crs: m.coordinateReference?.crsId ?? t('gis.crsLocal'),
                        lat: formatFixed(m.coordinateReference!.latLng![0], 5),
                        lng: formatFixed(m.coordinateReference!.latLng![1], 5)
                      })}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm gis-offline-retry-btn"
              onClick={handleRetryTiles}
            >
              <RefreshCw size={12} />
              <span>{t('gis.offlineRetryBtn')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
