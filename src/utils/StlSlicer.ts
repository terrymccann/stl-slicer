import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { BVHSlicer } from './BVHSlicer';

export type Axis = 'x' | 'y' | 'z';
export type PathBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};
export type LayerData = {
  index: number;
  paths: Array<Array<THREE.Vector2>>;
  z: number;
  bounds: PathBounds;
};

/**
 * Compute the 2D bounding box of a set of paths.
 */
export function computePathBounds(paths: Array<Array<THREE.Vector2>>): PathBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const path of paths) {
    for (const point of path) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }

  // If no points were found, return zero bounds
  if (minX === Infinity) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }

  return { minX, maxX, minY, maxY };
}

export class StlSlicer {
  private geometry: THREE.BufferGeometry | null = null;
  private mesh: THREE.Mesh | null = null;
  private boundingBox: THREE.Box3 | null = null;
  private bvhSlicer: BVHSlicer | null = null;

  constructor() {}

  /**
   * Load an STL file and prepare it for slicing
   */
  async loadSTL(file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const loader = new STLLoader();
      const reader = new FileReader();

      reader.onload = (event) => {
        try {
          if (event.target?.result) {
            // Parse the STL file
            const geometry = loader.parse(event.target.result as ArrayBuffer);
            
            // Ensure the geometry has indices - STLLoader doesn't always create them
            if (!geometry.index) {
              // Create an index buffer if not present
              const positionAttribute = geometry.getAttribute('position');
              if (positionAttribute) {
                const indices = [];
                for (let i = 0; i < positionAttribute.count; i++) {
                  indices.push(i);
                }
                geometry.setIndex(indices);
              }
            }
            
            // Ensure normals are computed
            if (!geometry.getAttribute('normal')) {
              geometry.computeVertexNormals();
            }
            
            this.geometry = geometry;

            // Build BVH for accelerated slicing (constructed once per model load)
            this.bvhSlicer = new BVHSlicer(geometry);

            // Create a mesh from the geometry
            const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
            this.mesh = new THREE.Mesh(geometry, material);
            
            // Compute the bounding box
            geometry.computeBoundingBox();
            this.boundingBox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3().setFromObject(this.mesh);
            
            resolve();
          }
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = (error) => {
        reject(error);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  getGeometry(): THREE.BufferGeometry | null {
    return this.geometry;
  }

  getBoundingBox(): THREE.Box3 | null {
    return this.boundingBox;
  }

  /**
   * Get the dimensions of the loaded model
   */
  getDimensions(): { width: number; height: number; depth: number } | null {
    if (!this.boundingBox) return null;
    
    const size = new THREE.Vector3();
    this.boundingBox.getSize(size);
    
    return {
      width: size.x,
      height: size.y,
      depth: size.z
    };
  }

  /**
   * Load geometry from raw typed arrays (used by Web Worker).
   */
  loadFromBuffers(
    positionArray: Float32Array,
    indexArray: Uint32Array,
    boundingBoxMin: [number, number, number],
    boundingBoxMax: [number, number, number]
  ): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
    geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
    geometry.computeVertexNormals();

    this.geometry = geometry;
    this.boundingBox = new THREE.Box3(
      new THREE.Vector3(...boundingBoxMin),
      new THREE.Vector3(...boundingBoxMax)
    );
    this.bvhSlicer = new BVHSlicer(geometry);
  }

  /**
   * Slice the STL model along the specified axis with the given layer thickness
   */
  sliceModel(axis: Axis, layerThickness: number, onProgress?: (percent: number) => void): LayerData[] {
    if (!this.geometry || !this.boundingBox) {
      throw new Error('No model loaded');
    }

    // Prepare the model for slicing
    const position = this.geometry.getAttribute('position');
    const indices = this.geometry.getIndex();
    
    if (!position) {
      throw new Error('Invalid geometry: missing position attribute');
    }

    // If no indices, we need to create them (although we should have done this in loadSTL)
    if (!indices) {
      const newIndices = [];
      for (let i = 0; i < position.count; i++) {
        newIndices.push(i);
      }
      this.geometry.setIndex(newIndices);
    }

    // Validate again after potential fix
    if (!this.geometry.getIndex()) {
      throw new Error('Failed to create geometry indices');
    }

    // Determine the slicing range based on the chosen axis
    const min = this.boundingBox.min;
    const max = this.boundingBox.max;
    
    let start: number, end: number;
    
    if (axis === 'x') {
      start = min.x;
      end = max.x;
    } else if (axis === 'y') {
      start = min.y;
      end = max.y;
    } else {
      start = min.z;
      end = max.z;
    }

    // Calculate total height and adjust for even layer distribution
    const totalHeight = end - start;
    
    // Ensure we have at least 2 layers (start and end)
    const minLayers = 2;
    
    // Calculate how many layers we need
    const calculatedLayerCount = Math.max(
      minLayers, 
      Math.ceil(totalHeight / layerThickness)
    );
    
    // Recalculate layer thickness to evenly distribute layers
    // This ensures we have slices that perfectly match the model bounds
    const adjustedLayerThickness = totalHeight / (calculatedLayerCount - 1);
    
    // Generate slice planes
    const layers: LayerData[] = [];
    
    // Create evenly distributed slices from start to end (inclusive)
    for (let i = 0; i < calculatedLayerCount; i++) {
      const z = start + (i * adjustedLayerThickness);
      const paths = this.createSlice(z, axis);

      layers.push({
        index: i,
        paths,
        z,
        bounds: computePathBounds(paths)
      });

      if (onProgress) {
        onProgress(((i + 1) / calculatedLayerCount) * 100);
      }
    }

    return layers;
  }

  /**
   * Create a slice at the specified position along the given axis.
   * Uses BVH shapecast for accelerated triangle-plane intersection.
   */
  private createSlice(position: number, axis: Axis): Array<Array<THREE.Vector2>> {
    if (!this.geometry || !this.bvhSlicer) {
      throw new Error('No model loaded');
    }

    // BVH shapecast finds only triangles that intersect the slice plane
    const intersectedEdges = this.bvhSlicer.sliceAtPlane(position, axis);

    // Compute bounding box diagonal for scale-aware tolerances
    const bbSize = new THREE.Vector3();
    this.boundingBox!.getSize(bbSize);
    const diagonal = bbSize.length();

    // Convert intersected edges into 2D paths
    return this.buildPaths(intersectedEdges, axis, diagonal);
  }

  /**
   * Convert 3D intersection points to 2D paths
   */
  private buildPaths(edges: Array<Array<THREE.Vector3>>, axis: Axis, diagonal: number): Array<Array<THREE.Vector2>> {
    if (edges.length === 0) {
      return [];
    }

    // Scale-aware tolerances derived from bounding box diagonal
    const safeDiag = Math.max(diagonal, 1e-10); // guard against degenerate models
    const TOLERANCE = safeDiag * 1e-5;           // point deduplication
    const ZERO_LENGTH_TOL = safeDiag * 1e-6;     // zero-length segment filter
    const MIN_PATH_LENGTH = safeDiag * 1e-3;     // minimum path perimeter
    const FALLBACK_RADIUS = safeDiag * 1e-4;     // fallback neighbor search radius

    // Convert 3D points to 2D based on the slicing axis
    const segments: Array<[THREE.Vector2, THREE.Vector2]> = [];

    // Process each edge and convert to 2D segment
    for (const edge of edges) {
      // Ensure the edge has exactly two points
      if (edge.length !== 2 || !edge[0] || !edge[1]) {
        continue;
      }

      const p1 = this.convertTo2D(edge[0], axis);
      const p2 = this.convertTo2D(edge[1], axis);

      // Avoid zero-length segments
      if (p1.distanceTo(p2) > ZERO_LENGTH_TOL) {
        segments.push([p1, p2]);
      }
    }

    if (segments.length === 0) {
      return [];
    }

    // Construct a graph structure for intelligent path finding
    interface Node {
      position: THREE.Vector2;
      connections: Set<number>; // Indices of connected nodes
      used: boolean; // Flag to mark if this node has been used in a path
    }

    const nodes: Node[] = [];
    const nodeMap = new Map<string, number>(); // Map point hash to index in nodes array

    // Function to get a unique key for a point (for detecting duplicates)
    const getPointKey = (point: THREE.Vector2) => {
      return `${Math.round(point.x / TOLERANCE)},${Math.round(point.y / TOLERANCE)}`;
    };
    
    // Function to get or create a node index
    const getNodeIndex = (point: THREE.Vector2): number => {
      const key = getPointKey(point);
      if (nodeMap.has(key)) {
        return nodeMap.get(key)!;
      }
      
      const index = nodes.length;
      nodes.push({
        position: point.clone(),
        connections: new Set<number>(),
        used: false
      });
      nodeMap.set(key, index);
      return index;
    };
    
    // Build the graph from segments
    for (const [p1, p2] of segments) {
      const i1 = getNodeIndex(p1);
      const i2 = getNodeIndex(p2);
      
      if (i1 !== i2) {  // Avoid self-loops
        nodes[i1].connections.add(i2);
        nodes[i2].connections.add(i1);
      }
    }
    
    const paths: Array<Array<THREE.Vector2>> = [];

    // Choose the best next node from a junction. At degree-3+ nodes, pick the
    // connection that continues most "straight" (smallest turning angle).
    const chooseBestConnection = (prevIdx: number | null, currentIdx: number, exclude: Set<number>): number | null => {
      const current = nodes[currentIdx];
      const candidates: number[] = [];
      for (const connIdx of current.connections) {
        if (exclude.has(connIdx)) continue;
        candidates.push(connIdx);
      }
      if (candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0];

      // If we have no previous direction, just pick the first candidate
      if (prevIdx === null) return candidates[0];

      // Direction we arrived from
      const prev = nodes[prevIdx].position;
      const cur = current.position;
      const inAngle = Math.atan2(cur.y - prev.y, cur.x - prev.x);

      let bestIdx: number | null = null;
      let bestAngleDiff = Infinity;

      for (const candIdx of candidates) {
        const cand = nodes[candIdx].position;
        const outAngle = Math.atan2(cand.y - cur.y, cand.x - cur.x);
        // Smallest absolute turn = most straight continuation
        let diff = Math.abs(outAngle - inAngle);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff < bestAngleDiff) {
          bestAngleDiff = diff;
          bestIdx = candIdx;
        }
      }
      return bestIdx;
    };

    // First pass: trace contours starting from degree-1 (open endpoints) and
    // degree-2 (loop) nodes. Degree-3+ junctions are traversed using the
    // turning-angle heuristic but not used as starting points in this pass.
    const findContours = () => {
      // Prefer starting from degree-1 nodes first (natural open-path endpoints),
      // then degree-2 nodes (clean loops).
      const startOrder = [...Array(nodes.length).keys()].sort((a, b) => {
        const da = nodes[a].connections.size;
        const db = nodes[b].connections.size;
        // degree-1 first, then degree-2, then the rest
        if (da === 1 && db !== 1) return -1;
        if (db === 1 && da !== 1) return 1;
        if (da === 2 && db !== 2) return -1;
        if (db === 2 && da !== 2) return 1;
        return a - b;
      });

      for (const startIdx of startOrder) {
        if (nodes[startIdx].used) continue;
        // Skip degree-3+ as starting points — they'll be traversed through
        if (nodes[startIdx].connections.size > 2) continue;

        const path: Array<THREE.Vector2> = [nodes[startIdx].position.clone()];
        const pathNodeIndices: number[] = [startIdx];
        nodes[startIdx].used = true;

        let currentIdx = startIdx;
        let prevIdx: number | null = null;
        let complete = false;
        let length = 0;

        while (!complete) {
          const usedSet = new Set<number>(pathNodeIndices);
          // At the start node, don't exclude it (so we can detect closure)
          usedSet.delete(startIdx);

          const nextIdx = chooseBestConnection(prevIdx, currentIdx, usedSet);

          if (nextIdx === null) {
            break;
          }

          // Check if we've returned to the start (closed loop)
          if (nextIdx === startIdx) {
            complete = true;
            // Add closing segment length
            length += nodes[currentIdx].position.distanceTo(nodes[startIdx].position);
            break;
          }

          prevIdx = currentIdx;
          currentIdx = nextIdx;
          path.push(nodes[currentIdx].position.clone());
          pathNodeIndices.push(currentIdx);
          nodes[currentIdx].used = true;

          if (path.length > 1) {
            length += path[path.length - 1].distanceTo(path[path.length - 2]);
          }

          // Safety check
          if (path.length > segments.length * 2) {
            break;
          }
        }

        if (path.length >= 3 && length > MIN_PATH_LENGTH) {
          if (complete) {
            // Closed loop — ensure geometric closure
            if (path[0].distanceTo(path[path.length - 1]) > TOLERANCE) {
              path.push(path[0].clone());
            }
          }
          // Open paths (degree-1 start) are kept open — no force-close
          paths.push(path);
        } else {
          // Not viable — unmark so nodes can be reused
          for (const idx of pathNodeIndices) {
            nodes[idx].used = false;
          }
        }
      }
    };

    findContours();
    
    // Second pass — handle any remaining unused nodes using separate visited
    // sets for forward and backward extension so they don't block each other.
    const handleRemainingSegments = () => {
      const remaining = nodes.filter(node => !node.used);
      if (remaining.length === 0) return;

      // Find the best unused connected node, preferring fewer connections
      const findBestNextNode = (currentIdx: number, visited: Set<number>): number | null => {
        const currentNode = nodes[currentIdx];
        let bestNextIdx: number | null = null;
        let bestScore = Infinity;

        for (const nextIdx of currentNode.connections) {
          if (visited.has(nextIdx)) continue;
          if (nodes[nextIdx].used) continue;

          const score = nodes[nextIdx].connections.size;
          if (score < bestScore) {
            bestScore = score;
            bestNextIdx = nextIdx;
          }
        }

        return bestNextIdx;
      };

      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].used) continue;

        // Forward extension — its own visited set
        const forwardVisited = new Set<number>([i]);
        const forwardPath: Array<THREE.Vector2> = [nodes[i].position.clone()];
        let fwdIdx = i;
        let length = 0;

        while (true) {
          const nextIdx = findBestNextNode(fwdIdx, forwardVisited);
          if (nextIdx === null) break;

          forwardPath.push(nodes[nextIdx].position.clone());
          forwardVisited.add(nextIdx);
          length += nodes[nextIdx].position.distanceTo(nodes[fwdIdx].position);
          fwdIdx = nextIdx;
        }

        // Backward extension — its own visited set (only shares the start node)
        const backwardVisited = new Set<number>([i]);
        const reversePath: Array<THREE.Vector2> = [];
        let bwdIdx = i;

        while (true) {
          const nextIdx = findBestNextNode(bwdIdx, backwardVisited);
          if (nextIdx === null) break;

          reversePath.unshift(nodes[nextIdx].position.clone());
          backwardVisited.add(nextIdx);
          length += nodes[nextIdx].position.distanceTo(nodes[bwdIdx].position);
          bwdIdx = nextIdx;
        }

        // Combine: reversePath + forwardPath
        const fullPath = [...reversePath, ...forwardPath];

        if (fullPath.length >= 3 && length > MIN_PATH_LENGTH) {
          // Mark all visited nodes as used
          for (const idx of forwardVisited) nodes[idx].used = true;
          for (const idx of backwardVisited) nodes[idx].used = true;

          const first = fullPath[0];
          const last = fullPath[fullPath.length - 1];

          if (first.distanceTo(last) < TOLERANCE) {
            // Already closed
            paths.push(fullPath);
          } else {
            // Check if endpoints are connected in the graph → closeable contour
            const startNodeIdx = nodeMap.get(getPointKey(first));
            const endNodeIdx = nodeMap.get(getPointKey(last));

            if (startNodeIdx !== undefined && endNodeIdx !== undefined &&
                nodes[startNodeIdx].connections.has(endNodeIdx)) {
              paths.push([...fullPath, first.clone()]);
            } else {
              // Open path — keep as-is, don't force-close
              paths.push(fullPath);
            }
          }
        }
      }
    };
    
    // Process any remaining segments
    handleRemainingSegments();
    
    // If we didn't find any paths, try a segment-aware fallback that preserves
    // original segment pairing and keeps disconnected components separate.
    if (paths.length === 0) {

      const usedSegments = new Set<number>();

      // Find the closest unused segment endpoint to a given point
      const findClosestSegment = (point: THREE.Vector2, excludeSet: Set<number>): { segIdx: number; endIdx: 0 | 1 } | null => {
        let bestSegIdx = -1;
        let bestEndIdx: 0 | 1 = 0;
        let bestDist = FALLBACK_RADIUS;

        for (let i = 0; i < segments.length; i++) {
          if (excludeSet.has(i)) continue;
          for (const endIdx of [0, 1] as const) {
            const dist = point.distanceTo(segments[i][endIdx]);
            if (dist < bestDist) {
              bestDist = dist;
              bestSegIdx = i;
              bestEndIdx = endIdx;
            }
          }
        }

        return bestSegIdx === -1 ? null : { segIdx: bestSegIdx, endIdx: bestEndIdx };
      };

      // Chain segments into paths, keeping disconnected components separate
      for (let i = 0; i < segments.length; i++) {
        if (usedSegments.has(i)) continue;

        // Start a new path with this segment
        const path: THREE.Vector2[] = [segments[i][0].clone(), segments[i][1].clone()];
        usedSegments.add(i);

        // Extend forward from the last point
        let extended = true;
        while (extended) {
          extended = false;
          const tail = path[path.length - 1];
          const match = findClosestSegment(tail, usedSegments);
          if (match) {
            usedSegments.add(match.segIdx);
            const seg = segments[match.segIdx];
            // endIdx is the matched end — walk the segment from matched end to the other end
            if (match.endIdx === 0) {
              path.push(seg[1].clone());
            } else {
              path.push(seg[0].clone());
            }
            extended = true;
          }
        }

        // Extend backward from the first point
        extended = true;
        while (extended) {
          extended = false;
          const head = path[0];
          const match = findClosestSegment(head, usedSegments);
          if (match) {
            usedSegments.add(match.segIdx);
            const seg = segments[match.segIdx];
            if (match.endIdx === 0) {
              path.unshift(seg[1].clone());
            } else {
              path.unshift(seg[0].clone());
            }
            extended = true;
          }
        }

        if (path.length >= 3) {
          paths.push(path);
        }
      }
    }
    
    // Final cleanup — only ensure geometrically-near-closed paths are fully
    // closed. Open paths from non-manifold geometry are preserved as open.
    return paths.map(path => {
      if (path.length < 3) return path;

      const first = path[0];
      const last = path[path.length - 1];
      const gap = first.distanceTo(last);

      // If the endpoints are very close (within tolerance) but not identical,
      // snap them shut. Otherwise leave the path as-is.
      if (gap > 0 && gap <= TOLERANCE) {
        return [...path, first.clone()];
      }

      return path;
    });
  }
  
  /**
   * Helper function to convert a 3D point to 2D based on slicing axis
   */
  private convertTo2D(point: THREE.Vector3, axis: Axis): THREE.Vector2 {
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number' || typeof point.z !== 'number') {
      return new THREE.Vector2(0, 0);
    }
    
    if (axis === 'x') {
      return new THREE.Vector2(point.y, point.z);
    } else if (axis === 'y') {
      return new THREE.Vector2(point.x, point.z);
    } else {
      return new THREE.Vector2(point.x, point.y);
    }
  }

  /**
   * Generate an SVG string from layer data
   */
  generateSVG(layer: LayerData, _axis: Axis = 'z'): string {
    if (!this.boundingBox) {
      throw new Error('No model loaded');
    }

    const { bounds } = layer;
    const boundsWidth = bounds.maxX - bounds.minX;
    const boundsHeight = bounds.maxY - bounds.minY;

    // Use cached 2D bounds for width/height; fall back to small defaults for empty layers
    const padding = 1; // 1mm padding around geometry
    const width = boundsWidth > 0 ? boundsWidth + padding * 2 : 10;
    const height = boundsHeight > 0 ? boundsHeight + padding * 2 : 10;

    // Check if we have any valid paths
    if (layer.paths.length === 0) {
      return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg width="${width.toFixed(3)}mm" height="${height.toFixed(3)}mm" viewBox="0 0 ${width.toFixed(3)} ${height.toFixed(3)}"
     xmlns="http://www.w3.org/2000/svg">
  <text x="${(width / 2).toFixed(3)}" y="${(height / 2).toFixed(3)}" text-anchor="middle" font-size="3" fill="red">
    No slice data at this layer (${layer.z.toFixed(2)}mm)
  </text>
</svg>`;
    }

    // viewBox origin at bounds min minus padding, so geometry is correctly framed
    const viewBoxX = bounds.minX - padding;
    const viewBoxY = bounds.minY - padding;

    // SVG header — viewBox frames the actual geometry with padding
    let svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg width="${width.toFixed(3)}mm" height="${height.toFixed(3)}mm" viewBox="${viewBoxX.toFixed(3)} ${viewBoxY.toFixed(3)} ${width.toFixed(3)} ${height.toFixed(3)}"
     xmlns="http://www.w3.org/2000/svg">
<g>`;

    // Add each path
    let pathCount = 0;
    for (const path of layer.paths) {
      if (path.length < 3) continue;

      const pathData = path.map((point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.x.toFixed(3)},${point.y.toFixed(3)}`
      ).join(' ') + 'Z';

      svg += `
  <path d="${pathData}" fill="none" stroke="black" stroke-width="0.1" />`;
      pathCount++;
    }

    if (pathCount === 0) {
      svg += `
  <text x="${((bounds.minX + bounds.maxX) / 2).toFixed(3)}" y="${((bounds.minY + bounds.maxY) / 2).toFixed(3)}" text-anchor="middle" font-size="3" fill="red">
    All paths were invalid for this layer
  </text>`;
    }

    svg += `
</g>
</svg>`;

    return svg;
  }
} 