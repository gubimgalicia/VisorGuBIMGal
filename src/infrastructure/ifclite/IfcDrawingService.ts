import {
  generateFloorPlan,
  generateSection,
  exportToDXF,
  exportToSVG,
  type Drawing2D,
  type DXFExportOptions,
  type SVGExportOptions
} from '@ifc-lite/drawing-2d';
import type { MeshData } from '@ifc-lite/geometry';
import type { SectionCutOptions, DrawingExportConfig } from '../../domain/drawings/DrawingTypes';

export class IfcDrawingService {
  private lastDrawing: Drawing2D | null = null;

  async generateDrawing(
    meshes: MeshData[],
    options: SectionCutOptions,
    onProgress?: (stage: string, percent: number) => void
  ): Promise<Drawing2D> {
    if (meshes.length === 0) {
      throw new Error('No hay mallas cargadas para generar el dibujo 2D.');
    }

    onProgress?.('Calculando plano de corte 2D', 20);

    let drawing: Drawing2D;

    if (options.cutType === 'floorplan') {
      drawing = await generateFloorPlan(meshes, options.position, {
        useGPU: false,
        includeHiddenLines: options.includeHiddenLines,
        includeProjection: options.includeProjection,
        includeEdges: options.includeEdges,
        mergeLines: options.mergeLines,
        onProgress: (stage, progress) => onProgress?.(stage, Math.round(progress * 100))
      });
    } else {
      const axis = options.cutType === 'section-x' ? 'x' : 'z';
      drawing = await generateSection(meshes, axis, options.position, {
        useGPU: false,
        includeHiddenLines: options.includeHiddenLines,
        includeProjection: options.includeProjection,
        includeEdges: options.includeEdges,
        mergeLines: options.mergeLines,
        onProgress: (stage, progress) => onProgress?.(stage, Math.round(progress * 100))
      });
    }

    this.lastDrawing = drawing;
    onProgress?.('Plano 2D generado', 100);
    return drawing;
  }

  exportDrawing(
    drawing: Drawing2D | null = this.lastDrawing,
    config: DrawingExportConfig
  ): { content: string; mimeType: string; filename: string } {
    if (!drawing) {
      throw new Error('No hay ningún dibujo 2D generado para exportar.');
    }

    if (config.format === 'dxf') {
      const dxfOptions: DXFExportOptions = {
        showHiddenLines: config.showHiddenLines,
        showHatching: config.showHatching,
        metadataComment: config.crsComment
          ? `CRS: ${config.crsComment} | VisorGuBIMGal IFClite export`
          : 'VisorGuBIMGal IFClite export'
      };

      const dxfContent = exportToDXF(drawing, dxfOptions);
      return {
        content: dxfContent,
        mimeType: 'application/dxf',
        filename: `${config.fileName}.dxf`
      };
    } else {
      const svgOptions: SVGExportOptions = {
        showHiddenLines: config.showHiddenLines,
        showHatching: config.showHatching,
        backgroundColor: '#090d16'
      };

      const svgContent = exportToSVG(drawing, svgOptions);
      return {
        content: svgContent,
        mimeType: 'image/svg+xml',
        filename: `${config.fileName}.svg`
      };
    }
  }

  downloadFile(content: string, mimeType: string, filename: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  getLastDrawing(): Drawing2D | null {
    return this.lastDrawing;
  }
}

export const ifcDrawingService = new IfcDrawingService();
