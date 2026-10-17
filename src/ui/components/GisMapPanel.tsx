import React, { useEffect, useRef, useState } from 'react';
import { MapPin, Layers, X, Navigation } from 'lucide-react';
import { leafletService } from '../../infrastructure/gis/LeafletService';
import type { ModelRecord } from '../../domain/models/ModelRecord';

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
  const [clickedCoords, setClickedCoords] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    leafletService.initialize(mapContainerRef.current, (lat, lng) => {
      setClickedCoords({ lat, lng });
      if (models.length > 0 && onUpdateModelLocation) {
        onUpdateModelLocation(models[0].id, lat, lng);
      }
    });

    // Add markers for models
    const markers = models
      .filter((m) => m.coordinateReference?.latLng)
      .map((m) => ({
        id: m.id,
        title: m.fileName,
        lat: m.coordinateReference!.latLng![0],
        lng: m.coordinateReference!.latLng![1]
      }));

    leafletService.updateModelMarkers(markers);

    const timer = setTimeout(() => {
      leafletService.invalidateSize();
    }, 200);

    return () => {
      clearTimeout(timer);
    };
  }, [models]);

  const handleCenterModel = () => {
    const firstWithCoords = models.find((m) => m.coordinateReference?.latLng);
    if (firstWithCoords?.coordinateReference?.latLng) {
      const [lat, lng] = firstWithCoords.coordinateReference.latLng;
      leafletService.setCenter(lat, lng, 16);
    }
  };

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
          <span style={{ fontWeight: 600 }}>Contexto GIS 2D (Leaflet / PNOA / OSM)</span>
          {clickedCoords && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: '#94a3b8' }}>
              Lat: {clickedCoords.lat.toFixed(5)}, Lng: {clickedCoords.lng.toFixed(5)}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            className="btn btn-ghost btn-icon"
            onClick={handleCenterModel}
            title="Centrar en el modelo IFC"
          >
            <Navigation size={14} />
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Cerrar panel GIS">
            <X size={14} />
          </button>
        </div>
      </div>

      <div ref={mapContainerRef} className="gis-map-view" />
    </div>
  );
};
