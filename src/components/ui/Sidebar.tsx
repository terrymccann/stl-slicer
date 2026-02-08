import React from 'react';
import { Axis } from '../../utils/StlSlicer';
import { Button } from './button';
import { Card } from './card';
import { Separator } from './separator';
import { ScrollArea } from './scroll-area';
import { Slider } from './slider';

interface SidebarProps {
  file: File | null;
  dimensions: { width: number; height: number; depth: number } | null;
  axis: Axis;
  layerThickness: number;
  isSlicing: boolean;
  sliceProgress?: number | null;
  hasLayers: boolean;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAxisChange: (axis: Axis) => void;
  onLayerThicknessChange: (thickness: number) => void;
  onSlice: () => void;
  onExport: () => void;
  onViewModeChange: (mode: '2d' | '3d') => void;
  viewMode: '2d' | '3d';
}

export function Sidebar({
  file,
  dimensions,
  axis,
  layerThickness,
  isSlicing,
  sliceProgress,
  hasLayers,
  onFileChange,
  onAxisChange,
  onLayerThicknessChange,
  onSlice,
  onExport,
  onViewModeChange,
  viewMode,
}: SidebarProps) {
  return (
    <div className="w-64 h-full border-r flex flex-col bg-background">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-6">
          <div>
            <h1 className="text-xl font-bold mb-2">STL Slicer</h1>
            <p className="text-sm text-muted-foreground">Upload and slice STL files</p>
          </div>
          
          <Separator />
          
          {/* File Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium">STL File</label>
            <input
              type="file"
              accept=".stl"
              onChange={onFileChange}
              className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-secondary file:text-secondary-foreground hover:file:bg-secondary/80"
            />
            {file && <p className="text-sm text-muted-foreground mt-1">Selected: {file.name}</p>}
          </div>
          
          {/* Dimensions Display */}
          {dimensions && (
            <Card className="p-4">
              <h3 className="font-medium text-sm mb-3">Model Dimensions</h3>
              <div className="space-y-2">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Width</p>
                  <p className="text-sm font-medium">{dimensions.width.toFixed(2)} mm</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Height</p>
                  <p className="text-sm font-medium">{dimensions.height.toFixed(2)} mm</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Depth</p>
                  <p className="text-sm font-medium">{dimensions.depth.toFixed(2)} mm</p>
                </div>
              </div>
            </Card>
          )}
          
          {/* Axis Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Slicing Axis</label>
            <div className="flex gap-4">
              {(['x', 'y', 'z'] as Axis[]).map((a) => (
                <label key={a} className="inline-flex items-center">
                  <input
                    type="radio"
                    name="axis"
                    value={a}
                    checked={axis === a}
                    onChange={() => onAxisChange(a)}
                    className="w-4 h-4 text-primary border-primary-foreground focus:ring-primary"
                  />
                  <span className="ml-2 text-sm uppercase">{a}</span>
                </label>
              ))}
            </div>
          </div>
          
          {/* Layer Thickness */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <label className="text-sm font-medium">Layer Thickness</label>
              <span className="text-xs text-muted-foreground">{layerThickness.toFixed(2)} mm</span>
            </div>
            <Slider
              value={[layerThickness]}
              min={0.1}
              max={5}
              step={0.1}
              onValueChange={(values) => onLayerThicknessChange(values[0])}
            />
            <div className="flex items-center mt-2">
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={layerThickness}
                onChange={(e) => onLayerThicknessChange(parseFloat(e.target.value))}
                className="w-20 px-2 py-1 text-sm border rounded-md"
              />
              <span className="ml-2 text-xs text-muted-foreground">mm</span>
            </div>
          </div>
          
          {/* Action Buttons */}
          <div className="space-y-3">
            <Button
              onClick={onSlice}
              disabled={!file || isSlicing}
              className="w-full"
              variant="default"
            >
              {isSlicing
                ? sliceProgress != null
                  ? `Slicing... ${sliceProgress}%`
                  : 'Slicing...'
                : 'Slice Model'}
            </Button>
            
            <Button
              onClick={onExport}
              disabled={!file || !hasLayers}
              className="w-full"
              variant="outline"
            >
              Export SVG Layers
            </Button>
          </div>
        </div>
      </ScrollArea>
      
      {/* View Toggle */}
      <div className="border-t p-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">View Mode</label>
          <div className="grid grid-cols-2 gap-2">
            <Button 
              variant={viewMode === '3d' ? 'default' : 'outline'}
              size="sm"
              onClick={() => onViewModeChange('3d')}
              className="w-full"
            >
              3D View
            </Button>
            <Button
              variant={viewMode === '2d' ? 'default' : 'outline'}
              size="sm"
              onClick={() => onViewModeChange('2d')}
              className="w-full"
            >
              2D View
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
} 