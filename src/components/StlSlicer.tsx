'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { StlSlicer as StlSlicerUtil, Axis, LayerData } from '../utils/StlSlicer';
import { exportSvgZip } from '../utils/exportUtils';
import { sliceInWorker } from '../utils/slicerWorkerClient';
import * as THREE from 'three';
import dynamic from 'next/dynamic';
import { Sidebar } from './ui/Sidebar';
import { Button } from './ui/button';

// Improved dynamic import to avoid chunk loading errors
const StlViewer3D = dynamic(
  () => import('./StlViewer3D').then(mod => mod.default), 
  {
    loading: () => (
      <div className="w-full h-[400px] border rounded-md bg-gray-100 flex items-center justify-center">
        <p>Loading 3D Viewer...</p>
      </div>
    ),
  }
);

export default function StlSlicer() {
  const [file, setFile] = useState<File | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number; depth: number } | null>(null);
  const [axis, setAxis] = useState<Axis>('z');
  const [layerThickness, setLayerThickness] = useState<number>(1);
  const [isSlicing, setIsSlicing] = useState<boolean>(false);
  const [layers, setLayers] = useState<LayerData[]>([]);
  const [previewLayerIndex, setPreviewLayerIndex] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isClientSide, setIsClientSide] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('3d');
  const [zoomLevel, setZoomLevel] = useState<number>(0.7);
  
  const [sliceProgress, setSliceProgress] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const slicerRef = useRef<StlSlicerUtil | null>(null);
  const sliceIdRef = useRef<number>(0); // monotonic counter to discard stale slice results
  const workerHandleRef = useRef<{ terminate: () => void } | null>(null);
  
  // Check if we're on the client side
  useEffect(() => {
    setIsClientSide(true);
    // Only initialize the slicer on the client side
    slicerRef.current = new StlSlicerUtil();

    return () => {
      workerHandleRef.current?.terminate();
    };
  }, []);
  
  // Handle file selection
  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!isClientSide) return;
    
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    
    setFile(selectedFile);
    setError(null);
    
    try {
      if (!slicerRef.current) {
        slicerRef.current = new StlSlicerUtil();
      }
      
      await slicerRef.current.loadSTL(selectedFile);
      const dims = slicerRef.current.getDimensions();
      if (dims) {
        setDimensions(dims);
      }
    } catch (err) {
      setError('Failed to load STL file. Please check the file format.');
      console.error(err);
    }
  }, [isClientSide]);
  
  // Shared helper: run slicing in a Web Worker
  const runSliceWorker = useCallback((sliceAxis: Axis, thickness: number, resetZoom: boolean) => {
    const slicer = slicerRef.current;
    if (!slicer) return;

    const geometry = slicer.getGeometry();
    const boundingBox = slicer.getBoundingBox();
    if (!geometry || !boundingBox) return;

    // Cancel any in-flight worker
    workerHandleRef.current?.terminate();

    const currentId = ++sliceIdRef.current;
    setIsSlicing(true);
    setSliceProgress(null);
    setError(null);

    const handle = sliceInWorker(
      geometry,
      boundingBox,
      sliceAxis,
      thickness,
      currentId,
      (percent) => {
        if (currentId === sliceIdRef.current) {
          setSliceProgress(Math.round(percent));
        }
      }
    );
    workerHandleRef.current = handle;

    handle.promise
      .then((slicedLayers) => {
        if (currentId === sliceIdRef.current) {
          setLayers(slicedLayers);
          setPreviewLayerIndex(Math.floor(slicedLayers.length / 2));
          if (resetZoom) setZoomLevel(0.7);
        }
      })
      .catch((err) => {
        if (currentId === sliceIdRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to slice the model.');
        }
      })
      .finally(() => {
        if (currentId === sliceIdRef.current) {
          setIsSlicing(false);
          setSliceProgress(null);
        }
      });
  }, []);

  // Update axis and trigger new slicing when changed
  const handleAxisChange = useCallback((newAxis: Axis) => {
    setAxis(newAxis);

    if (slicerRef.current && file) {
      runSliceWorker(newAxis, layerThickness, false);
    }
  }, [file, layerThickness, runSliceWorker]);
  
  // Handle layer thickness change
  const handleLayerThicknessChange = useCallback((newThickness: number) => {
    setLayerThickness(newThickness);
  }, []);
  
  // Function to handle zoom in/out
  const handleZoomChange = useCallback((direction: 'in' | 'out') => {
    setZoomLevel(prevZoom => {
      // Larger zoom steps for better control
      const zoomChange = direction === 'in' ? 0.15 : -0.15;
      const newZoom = Math.max(0.1, Math.min(3.0, prevZoom + zoomChange));
      return newZoom;
    });
  }, []);
  
  // Function to reset zoom to fit the view
  const handleZoomReset = useCallback(() => {
    setZoomLevel(0.7); // Reset to 70% for better visibility
  }, []);
  
  // Function to fit the model to the view
  const handleFitToView = useCallback(() => {
    if (!layers.length || !canvasRef.current || previewLayerIndex >= layers.length) return;

    const canvas = canvasRef.current;
    const layer = layers[previewLayerIndex];

    if (layer.paths.length === 0) {
      setZoomLevel(0.7);
      return;
    }

    const { bounds } = layer;
    const modelWidth = bounds.maxX - bounds.minX;
    const modelHeight = bounds.maxY - bounds.minY;

    if (modelWidth <= 0 || modelHeight <= 0) {
      setZoomLevel(0.7);
      return;
    }

    const margin = 0.2;
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    const zoomX = (canvasWidth / (modelWidth * (1 + margin * 2))) * 0.9;
    const zoomY = (canvasHeight / (modelHeight * (1 + margin * 2))) * 0.9;

    let optimalZoom = Math.min(zoomX, zoomY);
    optimalZoom = Math.max(0.2, Math.min(0.9, optimalZoom));

    setZoomLevel(optimalZoom);
  }, [layers, previewLayerIndex]);
  
  // Perform slicing operation
  const handleSlice = useCallback(() => {
    if (!isClientSide) return;
    if (!slicerRef.current || !file) {
      setError('No STL file loaded');
      return;
    }

    runSliceWorker(axis, layerThickness, true);
  }, [axis, layerThickness, file, isClientSide, runSliceWorker]);
  
  // Export sliced layers as SVG files in a ZIP archive
  const handleExport = useCallback(async () => {
    if (!isClientSide) return;
    if (!slicerRef.current || !file || layers.length === 0) {
      setError('No sliced layers to export');
      return;
    }
    
    try {
      const svgContents = layers.map(layer => ({
        layer,
        svg: slicerRef.current!.generateSVG(layer, axis)
      }));
      
      await exportSvgZip(svgContents, file.name.replace('.stl', ''));
    } catch (err) {
      setError('Failed to export layers');
      console.error(err);
    }
  }, [file, layers, isClientSide]);
  
  // Add a new effect to ensure canvas size matches container
  useEffect(() => {
    if (!canvasRef.current) return;
    
    // Function to resize canvas to match its container
    const resizeCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const container = canvas.parentElement;
      if (!container) return;
      
      // Get the container's dimensions
      const rect = container.getBoundingClientRect();
      
      // Set canvas dimensions to match container
      canvas.width = rect.width;
      canvas.height = rect.height;
      
      // Force redraw if we have layers
      if (layers.length > 0) {
        // This will trigger the drawing effect
        const currentZoom = zoomLevel;
        setZoomLevel(currentZoom); 
      }
    };
    
    // Initial resize
    resizeCanvas();
    
    // Set up resize observer to adjust canvas when container size changes
    const resizeObserver = new ResizeObserver(resizeCanvas);
    if (canvasRef.current.parentElement) {
      resizeObserver.observe(canvasRef.current.parentElement);
    }
    
    // Clean up
    return () => {
      resizeObserver.disconnect();
    };
  }, [canvasRef, layers.length, zoomLevel]);
  
  // Completely revised drawing function with a simpler approach
  useEffect(() => {
    if (!isClientSide || !canvasRef.current || !layers.length) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Clear canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (previewLayerIndex >= 0 && previewLayerIndex < layers.length) {
      const layer = layers[previewLayerIndex];
      
      if (layer.paths.length === 0) {
        ctx.font = '16px sans-serif';
        ctx.fillStyle = 'red';
        ctx.textAlign = 'center';
        ctx.fillText(
          `No slice data at this layer (${layer.z.toFixed(2)}mm)`,
          canvas.width / 2, canvas.height / 2
        );
        return;
      }

      // Use cached bounds from layer
      const { minX, maxX, minY, maxY } = layer.bounds;
      const modelWidth = maxX - minX;
      const modelHeight = maxY - minY;
      
      // Ensure we have valid dimensions
      if (modelWidth <= 0 || modelHeight <= 0) {
        ctx.font = '16px sans-serif';
        ctx.fillStyle = 'red';
        ctx.textAlign = 'center';
        ctx.fillText(
          `Invalid model dimensions`, 
          canvas.width / 2, canvas.height / 2
        );
        return;
      }
      
      // Calculate scale to fit in canvas with 20% margin
      const margin = 0.2;
      const availableWidth = canvas.width * (1 - margin);
      const availableHeight = canvas.height * (1 - margin);
      
      const scaleX = availableWidth / modelWidth;
      const scaleY = availableHeight / modelHeight;
      
      // Use the smaller scale to ensure the entire model fits
      let baseScale = Math.min(scaleX, scaleY);
      
      // Apply user zoom
      const scale = baseScale * zoomLevel;
      
      // Translate to center of canvas
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.scale(scale, scale);
      
      // Calculate center of model in model space
      const modelCenterX = (minX + maxX) / 2;
      const modelCenterY = (minY + maxY) / 2;
      
      // Translate to center the model
      ctx.translate(-modelCenterX, -modelCenterY);
      
      // Draw all paths
      ctx.strokeStyle = 'black';
      ctx.fillStyle = 'rgba(200, 220, 255, 0.2)';
      ctx.lineWidth = 1 / scale;
      
      for (const path of layer.paths) {
        if (path.length < 2) continue;
        
        ctx.beginPath();
        ctx.moveTo(path[0].x, path[0].y);
        
        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(path[i].x, path[i].y);
        }
        
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      
      // Restore context to draw text without transforms
      ctx.restore();
      
      // Draw layer info text
      ctx.font = '12px sans-serif';
      ctx.fillStyle = 'black';
      ctx.textAlign = 'left';
      ctx.fillText(
        `Layer ${previewLayerIndex + 1}/${layers.length} - Height: ${layer.z.toFixed(2)}mm (${layer.paths.length} paths)`,
        10, 20
      );
    }
  }, [layers, previewLayerIndex, isClientSide, zoomLevel]);
  
  // If we're not on the client side yet, return an empty div to avoid hydration mismatches
  if (!isClientSide) {
    return <div className="loading-container h-[500px] flex items-center justify-center">
      <p>Loading STL Slicer...</p>
    </div>;
  }
  
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        file={file}
        dimensions={dimensions}
        axis={axis}
        layerThickness={layerThickness}
        isSlicing={isSlicing}
        sliceProgress={sliceProgress}
        hasLayers={layers.length > 0}
        onFileChange={handleFileChange}
        onAxisChange={handleAxisChange}
        onLayerThicknessChange={handleLayerThicknessChange}
        onSlice={handleSlice}
        onExport={handleExport}
        onViewModeChange={setViewMode}
        viewMode={viewMode}
      />
      
      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden p-6">
        {/* Error Display */}
        {error && (
          <div className="w-full p-4 bg-red-50 text-red-700 rounded-md mb-6">
            {error}
          </div>
        )}
        
        {/* 3D or 2D View based on selected mode */}
        <div className="flex-1 overflow-hidden">
          {file && (
            <>
              {viewMode === '3d' ? (
                <>
                  <div className="relative w-full h-full" style={{ 
                    zIndex: 10, 
                    minHeight: '400px',
                    pointerEvents: 'auto'
                  }}>
                    <StlViewer3D
                      stlFile={file}
                      layers={layers}
                      axis={axis}
                      layerThickness={layerThickness}
                      activeLayerIndex={previewLayerIndex}
                    />
                    
                    {/* Move the instructions to the top right corner */}
                    <div 
                      className="absolute top-2 right-2 p-2 bg-blue-50 rounded-md text-sm shadow-md border border-blue-100 max-w-[250px]"
                      style={{ opacity: 0.85, zIndex: 20 }}
                    >
                      <p className="font-medium text-xs">3D Controls:</p>
                      <ul className="list-disc pl-4 text-xs text-gray-700 mt-1">
                        <li>Drag to rotate</li>
                        <li>Scroll to zoom</li>
                        <li>Shift+drag to pan</li>
                      </ul>
                    </div>
                  </div>
                </>
              ) : (
                layers.length > 0 && (
                  <div className="w-full h-full flex flex-col">
                    <div className="flex justify-between items-center mb-2">
                      <h3 className="font-medium">
                        2D Layer Preview: {previewLayerIndex + 1} / {layers.length}
                      </h3>
                      <div className="flex items-center space-x-2">
                        <Button
                          onClick={() => handleZoomChange('out')}
                          variant="outline"
                          size="sm"
                          title="Zoom Out"
                        >
                          <span className="text-lg">−</span>
                        </Button>
                        <Button
                          onClick={handleZoomReset}
                          variant="outline"
                          size="sm"
                          title="Reset Zoom"
                        >
                          <span className="text-xs">Reset</span>
                        </Button>
                        <Button
                          onClick={handleFitToView}
                          variant="outline"
                          size="sm"
                          title="Fit to View"
                        >
                          <span className="text-xs">Fit</span>
                        </Button>
                        <Button
                          onClick={() => handleZoomChange('in')}
                          variant="outline"
                          size="sm"
                          title="Zoom In"
                        >
                          <span className="text-lg">+</span>
                        </Button>
                        <span className="ml-2 text-xs text-gray-600">
                          {Math.round(zoomLevel * 100)}%
                        </span>
                      </div>
                    </div>
                    <div className="flex-1 relative overflow-hidden" style={{ minHeight: "400px" }}>
                      <canvas
                        ref={canvasRef}
                        className="w-full h-full border rounded-md bg-white"
                      />
                    </div>
                  </div>
                )
              )}
            </>
          )}
        </div>
        
        {/* Layer Navigation - Positioned below the canvas */}
        {layers.length > 0 && (
          <div className="mt-4 pt-4 border-t">
            <h3 className="font-medium mb-2">
              Navigate Layers: {previewLayerIndex + 1} / {layers.length}
            </h3>
            <div className="flex gap-4 items-center mb-4">
              <Button
                onClick={() => setPreviewLayerIndex(Math.max(0, previewLayerIndex - 1))}
                disabled={previewLayerIndex === 0}
                variant="outline"
                size="sm"
              >
                Previous
              </Button>
              
              <input
                type="range"
                min="0"
                max={layers.length - 1}
                value={previewLayerIndex}
                onChange={(e) => setPreviewLayerIndex(parseInt(e.target.value))}
                className="w-full"
              />
              
              <Button
                onClick={() => setPreviewLayerIndex(Math.min(layers.length - 1, previewLayerIndex + 1))}
                disabled={previewLayerIndex === layers.length - 1}
                variant="outline"
                size="sm"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
} 