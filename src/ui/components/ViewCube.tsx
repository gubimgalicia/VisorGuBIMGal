import React from 'react';
import type { CameraPose, ViewPreset } from '../../domain/kernel/RendererPort';
import { computeViewCubeTransform } from '../../infrastructure/renderer/Camera';

export { computeViewCubeTransform };

export interface ViewCubeProps {
  pose: CameraPose | null;
  onSelectPreset: (preset: ViewPreset) => void;
}

const CUBE_HALF = 24; // half of 48px cube size

export const ViewCube: React.FC<ViewCubeProps> = ({ pose, onSelectPreset }) => {
  const cubeTransform = computeViewCubeTransform(pose);

  const faceStyle = (transform: string, bg: string): React.CSSProperties => ({
    position: 'absolute',
    width: `${CUBE_HALF * 2}px`,
    height: `${CUBE_HALF * 2}px`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '9px',
    fontWeight: 700,
    letterSpacing: '0.03em',
    color: '#e2e8f0',
    background: bg,
    border: '1px solid rgba(56, 189, 248, 0.45)',
    backfaceVisibility: 'hidden',
    cursor: 'pointer',
    userSelect: 'none',
    transform,
    padding: 0
  });

  const pillStyle: React.CSSProperties = {
    fontSize: '9px',
    fontWeight: 600,
    padding: '2px 5px',
    borderRadius: '3px',
    background: 'rgba(30, 41, 59, 0.85)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    color: '#cbd5e1',
    cursor: 'pointer'
  };

  return (
    <div
      className="view-cube-widget"
      aria-label="Cubo de vistas 3D"
      style={{
        position: 'absolute',
        top: '12px',
        right: '12px',
        zIndex: 12,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        padding: '8px',
        borderRadius: '8px',
        background: 'rgba(15, 23, 42, 0.78)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
      }}
    >
      <div
        style={{
          width: `${CUBE_HALF * 2}px`,
          height: `${CUBE_HALF * 2}px`,
          perspective: '220px',
          margin: '4px'
        }}
      >
        <div
          className="view-cube-3d"
          style={{
            width: '100%',
            height: '100%',
            position: 'relative',
            transformStyle: 'preserve-3d',
            transform: cubeTransform,
            transition: 'transform 60ms linear'
          }}
        >
          <button
            type="button"
            className="view-cube-face view-cube-face-front"
            style={faceStyle(`translateZ(${CUBE_HALF}px)`, 'rgba(30, 58, 138, 0.82)')}
            onClick={() => onSelectPreset('front')}
            title="Vista Sur (Frontal)"
          >
            SUR
          </button>
          <button
            type="button"
            className="view-cube-face view-cube-face-back"
            style={faceStyle(`rotateY(180deg) translateZ(${CUBE_HALF}px)`, 'rgba(30, 41, 59, 0.88)')}
            onClick={() => onSelectPreset('back')}
            title="Vista Norte (Posterior)"
          >
            NORTE
          </button>
          <button
            type="button"
            className="view-cube-face view-cube-face-right"
            style={faceStyle(`rotateY(90deg) translateZ(${CUBE_HALF}px)`, 'rgba(15, 118, 110, 0.82)')}
            onClick={() => onSelectPreset('right')}
            title="Vista Este (Derecha)"
          >
            ESTE
          </button>
          <button
            type="button"
            className="view-cube-face view-cube-face-left"
            style={faceStyle(`rotateY(-90deg) translateZ(${CUBE_HALF}px)`, 'rgba(30, 41, 59, 0.88)')}
            onClick={() => onSelectPreset('left')}
            title="Vista Oeste (Izquierda)"
          >
            OESTE
          </button>
          <button
            type="button"
            className="view-cube-face view-cube-face-top"
            style={faceStyle(`rotateX(90deg) translateZ(${CUBE_HALF}px)`, 'rgba(3, 105, 161, 0.88)')}
            onClick={() => onSelectPreset('top')}
            title="Vista Superior (Planta)"
          >
            SUP
          </button>
          <button
            type="button"
            className="view-cube-face view-cube-face-bottom"
            style={faceStyle(`rotateX(-90deg) translateZ(${CUBE_HALF}px)`, 'rgba(15, 23, 42, 0.92)')}
            onClick={() => onSelectPreset('bottom')}
            title="Vista Inferior"
          >
            INF
          </button>
        </div>
      </div>

      <div
        className="view-cube-presets"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, auto)',
          gap: '3px'
        }}
      >
        <button type="button" className="vc-btn-iso" style={pillStyle} onClick={() => onSelectPreset('iso')} title="Vista Isométrica">
          Iso
        </button>
        <button type="button" className="vc-btn-top" style={pillStyle} onClick={() => onSelectPreset('top')} title="Vista Superior (Planta)">
          Sup
        </button>
        <button type="button" className="vc-btn-front" style={pillStyle} onClick={() => onSelectPreset('front')} title="Vista Sur (Frontal)">
          Sur
        </button>
        <button type="button" className="vc-btn-right" style={pillStyle} onClick={() => onSelectPreset('right')} title="Vista Este (Derecha)">
          Este
        </button>
        <button type="button" className="vc-btn-bottom" style={pillStyle} onClick={() => onSelectPreset('bottom')} title="Vista Inferior">
          Inf
        </button>
        <button type="button" className="vc-btn-back" style={pillStyle} onClick={() => onSelectPreset('back')} title="Vista Norte (Posterior)">
          Norte
        </button>
        <button type="button" className="vc-btn-left" style={pillStyle} onClick={() => onSelectPreset('left')} title="Vista Oeste (Izquierda)">
          Oeste
        </button>
      </div>
    </div>
  );
};
