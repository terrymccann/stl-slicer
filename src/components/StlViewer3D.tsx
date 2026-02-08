'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Axis, LayerData } from '../utils/StlSlicer';

interface StlViewer3DProps {
  stlFile: File | null;
  layers: LayerData[];
  axis: Axis;
  layerThickness: number;
  activeLayerIndex: number;
}

export default function StlViewer3D({ 
  stlFile, 
  layers, 
  axis, 
  layerThickness,
  activeLayerIndex 
}: StlViewer3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const gridHelperRef = useRef<THREE.GridHelper | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showSlicePlanes, setShowSlicePlanes] = useState<boolean>(true);
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [showAllSlices, setShowAllSlices] = useState<boolean>(false);
  const initRef = useRef<boolean>(false);  // Use ref instead of state to avoid re-renders
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  
  // Toggle visibility functions
  const toggleGrid = useCallback(() => {
    setShowGrid(prev => !prev);
    if (gridHelperRef.current) {
      gridHelperRef.current.visible = !showGrid;
    }
  }, [showGrid]);
  
  const toggleSlicePlanes = useCallback(() => {
    setShowSlicePlanes(prev => !prev);

    if (sceneRef.current) {
      sceneRef.current.traverse((object) => {
        if (object.userData && object.userData.isSlicePlane) {
          object.visible = !showSlicePlanes;
        }
      });
    }
  }, [showSlicePlanes]);
  
  const toggleAllSlices = useCallback(() => {
    setShowAllSlices(prev => !prev);

    if (sceneRef.current) {
      sceneRef.current.traverse((object) => {
        if (object.userData && object.userData.isSlicePlane) {
          const sliceIndex = object.userData.sliceIndex;
          if (sliceIndex !== undefined) {
            object.visible = showAllSlices || sliceIndex === activeLayerIndex;
          }
        }
      });
    }
  }, [showAllSlices, activeLayerIndex]);
  
  // Helper: remove and dispose all slice planes from the scene
  const removeAllSlicePlanes = useCallback((scene: THREE.Scene) => {
    const planes = scene.children.filter((child: THREE.Object3D) =>
      child.userData && child.userData.isSlicePlane);

    planes.forEach((plane: THREE.Object3D) => {
      scene.remove(plane);
      if ((plane as THREE.Mesh).geometry) {
        (plane as THREE.Mesh).geometry.dispose();
      }
      const mat = (plane as THREE.Mesh).material;
      if (mat) {
        if (Array.isArray(mat)) {
          mat.forEach(m => m.dispose());
        } else if (mat instanceof THREE.Material) {
          mat.dispose();
        }
      }
    });
  }, []);

  // Initialize the Three.js scene, camera, and renderer
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current || initRef.current) return;
    
    try {
      // Setting up scene
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xf0f0f0);
      sceneRef.current = scene;
      
      // Add lights
      const ambientLight = new THREE.AmbientLight(0x888888);
      scene.add(ambientLight);
      
      const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
      directionalLight.position.set(1, 1, 1);
      scene.add(directionalLight);
      
      // Setup camera
      const canvas = canvasRef.current;
      const width = canvas.clientWidth || 300;  // Fallback width if clientWidth is 0
      const height = canvas.clientHeight || 200;  // Fallback height if clientHeight is 0
      
      const camera = new THREE.PerspectiveCamera(
        75, 
        width / height, 
        0.1, 
        2000
      );
      camera.position.set(50, 50, 50);
      cameraRef.current = camera;
      
      // Setup renderer
      const renderer = new THREE.WebGLRenderer({ 
        canvas,
        antialias: true,
        alpha: true,
      });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(width, height);
      rendererRef.current = renderer;
      
      // Setup orbit controls
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.1;
      controls.rotateSpeed = 0.6;
      controls.panSpeed = 0.5;
      controls.zoomSpeed = 0.8;
      controls.screenSpacePanning = true;
      controls.minDistance = 1;
      controls.maxDistance = 1000;
      controls.target.set(0, 0, 0);
      controls.update();
      controlsRef.current = controls;

      // Add helpers
      const gridHelper = new THREE.GridHelper(100, 20);
      gridHelper.position.y = -20;
      gridHelper.userData = { isHelper: true };
      scene.add(gridHelper);
      gridHelperRef.current = gridHelper;
      
      const axesHelper = new THREE.AxesHelper(10);
      axesHelper.userData = { isHelper: true };
      scene.add(axesHelper);
      
      // Handle resize with ResizeObserver for better accuracy
      const handleResize = () => {
        if (!containerRef.current || !canvasRef.current || !renderer || !camera) return;
        
        const canvas = canvasRef.current;
        const container = containerRef.current;
        
        // Get the actual dimensions of the container
        const width = container.clientWidth;
        const height = container.clientHeight;
        
        if (width === 0 || height === 0) return; // Skip invalid dimensions
        
        // Update the canvas size to match the container
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        
        // Update camera and renderer
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
      };
      
      // Setup ResizeObserver for more accurate size tracking
      if (containerRef.current && typeof ResizeObserver !== 'undefined') {
        const resizeObserver = new ResizeObserver(() => {
          requestAnimationFrame(handleResize);
        });
        
        resizeObserver.observe(containerRef.current);
        resizeObserverRef.current = resizeObserver;
      }
      
      // Initial resize
      handleResize();
      
      // Animation loop
      let animFrameId: number;
      const animate = () => {
        animFrameId = requestAnimationFrame(animate);
        
        if (controls) controls.update();
        if (renderer && scene && camera) {
          renderer.render(scene, camera);
        }
      };
      
      // Start animation
      animate();
      
      // Also listen to window resize events as a fallback
      window.addEventListener('resize', handleResize);
      
      // Mark as initialized using ref (not state)
      initRef.current = true;
      
      // Cleanup function
      return () => {
        cancelAnimationFrame(animFrameId);
        window.removeEventListener('resize', handleResize);
        
        if (resizeObserverRef.current) {
          resizeObserverRef.current.disconnect();
        }
        
        if (rendererRef.current) {
          rendererRef.current.dispose();
        }
        
        // Clean up the scene
        if (sceneRef.current) {
          sceneRef.current.traverse((object) => {
            if (object instanceof THREE.Mesh) {
              if (object.geometry) {
                object.geometry.dispose();
              }
              
              if (object.material) {
                if (Array.isArray(object.material)) {
                  object.material.forEach(material => material.dispose());
                } else {
                  object.material.dispose();
                }
              }
            }
          });
          
          // Explicitly remove all objects from the scene
          while (sceneRef.current.children.length > 0) {
            sceneRef.current.remove(sceneRef.current.children[0]);
          }
        }
      };
    } catch {
      setErrorMessage("Failed to initialize 3D viewer. Please try reloading the page.");
    }
  }, []);
  
  // Load STL file when it changes
  useEffect(() => {
    if (!initRef.current || !stlFile || !sceneRef.current) return;
    
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    
    if (!scene || !camera || !controls) return;
    
    const loadSTL = async () => {
      // Remove all previous slice planes
      removeAllSlicePlanes(scene);

      // Remove previous model meshes
      const existingModels = scene.children.filter(
        child => child instanceof THREE.Mesh &&
        !(child.userData && (child.userData.isSlicePlane || child.userData.isHelper))
      );

      existingModels.forEach(model => {
        scene.remove(model);
        if ((model as THREE.Mesh).geometry) (model as THREE.Mesh).geometry.dispose();
        const mat = (model as THREE.Mesh).material;
        if (mat) {
          if (Array.isArray(mat)) {
            mat.forEach(m => m.dispose());
          } else if (mat instanceof THREE.Material) {
            mat.dispose();
          }
        }
      });
      
      try {
        // Read file
        const arrayBuffer = await stlFile.arrayBuffer();
        
        // Parse STL
        const loader = new STLLoader();
        const geometry = loader.parse(arrayBuffer);
        
        // Create material
        const material = new THREE.MeshPhongMaterial({
          color: 0x00abff,
          specular: 0x111111,
          shininess: 200,
          opacity: 0.8,
          transparent: true,
          side: THREE.DoubleSide,
        });
        
        // Create mesh
        const model = new THREE.Mesh(geometry, material);
        
        // Center model
        geometry.computeBoundingBox();
        const boundingBox = geometry.boundingBox!;
        const center = new THREE.Vector3();
        boundingBox.getCenter(center);
        model.position.set(-center.x, -center.y, -center.z);
        
        // Add to scene
        scene.add(model);

        // Adjust camera position based on model size
        const size = new THREE.Vector3();
        boundingBox.getSize(size);
        const maxDimension = Math.max(size.x, size.y, size.z);
        const optimalDistance = maxDimension * 2;
        camera.position.set(
          optimalDistance, 
          optimalDistance, 
          optimalDistance
        );
        controls.target.set(0, 0, 0);
        controls.update();
        
        // Call once after loading
        renderSlicePlanes();
      } catch {
        setErrorMessage("Failed to load STL file");
      }
    };
    
    loadSTL();
  }, [stlFile]); // Only depend on stlFile, not initialized state
  
  // Function to render slice planes
  const renderSlicePlanes = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene || !layers.length) return;

    // Remove and dispose all existing slice planes
    removeAllSlicePlanes(scene);
    
    // Don't create new planes if we're not showing them
    if (!showSlicePlanes) return;
    
    // Find all meshes that are actual model parts (not helpers or slice planes)
    const modelMeshes = scene.children.filter((child: THREE.Object3D) => 
      child instanceof THREE.Mesh && 
      !(child.userData && (child.userData.isSlicePlane || child.userData.isHelper)));
    
    if (modelMeshes.length === 0) return;
    
    // Get the model bounding box to determine proper plane size and position
    const modelBounds = new THREE.Box3();
    modelMeshes.forEach((mesh: THREE.Object3D) => {
      const meshBounds = new THREE.Box3().setFromObject(mesh);
      modelBounds.union(meshBounds);
    });
    
    const modelSize = new THREE.Vector3();
    modelBounds.getSize(modelSize);
    
    // Get the model min and max for correct slice positioning
    const modelMin = modelBounds.min;
    const modelMax = modelBounds.max;
    
    // Make the planes slightly larger than the model
    const planeWidth = Math.max(modelSize.x, modelSize.z) * 1.2;
    const planeHeight = Math.max(modelSize.y, modelSize.z) * 1.2;
    const planeDepth = Math.max(modelSize.x, modelSize.y) * 1.2;
    
    // Create plane geometry based on slicing axis
    let planeGeometry: THREE.PlaneGeometry;
    
    if (axis === 'x') {
      planeGeometry = new THREE.PlaneGeometry(planeHeight, planeDepth);
      planeGeometry.rotateY(Math.PI / 2);
    } else if (axis === 'y') {
      planeGeometry = new THREE.PlaneGeometry(planeWidth, planeDepth);
      planeGeometry.rotateX(Math.PI / 2);
    } else { // z-axis
      planeGeometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    }
    
    // Calculate the model's start and end position along the current axis
    let axisStart, axisEnd;
    if (axis === 'x') {
      axisStart = modelMin.x;
      axisEnd = modelMax.x;
    } else if (axis === 'y') {
      axisStart = modelMin.y;
      axisEnd = modelMax.y;
    } else { // z-axis
      axisStart = modelMin.z;
      axisEnd = modelMax.z;
    }
    
    // Determine which layers to render based on user preference
    let startIdx, endIdx;
    
    if (showAllSlices) {
      // Show all layers when "show all slices" is active
      startIdx = 0;
      endIdx = layers.length - 1;
    } else {
      // Otherwise limit to display range for performance
      const displayRange = 5;
      startIdx = Math.max(0, activeLayerIndex - displayRange);
      endIdx = Math.min(layers.length - 1, activeLayerIndex + displayRange);
    }
    
    for (let i = startIdx; i <= endIdx; i++) {
      const layer = layers[i];
      const isActive = i === activeLayerIndex;
      
      // Calculate the normalized position (0 to 1) within the model
      const normalizedPos = layers.length > 1 
        ? i / (layers.length - 1) 
        : 0.5;
        
      // Calculate the actual position in scene coordinates
      const layerPosition = axisStart + normalizedPos * (axisEnd - axisStart);
      
      const material = new THREE.MeshBasicMaterial({
        color: isActive ? 0xff5500 : 0x00ff00,
        opacity: isActive ? 0.7 : 0.3,
        transparent: true,
        side: THREE.DoubleSide,
        wireframe: false,
      });
      
      const plane = new THREE.Mesh(planeGeometry.clone(), material);
      plane.userData = { isSlicePlane: true, sliceIndex: i };

      // Position plane based on axis
      if (axis === 'x') {
        plane.position.x = layerPosition;
      } else if (axis === 'y') {
        plane.position.y = layerPosition;
      } else {
        plane.position.z = layerPosition;
      }

      scene.add(plane);
    }

    // Dispose the base geometry template — clones are independent
    planeGeometry.dispose();

    // Trigger a render
    if (rendererRef.current && cameraRef.current) {
      rendererRef.current.render(scene, cameraRef.current);
    }
  }, [layers, activeLayerIndex, axis, showSlicePlanes, showAllSlices, removeAllSlicePlanes]);
  
  // Effect to update slice planes when layers, active layer, or axis changes
  useEffect(() => {
    if (initRef.current && sceneRef.current) {
      renderSlicePlanes();
    }
  }, [renderSlicePlanes]);
  
  return (
    <div 
      ref={containerRef}
      className="w-full h-full relative"
      style={{ touchAction: 'none' }}
    >
      <canvas 
        ref={canvasRef} 
        className="w-full h-full outline-none"
        tabIndex={0}
      />
      
      {errorMessage && (
        <div className="absolute top-0 left-0 right-0 p-4 bg-red-100 text-red-800 rounded-md">
          {errorMessage}
        </div>
      )}
      
      <div className="absolute bottom-2 right-2 flex space-x-2">
        <button 
          onClick={toggleGrid}
          className="px-2 py-1 bg-white border rounded-md text-sm shadow-sm"
        >
          {showGrid ? 'Hide Grid' : 'Show Grid'}
        </button>
        
        <button 
          onClick={toggleSlicePlanes}
          className="px-2 py-1 bg-white border rounded-md text-sm shadow-sm"
        >
          {showSlicePlanes ? 'Hide Slices' : 'Show Slices'}
        </button>
        
        {layers.length > 0 && (
          <button 
            onClick={toggleAllSlices}
            className="px-2 py-1 bg-white border rounded-md text-sm shadow-sm"
          >
            {showAllSlices ? 'Show Active Slice Only' : 'Show All Slices'}
          </button>
        )}
      </div>
      
      {/* Layer information display */}
      {layers.length > 0 && showSlicePlanes && (
        <div className="absolute top-2 left-2 bg-white/75 px-2 py-1 text-xs rounded shadow z-20">
          Layer: {activeLayerIndex + 1}/{layers.length} 
          {layers[activeLayerIndex] && ` — Height: ${layers[activeLayerIndex].z.toFixed(2)}mm`}
        </div>
      )}
    </div>
  );
}

export { StlViewer3D }; 