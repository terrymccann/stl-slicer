import * as THREE from 'three';
import type { Axis, LayerData } from './StlSlicer';
import type { SlicerWorkerMessage, SlicerWorkerRequest } from '../workers/slicerWorker';

interface SliceWorkerHandle {
  promise: Promise<LayerData[]>;
  terminate: () => void;
}

export function sliceInWorker(
  geometry: THREE.BufferGeometry,
  boundingBox: THREE.Box3,
  axis: Axis,
  layerThickness: number,
  sliceId: number,
  onProgress?: (percent: number) => void
): SliceWorkerHandle {
  const worker = new Worker(new URL('../workers/slicerWorker.ts', import.meta.url));

  // Copy (not transfer) typed arrays — main thread still needs geometry for 3D viewer
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const positionArray = new Float32Array(posAttr.array);

  let indexArray: Uint32Array;
  const idx = geometry.getIndex();
  if (idx) {
    indexArray = new Uint32Array(idx.array);
  } else {
    // Fallback: create identity indices
    indexArray = new Uint32Array(posAttr.count);
    for (let i = 0; i < posAttr.count; i++) {
      indexArray[i] = i;
    }
  }

  const boundingBoxMin: [number, number, number] = [
    boundingBox.min.x,
    boundingBox.min.y,
    boundingBox.min.z,
  ];
  const boundingBoxMax: [number, number, number] = [
    boundingBox.max.x,
    boundingBox.max.y,
    boundingBox.max.z,
  ];

  const promise = new Promise<LayerData[]>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<SlicerWorkerMessage>) => {
      const msg = event.data;

      if (msg.sliceId !== sliceId) return;

      switch (msg.type) {
        case 'progress':
          onProgress?.(msg.percent);
          break;
        case 'result': {
          // Deserialize plain objects back to THREE.Vector2
          const layers: LayerData[] = msg.layers.map((layer) => ({
            index: layer.index,
            z: layer.z,
            bounds: layer.bounds,
            paths: layer.paths.map((path) => path.map((pt) => new THREE.Vector2(pt.x, pt.y))),
          }));
          worker.terminate();
          resolve(layers);
          break;
        }
        case 'error':
          worker.terminate();
          reject(new Error(msg.message));
          break;
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message || 'Worker error'));
    };
  });

  const request: SlicerWorkerRequest = {
    positionArray,
    indexArray,
    boundingBoxMin,
    boundingBoxMax,
    axis,
    layerThickness,
    sliceId,
  };

  worker.postMessage(request, [positionArray.buffer, indexArray.buffer]);

  return {
    promise,
    terminate: () => worker.terminate(),
  };
}
