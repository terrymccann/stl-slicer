import { StlSlicer } from '../utils/StlSlicer';
import type { Axis } from '../utils/StlSlicer';

export interface SlicerWorkerRequest {
  positionArray: Float32Array;
  indexArray: Uint32Array;
  boundingBoxMin: [number, number, number];
  boundingBoxMax: [number, number, number];
  axis: Axis;
  layerThickness: number;
  sliceId: number;
}

export interface SlicerWorkerProgress {
  type: 'progress';
  sliceId: number;
  percent: number;
}

export interface SlicerWorkerResult {
  type: 'result';
  sliceId: number;
  layers: Array<{
    index: number;
    paths: Array<Array<{ x: number; y: number }>>;
    z: number;
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
  }>;
}

export interface SlicerWorkerError {
  type: 'error';
  sliceId: number;
  message: string;
}

export type SlicerWorkerMessage = SlicerWorkerProgress | SlicerWorkerResult | SlicerWorkerError;

self.onmessage = (event: MessageEvent<SlicerWorkerRequest>) => {
  const { positionArray, indexArray, boundingBoxMin, boundingBoxMax, axis, layerThickness, sliceId } = event.data;

  try {
    const slicer = new StlSlicer();
    slicer.loadFromBuffers(positionArray, indexArray, boundingBoxMin, boundingBoxMax);

    const layers = slicer.sliceModel(axis, layerThickness, (percent) => {
      self.postMessage({ type: 'progress', sliceId, percent } satisfies SlicerWorkerProgress);
    });

    // Serialize Vector2 paths to plain objects
    const serializedLayers = layers.map((layer) => ({
      index: layer.index,
      z: layer.z,
      bounds: layer.bounds,
      paths: layer.paths.map((path) => path.map((pt) => ({ x: pt.x, y: pt.y }))),
    }));

    self.postMessage({ type: 'result', sliceId, layers: serializedLayers } satisfies SlicerWorkerResult);
  } catch (err) {
    self.postMessage({
      type: 'error',
      sliceId,
      message: err instanceof Error ? err.message : 'Unknown slicing error',
    } satisfies SlicerWorkerError);
  }
};
