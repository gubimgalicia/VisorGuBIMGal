import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, Building, Layers, Box } from 'lucide-react';
import type { ModelRecord, ModelId } from '../../domain/models/ModelRecord';
import { ifcParserService } from '../../infrastructure/ifclite/IfcParserService';

interface SpatialTreePanelProps {
  models: ModelRecord[];
  onSelectElement: (modelId: ModelId, expressId: number) => void;
  selectedExpressId?: number;
}

export const SpatialTreePanel: React.FC<SpatialTreePanelProps> = ({
  models,
  onSelectElement,
  selectedExpressId
}) => {
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({ root: true });

  const toggleNode = (nodeKey: string) => {
    setExpandedNodes((prev) => ({ ...prev, [nodeKey]: !prev[nodeKey] }));
  };

  if (models.length === 0) {
    return (
      <div style={{ padding: '24px 12px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
        No hay modelos para mostrar el árbol espacial.
      </div>
    );
  }

  return (
    <div style={{ fontSize: '12px' }}>
      {models.map((model) => {
        const hierarchy = ifcParserService.getSpatialHierarchy(model.id);
        const project = hierarchy?.project;
        const storeys = hierarchy?.byStorey ? Array.from(hierarchy.byStorey.entries()) : [];

        return (
          <div key={model.id} style={{ marginBottom: '12px' }}>
            {/* Model root */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 0',
                fontWeight: 600,
                color: '#38bdf8',
                cursor: 'pointer'
              }}
              onClick={() => toggleNode(`model-${model.id}`)}
            >
              {expandedNodes[`model-${model.id}`] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Building size={14} />
              <span title={model.fileName}>{model.fileName}</span>
            </div>

            {expandedNodes[`model-${model.id}`] && (
              <div style={{ paddingLeft: '16px' }}>
                {project && (
                  <div style={{ padding: '2px 0', color: '#cbd5e1' }}>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}
                      onClick={() => toggleNode(`proj-${project.expressId}`)}
                    >
                      {expandedNodes[`proj-${project.expressId}`] ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )}
                      <Folder size={13} color="#f59e0b" />
                      <span>{project.name || 'Proyecto'}</span>
                    </div>
                  </div>
                )}

                {/* Storeys */}
                {storeys.map(([storeyId, elementIds]) => (
                  <div key={storeyId} style={{ marginTop: '4px' }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        cursor: 'pointer',
                        color: '#94a3b8'
                      }}
                      onClick={() => toggleNode(`storey-${storeyId}`)}
                    >
                      {expandedNodes[`storey-${storeyId}`] ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )}
                      <Layers size={13} color="#10b981" />
                      <span>Planta #{storeyId} ({elementIds.length} elem.)</span>
                    </div>

                    {expandedNodes[`storey-${storeyId}`] && (
                      <div style={{ paddingLeft: '18px', marginTop: '2px' }}>
                        {elementIds.slice(0, 50).map((elemId) => (
                          <div
                            key={elemId}
                            style={{
                              padding: '2px 6px',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              background: selectedExpressId === elemId ? '#0284c7' : 'transparent',
                              color: selectedExpressId === elemId ? 'white' : '#cbd5e1'
                            }}
                            onClick={() => onSelectElement(model.id, elemId)}
                          >
                            <Box size={11} />
                            <span>Elemento #{elemId}</span>
                          </div>
                        ))}
                        {elementIds.length > 50 && (
                          <div style={{ color: '#64748b', fontSize: '11px', padding: '2px 6px' }}>
                            ... y {elementIds.length - 50} elementos más
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
