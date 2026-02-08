import * as THREE from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';
import type { Axis } from './StlSlicer';

/**
 * BVH-accelerated slicer that uses three-mesh-bvh to efficiently find
 * triangle-plane intersections. Replaces the brute-force O(T) triangle
 * iteration with BVH shapecast that prunes entire spatial regions.
 */
export class BVHSlicer {
  private bvh: MeshBVH;
  private geometry: THREE.BufferGeometry;

  constructor(geometry: THREE.BufferGeometry) {
    this.geometry = geometry;

    // Ensure the geometry has an index buffer (required by MeshBVH)
    if (!geometry.index) {
      const positionAttribute = geometry.getAttribute('position');
      if (positionAttribute) {
        const indices: number[] = [];
        for (let i = 0; i < positionAttribute.count; i++) {
          indices.push(i);
        }
        geometry.setIndex(indices);
      }
    }

    // Build the BVH with SAH strategy for optimal tree quality.
    // Construction cost is paid once per loaded model.
    this.bvh = new MeshBVH(geometry, { strategy: SAH });
  }

  /**
   * Find all triangle-plane intersection segments at the given position
   * along the given axis. Returns raw 3D line segments.
   *
   * This carries forward the precision fixes from Task 1.9:
   * - No Math.abs on interpolation parameter
   * - t clamped to [0, 1]
   * - Explicit epsilon for division-by-zero
   * - Vertex-touching dedup (3 → 2 points)
   */
  sliceAtPlane(position: number, axis: Axis): Array<Array<THREE.Vector3>> {
    const intersectedEdges: Array<Array<THREE.Vector3>> = [];
    const posAttr = this.geometry.getAttribute('position');
    const indexAttr = this.geometry.getIndex();

    if (!posAttr || !indexAttr) return intersectedEdges;

    const EDGE_EPS = 1e-12;

    this.bvh.shapecast({
      intersectsBounds: (box: THREE.Box3) => {
        // Prune BVH nodes whose bounding box doesn't straddle the slice plane
        const axisMin = axis === 'x' ? box.min.x : axis === 'y' ? box.min.y : box.min.z;
        const axisMax = axis === 'x' ? box.max.x : axis === 'y' ? box.max.y : box.max.z;
        return axisMin <= position && axisMax >= position;
      },

      intersectsTriangle: (tri) => {
        // tri is an ExtendedTriangle with .a, .b, .c (Vector3 vertices)
        const v1 = tri.a;
        const v2 = tri.b;
        const v3 = tri.c;

        const intersectionPoints: THREE.Vector3[] = [];

        const checkEdge = (start: THREE.Vector3, end: THREE.Vector3) => {
          const a = axis === 'x' ? start.x : axis === 'y' ? start.y : start.z;
          const b = axis === 'x' ? end.x : axis === 'y' ? end.y : end.z;

          if ((a <= position && b >= position) || (a >= position && b <= position)) {
            const denom = b - a;
            if (Math.abs(denom) < EDGE_EPS) return;

            const t = Math.max(0, Math.min(1, (position - a) / denom));
            const point = new THREE.Vector3().lerpVectors(start, end, t);
            intersectionPoints.push(point);
          }
        };

        checkEdge(v1, v2);
        checkEdge(v2, v3);
        checkEdge(v3, v1);

        if (intersectionPoints.length === 2) {
          intersectedEdges.push(intersectionPoints);
        } else if (intersectionPoints.length === 3) {
          // Plane passes through a vertex — deduplicate to 2 unique points
          const deduped: THREE.Vector3[] = [intersectionPoints[0]];
          for (let j = 1; j < intersectionPoints.length; j++) {
            let isDup = false;
            for (const existing of deduped) {
              if (intersectionPoints[j].distanceTo(existing) < EDGE_EPS) {
                isDup = true;
                break;
              }
            }
            if (!isDup) deduped.push(intersectionPoints[j]);
          }
          if (deduped.length === 2) {
            intersectedEdges.push(deduped);
          }
        }

        return false; // Continue traversal — collect all intersections
      }
    });

    return intersectedEdges;
  }
}
