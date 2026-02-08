# TASKS.md — STL Slicer Modernization

## Phase 1: Bug Fixes

### Task 1.1: Fix SVG viewport distortion and add cached 2D bounds

**Problem:**
`src/utils/StlSlicer.ts` lines 674-675 use `Math.max(size.x, size.y)` for BOTH width and height. A 100mm x 50mm model produces a 100x100mm SVG, distorting the output and making it unusable for laser cutting.

```typescript
// Current (broken):
const width = Math.ceil(Math.max(size.x, size.y));
const height = Math.ceil(Math.max(size.x, size.y));
```

Additionally, the 2D bounding box of layer paths is computed three separate times:
1. `handleFitToView` in `StlSlicer.tsx` (lines 124-142) — iterates all points to find minX/maxX/minY/maxY
2. Drawing effect in `StlSlicer.tsx` (lines 300-312) — identical iteration for the same bounds
3. `generateSVG` in `StlSlicer.ts` (lines 671-675) — uses the 3D bounding box max instead, which is wrong

All three use the same duplicated pattern:
```typescript
let minX = Number.MAX_VALUE;
let maxX = Number.MIN_VALUE;
// ... iterate all points ...
```

These problems are the same root issue: the code lacks a single correct source of 2D bounds per layer.

**What to change:**
- Create a utility function `computePathBounds(paths: Vector2[][]): { minX, maxX, minY, maxY }`.
- Cache the result on the `LayerData` object as a `bounds` property (compute once during `sliceModel()` when each layer is created).
- In `generateSVG`: use cached 2D bounds to set correct width/height for the slicing axis. When slicing along Z, width = boundsWidth, height = boundsHeight. Along X, width = size.y, height = size.z. Along Y, width = size.x, height = size.z.
- Add the `axis` parameter to `generateSVG`'s signature (currently it has no way to know the slicing axis).
- Fix the viewBox and translate transform to properly center geometry within the SVG using the cached bounds.
- Replace the duplicated min/max iterations in `handleFitToView` and the drawing effect with reads from `layer.bounds`.

**Files:**
- `src/utils/StlSlicer.ts` — `LayerData` type (lines 5-9), `sliceModel()` (line 164), `generateSVG()` method (lines 666-727)
- `src/components/StlSlicer.tsx` — `handleFitToView` (lines 124-142), drawing effect (lines 300-312), `generateSVG` call site (line 220)

**Acceptance criteria:**
- [ ] `LayerData` includes a `bounds` property with `{ minX, maxX, minY, maxY }`
- [ ] Bounds are computed once per layer during slicing and cached
- [ ] The duplicated min/max iteration pattern does not appear in any component
- [ ] `generateSVG` accepts an `axis` parameter and uses cached 2D bounds
- [ ] SVG width/height reflect the correct 2D projection dimensions for the given axis
- [ ] A rectangular model (e.g. 100x50mm) produces an SVG with matching aspect ratio
- [ ] SVG viewBox correctly frames the geometry with no clipping or excessive whitespace
- [ ] Exported SVGs render correctly when opened in a browser or Inkscape

---

### Task 1.2: Make tolerance scale-aware relative to model size

**Problem:**
`src/utils/StlSlicer.ts` line 326 uses a hardcoded `TOLERANCE = 0.01`. This value is used for:
- Point deduplication via `getPointKey()` (line 329-331)
- Zero-length segment filtering (line 307, threshold `0.0001`)
- Path closure detection (lines 432, 538, 637)
- Fallback algorithm neighbor search radius (line 600, threshold `TOLERANCE * 10`)

These fixed values break at different model scales:
- A 1000mm model: 0.01 is too strict, points that should merge don't
- A 0.1mm model: 0.01 is too loose, unrelated points get merged together

**What to change:**
- Compute tolerance as a fraction of the bounding box diagonal (e.g. `diagonal * 1e-5` for point dedup, `diagonal * 1e-6` for zero-length filtering).
- Pass the bounding box into `buildPaths()` or compute it from the segments.
- Replace all hardcoded threshold values (`0.01`, `0.0001`, `0.5`, `TOLERANCE * 10`) with scale-derived constants.
- The minimum path length check at line 430 (`length > 0.5`) must also scale — a 0.1mm model has valid paths far shorter than 0.5 units.

**Files:**
- `src/utils/StlSlicer.ts` — `buildPaths()` method (lines 284-642), `createSlice()` method

**Acceptance criteria:**
- [ ] Tolerance values are derived from the model's bounding box diagonal
- [ ] No hardcoded numeric thresholds remain in the path building code
- [ ] A 0.1mm model produces correct paths (no feature collapse)
- [ ] A 1000mm model produces correct paths (no disconnected segments that should be joined)
- [ ] Minimum path length threshold scales with model size

---

### Task 1.3: Fix fallback path algorithm bridging disconnected parts

**Problem:**
`src/utils/StlSlicer.ts` lines 562-625: when the primary and secondary path-building algorithms fail, the fallback uses a greedy nearest-neighbor approach that connects ANY points within `TOLERANCE * 10` distance. This silently merges separate objects that happen to be at the same Z-height into a single contour.

```typescript
// Current fallback (line 595-603):
for (let i = 0; i < allPoints.length; i++) {
  if (usedIndices.has(i)) continue;
  const dist = currentPoint.distanceTo(allPoints[i]);
  if (dist < closestDist && dist < TOLERANCE * 10) {
    closestDist = dist;
    closestIdx = i;
  }
}
```

**What to change:**
- Replace the greedy nearest-neighbor fallback with a segment-aware approach: instead of treating all points as a flat pool, preserve the original segment pairing so point A of segment N connects to point B of segment N, then find the closest segment endpoint to continue.
- Multiple disconnected components at the same Z should produce separate paths, not one merged contour.
- Consider removing this fallback entirely once `three-mesh-bvh` integration (Task 2.1) provides clean segment data.

**Files:**
- `src/utils/StlSlicer.ts` — fallback section of `buildPaths()` (lines 562-625)

**Acceptance criteria:**
- [ ] Two separate objects at the same Z-height produce two separate contour paths
- [ ] Segment pairing from the triangle intersection is preserved through the fallback
- [ ] No false bridges are created between geometrically disconnected regions
- [ ] Fallback still handles the case where primary algorithms partially fail

---

### Task 1.4: Fix path builder skipping non-degree-2 nodes

**Problem:**
`src/utils/StlSlicer.ts` line 373: the first-pass contour detection only considers nodes with exactly 2 connections. Nodes with degree 1 (open path endpoints from non-manifold geometry) and degree 3+ (T-junctions, branching points) are silently skipped. This causes geometry to be lost.

```typescript
// Current (line 373):
if (nodes[startIdx].connections.size !== 2) continue;
```

The second pass (`handleRemainingSegments`, lines 452-556) tries to recover these nodes but has its own issues: the forward/backward extension shares a single `visited` set, preventing the backward pass from finding valid connections that were already visited in the forward direction.

**What to change:**
- First pass: allow degree-1 nodes as path start points (they are natural endpoints of open paths).
- First pass: at degree-3+ nodes, choose the connection that continues most "straight" (smallest turning angle) to avoid jumping to a wrong branch.
- Second pass: use separate visited sets for forward and backward extension, merging only after both complete.
- Track open vs. closed paths explicitly — don't force-close open paths (line 637) as this creates false edges.

**Files:**
- `src/utils/StlSlicer.ts` — `findClosedContours()` (lines 366-446) and `handleRemainingSegments()` (lines 452-556), final cleanup (lines 629-642)

**Acceptance criteria:**
- [ ] Nodes with degree 1 are used as path starting points
- [ ] Degree-3+ junctions are handled without losing geometry
- [ ] Forward/backward path extension don't conflict via shared visited set
- [ ] Open paths (from non-manifold geometry) are preserved as open, not force-closed
- [ ] No geometry loss compared to the raw intersection segments

---

### Task 1.5: Remove debug logging and debug rendering

**Problem:**
Production code contains 18+ `console.log` calls in `StlViewer3D.tsx` and 10+ in `StlSlicer.ts`. The 2D canvas renderer in `StlSlicer.tsx` draws debug overlays (crosshairs at lines 346-353, red bounding box at lines 368-370, debug text with internal values at lines 395-412).

**What to change:**
- Remove all `console.log` and `console.warn` calls from `StlViewer3D.tsx` (lines 78, 130, 134, 206, 243, 259, 305, 370, 403-404, 432).
- Remove all `console.log` and `console.warn` calls from `StlSlicer.ts` (lines 63, 69, 110, 191, 208, 273, 286, 290, 361, 456, 564, 627).
- Remove the pointerdown debug listener in `StlViewer3D.tsx` lines 132-135.
- Remove the canvas crosshair drawing (lines 346-353 in `StlSlicer.tsx`).
- Remove the red debug bounding box (lines 368-370 in `StlSlicer.tsx`).
- Remove the debug text overlay showing scale/canvas internals (lines 404-412 in `StlSlicer.tsx`). Keep only the layer info text (lines 399-402).
- Remove the unused `hasAutoFit` state variable (`StlSlicer.tsx` lines 35, 76, 186) — it is set but never read.

**Files:**
- `src/components/StlViewer3D.tsx`
- `src/utils/StlSlicer.ts`
- `src/components/StlSlicer.tsx`

**Acceptance criteria:**
- [ ] Zero `console.log` / `console.warn` calls in production source files (outside of actual error handlers)
- [ ] No debug visual overlays on the 2D canvas (no crosshairs, no red bounding box, no scale/canvas text)
- [ ] Layer info text (layer number, height, path count) is still displayed
- [ ] `hasAutoFit` state and all references to it are removed
- [ ] No functional regressions — app still loads, slices, and renders correctly

---

### Task 1.6: Fix Three.js memory leaks on file reload

**Problem:**
`src/components/StlViewer3D.tsx` lines 261-273 clean up model meshes when loading a new STL, but slice plane objects accumulate in the scene across file loads. The `renderSlicePlanes` function (lines 337-345) removes planes tagged with `isSlicePlane`, but planes marked with `isSliceVisual` (from toggle functions at lines 51, 63) use a different tag and are never cleaned up.

Additionally, geometry is cloned per slice plane at line 442 (`planeGeometry.clone()`) but the original `planeGeometry` created at lines 378-388 is never disposed.

**What to change:**
- Unify slice visual tags — use a single `userData` flag (e.g. `isSlicePlane`) consistently.
- Dispose the base `planeGeometry` after creating all clones, or better: use `THREE.InstancedMesh` for slice planes to avoid per-plane geometry allocation.
- When loading a new STL file (lines 258-326), explicitly remove and dispose ALL slice planes before loading.
- Add proper material disposal for slice plane materials.

**Files:**
- `src/components/StlViewer3D.tsx` — `renderSlicePlanes()` (lines 332-462), STL loading effect (lines 248-329), toggle functions (lines 46-71)

**Acceptance criteria:**
- [ ] Loading a second STL file removes all previous slice planes from the scene
- [ ] No geometry or material objects leak between file loads
- [ ] Slice plane userData tags are consistent across render and toggle functions
- [ ] Base plane geometry is properly disposed after cloning
- [ ] Memory usage (tracked via browser DevTools) does not grow on repeated file loads

---

### Task 1.7: Fix race condition in axis change re-slicing

**Problem:**
`src/components/StlSlicer.tsx` lines 81-92: `handleAxisChange` uses `setTimeout(..., 50)` to trigger re-slicing. Rapid axis changes (e.g. clicking X then Y quickly) will queue multiple slicing operations that run concurrently and overwrite each other's results unpredictably.

```typescript
// Current (line 81-92):
setTimeout(async () => {
  try {
    const slicedLayers = slicerRef.current!.sliceModel(newAxis, layerThickness);
    setLayers(slicedLayers);
    // ...
  }
}, 50);
```

**What to change:**
- Remove the `setTimeout` wrapper.
- Use a ref to track whether a slice operation is in progress. If a new axis change arrives while slicing, cancel/ignore the previous result.
- Alternatively, debounce the slicing operation properly (not with a fixed 50ms timeout) and check that the axis hasn't changed since the operation started before applying results.
- The same pattern should be applied to `handleSlice` (line 195, uses `setTimeout(..., 100)` for auto-fit).

**Files:**
- `src/components/StlSlicer.tsx` — `handleAxisChange` (lines 74-94), `handleSlice` (lines 177-207)

**Acceptance criteria:**
- [ ] No `setTimeout` used for triggering slicing operations
- [ ] Rapid axis changes don't produce stale/incorrect results
- [ ] Only the most recent axis selection's results are displayed
- [ ] UI correctly shows loading state during slicing and clears it when done

---

### Task 1.8: Fix export button disabled state

**Problem:**
`src/components/ui/Sidebar.tsx` line 141: the "Export SVG Layers" button is disabled only when `!file`:
```typescript
<Button
  onClick={onExport}
  disabled={!file}  // Missing check for layers
>
```
This means a user can click "Export" immediately after loading a file but before slicing. The handler in `StlSlicer.tsx` (line 212) does check `layers.length === 0` and sets an error, but the button shouldn't be clickable in the first place.

**What to change:**
- Pass `hasLayers: boolean` (or `layers.length`) to Sidebar so it can disable the export button when there are no sliced layers.
- Disable the button with: `disabled={!file || !hasLayers}`.

**Files:**
- `src/components/ui/Sidebar.tsx` — `SidebarProps` interface (line 9), export button (line 139-146)
- `src/components/StlSlicer.tsx` — pass layers info to Sidebar (line 426)

**Acceptance criteria:**
- [ ] Export button is disabled when no layers have been sliced
- [ ] Export button is disabled when no file is loaded
- [ ] Export button is enabled only when both a file is loaded AND layers exist
- [ ] No error message appears from clicking export before slicing

---

### Task 1.9: Fix triangle-plane intersection precision

**Problem:**
`src/utils/StlSlicer.ts` `checkEdge()` (lines 240-261) has precision issues:
1. Line 255: `Math.abs()` wrapping the interpolation parameter `t` — semantically wrong (works by coincidence due to the boundary check ensuring the sign is always correct, but fragile and confusing).
2. No bounds check on `t` — if floating-point error puts `t` slightly outside [0,1], `lerpVectors` extrapolates beyond the edge, producing points outside the triangle.
3. Plane-touching-vertex case: when the plane passes exactly through a vertex, two edges sharing that vertex both report the intersection, producing 3 intersection points. The `if (intersectionPoints.length === 2)` filter at line 269 then discards the entire triangle, losing geometry.

**What to change:**
- Remove `Math.abs()` from the `t` calculation — the formula `(position - a) / (b - a)` already produces correct values when the boundary check guarantees the edge crosses the plane.
- Add bounds clamping: `t = Math.max(0, Math.min(1, t))`.
- Handle the vertex-touching case: if 3 intersection points are found, deduplicate points that are within tolerance and use the resulting 2 unique points as the segment.
- Guard division by zero explicitly (`if (Math.abs(b - a) < epsilon) continue`) instead of relying on `isFinite()`.

**Note:** When Task 2.1 (BVH integration) is implemented, the intersection logic will be carried forward into the new `BVHSlicer.ts`. Fixing it here first ensures correctness regardless of the acceleration structure.

**Files:**
- `src/utils/StlSlicer.ts` — `checkEdge()` function inside `createSlice()` (lines 240-261), intersection filtering (line 269)

**Acceptance criteria:**
- [ ] `Math.abs()` removed from interpolation parameter calculation
- [ ] `t` is clamped to [0, 1] before interpolation
- [ ] Division-by-zero is caught with explicit epsilon check
- [ ] Plane-through-vertex case produces valid segments instead of being discarded
- [ ] Edge case test: slicing a cube exactly at a vertex height produces correct contours

---

## Phase 2: Integrate `three-mesh-bvh` for BVH-Accelerated Slicing

### Task 2.1: Install `three-mesh-bvh` and create BVH-accelerated slicer

**Problem:**
The current slicing algorithm in `src/utils/StlSlicer.ts` `createSlice()` (lines 177-279) checks EVERY triangle against each slice plane — O(T × L) where T = triangle count and L = layer count. For 100 layers on a 100K-triangle model, that's 10 million intersection checks. This is the primary performance bottleneck.

**What to build:**
A new slicing engine that uses `three-mesh-bvh`'s BVH (Bounding Volume Hierarchy) to accelerate cross-section extraction. The library provides:
- `MeshBVH` — builds a BVH from BufferGeometry
- `shapecast()` — traverses only BVH nodes that intersect a given volume/plane
- Clipped edges API — extracts edge contours along clip planes

The new engine replaces `createSlice()` entirely. Instead of iterating all triangles, BVH shapecast skips entire subtrees of triangles that don't intersect the plane, reducing complexity to approximately O(T^(2/3) × L).

**Implementation plan:**
1. Install `three-mesh-bvh` via npm.
2. Create a new file `src/utils/BVHSlicer.ts` that:
   - Accepts a `THREE.BufferGeometry` and builds a `MeshBVH`
   - Exposes a `sliceAtPlane(position, axis)` method that uses `shapecast` to find only triangles intersecting the plane
   - Extracts intersection line segments from those triangles (carrying forward the precision fixes from Task 1.9)
   - Returns the raw 2D segments for downstream path building
3. Update `StlSlicer.ts` to use `BVHSlicer` instead of the naive triangle loop in `createSlice()`.
4. Keep the existing `buildPaths()` for now (it will be replaced by Clipper2 in Phase 3).

**Files:**
- NEW: `src/utils/BVHSlicer.ts`
- `src/utils/StlSlicer.ts` — `loadSTL()` (add BVH construction), `createSlice()` (replace triangle loop), `sliceModel()` (pass BVH)
- `package.json` — add `three-mesh-bvh` dependency

**Acceptance criteria:**
- [ ] `three-mesh-bvh` is installed and imported without build errors
- [ ] BVH is constructed once during `loadSTL()`, not per-slice
- [ ] `createSlice()` uses BVH shapecast instead of iterating all triangles
- [ ] Slicing produces identical geometric results as the old algorithm (same intersection segments)
- [ ] Performance improvement is measurable: slicing a 50K+ triangle model is at least 3x faster (measure with `performance.now()` in dev console)
- [ ] No regressions in path building or SVG output

---

### Task 2.2: Move slicing to a Web Worker

**Problem:**
Slicing runs on the main thread (`src/components/StlSlicer.tsx` line 189: `slicerRef.current.sliceModel(axis, layerThickness)`), blocking the UI during computation. For large models this freezes the entire page — the "Slicing..." text at the button (Sidebar.tsx line 128) never actually renders because the main thread is blocked.

**What to build:**
A Web Worker that runs the slicing computation off the main thread, with progress reporting back to the UI.

**Implementation plan:**
1. Create `src/workers/slicerWorker.ts` — a Web Worker that:
   - Receives a serialized geometry (position array, index array) and slicing parameters
   - Constructs BVH and runs `sliceModel()`
   - Posts progress updates (% complete, current layer) back to main thread
   - Posts final `LayerData[]` result back to main thread
2. Create `src/utils/slicerWorkerClient.ts` — a wrapper that:
   - Serializes geometry data for transfer (using `Transferable` for zero-copy)
   - Instantiates the worker
   - Returns a Promise that resolves with `LayerData[]`
   - Exposes an `onProgress` callback
3. Update `StlSlicer.tsx` to use the worker client instead of direct `sliceModel()` call.
4. Add a progress bar or percentage indicator to replace the simple "Slicing..." text.

**Depends on:** Task 2.1 (BVH slicer should be in place before moving to worker).

**Files:**
- NEW: `src/workers/slicerWorker.ts`
- NEW: `src/utils/slicerWorkerClient.ts`
- `src/components/StlSlicer.tsx` — `handleSlice()` (lines 177-207), `handleAxisChange()` (lines 74-94)
- `src/components/ui/Sidebar.tsx` — slicing button area (lines 122-133), add progress display
- `next.config.js` — may need webpack config for worker bundling

**Acceptance criteria:**
- [ ] Slicing runs entirely off the main thread
- [ ] UI remains responsive during slicing (can scroll, interact with other elements)
- [ ] Progress percentage is displayed during slicing
- [ ] Worker is properly terminated when component unmounts or a new slice is started
- [ ] Geometry data is transferred (not copied) to the worker using Transferable
- [ ] Results are identical to main-thread slicing

---

## Phase 3: Integrate Clipper2 for Polygon Operations (Future)

### Task 3.1: Replace custom path builder with Clipper2 polygon operations

**Problem:**
The entire `buildPaths()` method in `src/utils/StlSlicer.ts` (lines 284-642, ~360 lines) is a custom graph-based path finder with multiple failure modes (Tasks 1.2, 1.3, 1.4). It doesn't detect contour nesting (outer shells vs. holes), doesn't determine winding order, and can't perform polygon boolean operations.

**What to build:**
Replace `buildPaths()` with Clipper2-based polygon processing. Clipper2 (`clipper2-wasm` or `@countertype/clipper2-ts`) provides:
- Union of overlapping segments into clean polygons
- Polygon tree output that identifies outer contours and holes
- Correct winding order (CCW for outers, CW for holes)
- Tolerance-aware point merging with integer-based math (no float errors)

**Implementation plan:**
1. Install Clipper2 (prefer `@countertype/clipper2-ts` for simpler integration — no WASM loading).
2. Create `src/utils/ContourBuilder.ts` that:
   - Takes raw 2D segments from the BVH slicer
   - Joins segments into closed polygons (union operation)
   - Returns a polygon tree with outer/hole classification
3. Update `LayerData` type to include nesting information (which paths are holes of which outer contours).
4. Remove `buildPaths()` from `StlSlicer.ts`.

**Files:**
- NEW: `src/utils/ContourBuilder.ts`
- `src/utils/StlSlicer.ts` — remove `buildPaths()` (lines 284-642), update `createSlice()` return
- `src/utils/StlSlicer.ts` — update `LayerData` type (lines 5-9)
- `package.json` — add clipper2 dependency

**Acceptance criteria:**
- [ ] Clipper2 is installed and functional
- [ ] Raw segments are joined into clean closed polygons
- [ ] Outer contours and holes are correctly identified and labeled
- [ ] Winding order is consistent (CCW outer, CW holes)
- [ ] The 360-line `buildPaths()` method is fully replaced
- [ ] Models with holes (e.g. a tube) correctly show inner and outer contours

---

## Phase 4: SVG and Export Improvements (Future)

### Task 4.1: Fix SVG generation with proper coordinate system and fill-rule

**Problem:**
`src/utils/StlSlicer.ts` `generateSVG()` (lines 666-727):
- viewBox centering assumes geometry is origin-centered (line 696: `translate(${width/2}, ${height/2})`), but many STL files have geometry offset from the origin.
- All paths use `fill="none"` (line 710) — no distinction between solid regions and holes.
- No `fill-rule` attribute — nested contours won't render correctly.
- SVG units assume 1 STL unit = 1mm with no conversion option.

**Depends on:** Task 3.1 (Clipper2 provides hole detection and winding order needed for fill-rule).

**What to change:**
- Use the cached 2D bounds from Task 1.1 to set the viewBox, framing actual geometry with padding.
- Use `fill-rule="evenodd"` for proper rendering of nested contours.
- Outer contours: `fill="black"` or a user-configurable color. Holes: rendered as cutouts via fill-rule.
- Add optional unit scaling (mm, inches, pixels).

**Files:**
- `src/utils/StlSlicer.ts` — `generateSVG()` (lines 666-727)

**Acceptance criteria:**
- [ ] SVG viewBox correctly frames the actual geometry bounds regardless of model origin
- [ ] Nested contours (holes) render correctly with evenodd fill-rule
- [ ] Exported SVGs are dimensionally accurate when printed at 100% scale
- [ ] Unit metadata is embedded in SVG for CAM software compatibility

---

### Task 4.2: Add SVG optimization with SVGO

**Problem:**
Generated SVGs contain redundant precision, no path optimization, and verbose formatting. For a model with thousands of path points, SVGs are larger than necessary.

**What to build:**
Post-process generated SVGs with `svgo` before export.

**Files:**
- `src/utils/exportUtils.ts` — add SVGO optimization step before zipping
- `package.json` — add `svgo` dependency

**Acceptance criteria:**
- [ ] SVGO is applied to every SVG before export
- [ ] Output SVGs are visually identical to unoptimized versions
- [ ] File size is reduced (typically 20-60% smaller)
- [ ] SVGO config preserves dimensional attributes (width, height, viewBox)

---

### Task 4.3: Add DXF export format

**Problem:**
SVG is not the standard format for laser cutting workflows. Most laser cutter software (LightBurn, LaserGRBL, RDWorks) natively imports DXF. Users currently have to convert SVG to DXF externally.

**What to build:**
A DXF exporter that converts layer paths to DXF POLYLINE entities.

**Files:**
- NEW: `src/utils/dxfExporter.ts`
- `src/utils/exportUtils.ts` — add DXF export function alongside SVG
- `src/components/ui/Sidebar.tsx` — add export format selector (SVG / DXF / Both)

**Acceptance criteria:**
- [ ] DXF files open correctly in AutoCAD, LibreCAD, and LightBurn
- [ ] Polyline coordinates match SVG output (same geometry)
- [ ] DXF includes proper header with units specification
- [ ] Export button offers format selection
- [ ] ZIP export can contain DXF files, SVG files, or both

---

## Phase 5: Architecture & Code Quality

Tasks in this phase are ordered by dependency — later tasks build on earlier ones.

### Task 5.1: Decompose StlSlicer.ts utility class into single-responsibility modules

**Problem:**
`src/utils/StlSlicer.ts` is a 727-line class that mixes four distinct responsibilities:
1. STL file loading and parsing (lines 21-74)
2. Slicing algorithm — plane generation and triangle intersection (lines 95-279)
3. Path building — graph construction and contour detection (lines 284-642)
4. SVG generation (lines 666-727)

The class also holds mutable state (`geometry`, `mesh`, `boundingBox`) making it hard to test individual operations or swap implementations (e.g. when adding BVH in Task 2.1).

**What to change:**
Decompose into focused modules:
1. **`src/utils/stlLoader.ts`** — `loadSTL(file: File): Promise<THREE.BufferGeometry>`. Pure function, returns geometry. Remove the unused `mesh` and `material` creation (lines 52-54) since the mesh is never used by the slicer.
2. **`src/utils/slicingEngine.ts`** — `sliceGeometry(geometry, axis, thickness): LayerData[]`. Takes geometry and parameters, returns results. No class state needed.
3. **`src/utils/svgGenerator.ts`** — `generateSVG(layer, axis, boundingBox): string`. Pure function.

**Note:** `buildPaths()` is NOT extracted into its own module — it will be entirely replaced by Clipper2 in Task 3.1. It stays inline in `slicingEngine.ts` until then to avoid creating a module that gets immediately deleted.

The existing `StlSlicer` class becomes a thin facade that imports and composes these modules, maintaining backward compatibility with current call sites.

**Files:**
- `src/utils/StlSlicer.ts` — decompose (full file, 727 lines)
- NEW: `src/utils/stlLoader.ts`
- NEW: `src/utils/slicingEngine.ts`
- NEW: `src/utils/svgGenerator.ts`

**Acceptance criteria:**
- [ ] Each module is a pure function or set of pure functions (no class state)
- [ ] The unused `mesh` and `MeshBasicMaterial` creation is removed
- [ ] Redundant index-creation code (duplicated at lines 33-43, 109-115, 189-202) exists only once
- [ ] `buildPaths()` remains inline (not extracted) — it will be replaced in Phase 3
- [ ] `StlSlicer` class still works as a facade for existing call sites
- [ ] Each module can be unit tested independently
- [ ] No module exceeds 200 lines

---

### Task 5.2: Introduce centralized state management

**Problem:**
`src/components/StlSlicer.tsx` holds 13 individual `useState` calls (lines 24-35) and passes them as 13 individual props to `Sidebar` (lines 426-438). Every new feature (progress bar, export format selector, measurement tools) requires adding more props drilled through multiple levels.

The `Sidebar` component (`src/components/ui/Sidebar.tsx` lines 9-22) has an 11-field `SidebarProps` interface that must be updated whenever state changes. This prop drilling makes refactoring and testing difficult.

**Why this comes before Task 5.3 (split components):** Splitting components is much easier when they can consume shared state from context instead of needing extensive prop interfaces designed upfront.

**What to change:**
Introduce a React Context + `useReducer` pattern (or a lightweight store like Zustand) to manage slicer state:

1. Create `src/context/SlicerContext.tsx` with:
   - **State**: `file`, `geometry`, `dimensions`, `axis`, `layerThickness`, `isSlicing`, `layers`, `previewLayerIndex`, `error`, `viewMode`, `zoomLevel`
   - **Actions**: `SET_FILE`, `SET_AXIS`, `SET_LAYERS`, `SET_PREVIEW_INDEX`, `SET_ERROR`, `SLICE_START`, `SLICE_COMPLETE`, etc.
   - **Derived state**: `currentLayer` (computed from `layers` + `previewLayerIndex`), `hasLayers`, `canExport`
2. Wrap the app in `SlicerProvider`.
3. Update `Sidebar`, `StlViewer3D` to consume context directly instead of receiving props.

**Files:**
- NEW: `src/context/SlicerContext.tsx`
- `src/components/StlSlicer.tsx` — remove useState calls, use context
- `src/components/ui/Sidebar.tsx` — consume context instead of props
- `src/components/StlViewer3D.tsx` — consume context instead of props

**Acceptance criteria:**
- [ ] All slicer state is managed through a single context/store
- [ ] `Sidebar` reads state and dispatches actions from context — no props passed from parent
- [ ] `StlViewer3D` reads layers, axis, activeLayerIndex from context — no props
- [ ] Adding new state (e.g. export format, progress) requires only updating the context, not prop threading
- [ ] Derived values (`canExport`, `currentLayer`) are computed in one place
- [ ] No functional regressions

---

### Task 5.3: Split monolithic StlSlicer.tsx into focused components

**Problem:**
`src/components/StlSlicer.tsx` is 579 lines and owns everything: 13 `useState` calls (lines 24-35), file handling, slicing orchestration, 2D canvas rendering (lines 272-414), zoom logic (lines 102-174), layer navigation UI (lines 542-576), and export coordination. This makes the component hard to reason about, test, or extend.

**Depends on:** Task 5.2 (centralized state). With context in place, extracted components consume state directly instead of needing prop interfaces.

**What to change:**
Extract the following into standalone components:
1. **`LayerCanvas2D.tsx`** — Extract the 2D canvas rendering effect (lines 272-414) and zoom controls (lines 491-526) into a self-contained component. It reads `currentLayer` from context and handles its own canvas sizing. This removes ~200 lines from StlSlicer.tsx.
2. **`LayerNavigator.tsx`** — Extract the layer navigation bar (lines 542-576: Previous/Next buttons and range slider). Reads `layers` and `previewLayerIndex` from context, dispatches `SET_PREVIEW_INDEX`.
3. **`ViewPanel.tsx`** — Extract the main content area (lines 450-539) that switches between 3D and 2D views. Reads `viewMode` from context.

After extraction, `StlSlicer.tsx` should only contain slicing orchestration and component composition — roughly 150-200 lines.

**Files:**
- `src/components/StlSlicer.tsx` — extract from (full file)
- NEW: `src/components/LayerCanvas2D.tsx`
- NEW: `src/components/LayerNavigator.tsx`
- NEW: `src/components/ViewPanel.tsx`

**Acceptance criteria:**
- [ ] `StlSlicer.tsx` is under 200 lines
- [ ] `LayerCanvas2D` owns its own canvas ref, zoom state, and resize observer
- [ ] `LayerNavigator` is a pure presentational component
- [ ] All extracted components consume state from context (no prop drilling)
- [ ] No functionality regressions — 2D rendering, zoom, layer navigation all work identically
- [ ] Each extracted component can be understood in isolation

---

### Task 5.4: Eliminate duplicate STL parsing between slicer and 3D viewer

**Problem:**
The STL file is parsed twice:
1. In `src/utils/StlSlicer.ts` `loadSTL()` (lines 21-74) — using `STLLoader` to create geometry for slicing.
2. In `src/components/StlViewer3D.tsx` (lines 275-281) — using `STLLoader` again to create geometry for 3D rendering.

Both parse the same `File` object into a `BufferGeometry`. This wastes CPU time, doubles memory usage for the geometry, and means the viewer's model can theoretically differ from the slicer's model.

**Depends on:** Task 5.2 (centralized state). With context in place, the parsed geometry is stored in state once and consumed by both the slicer and the viewer.

**What to change:**
- Parse the STL once (in the loader utility from Task 5.1, or in `StlSlicer.ts`).
- Store the parsed `BufferGeometry` in context (from Task 5.2).
- `StlViewer3D` reads geometry from context, creates its own `Mesh` (it needs its own material/transforms) but doesn't re-parse.
- Remove the `STLLoader` import and file reading code from `StlViewer3D.tsx` (lines 275-281).

**Files:**
- `src/components/StlViewer3D.tsx` — `stlFile` prop (line 10) replaced by reading geometry from context, STL loading effect (lines 248-329) simplified
- `src/context/SlicerContext.tsx` — add `geometry` to state
- `src/utils/StlSlicer.ts` — expose the parsed geometry via a getter

**Acceptance criteria:**
- [ ] STL file is parsed exactly once regardless of how many components need the geometry
- [ ] `StlViewer3D` no longer imports `STLLoader` or reads the file
- [ ] 3D viewer renders the exact same geometry that the slicer uses
- [ ] Memory usage is reduced (only one `BufferGeometry` in memory, not two)
- [ ] Loading a file is faster (single parse instead of double)

---

### Task 5.5: Add drag-and-drop file upload

**Problem:**
`src/components/ui/Sidebar.tsx` lines 50-57 use a plain `<input type="file">` for STL upload. Modern web apps support drag-and-drop file upload, which is faster and more intuitive — users expect to drag an STL file onto the viewport or a drop zone.

**What to build:**
A drop zone that accepts `.stl` files via drag-and-drop, with visual feedback (highlight border, "Drop STL file here" overlay).

**Implementation plan:**
1. Add a drop zone overlay to the main viewport area (`StlSlicer.tsx` lines 451-539) that appears when a file is dragged over the window.
2. Handle `dragenter`, `dragover`, `dragleave`, and `drop` events on the main container.
3. Validate that dropped files have `.stl` extension.
4. Reuse the existing `handleFileChange` logic (or extract the file-loading portion into a shared `loadFile(file: File)` function).
5. Keep the sidebar file input as an alternative — some users prefer the file picker dialog.

**Files:**
- `src/components/StlSlicer.tsx` — main container (line 424), add drop handlers
- `src/components/ui/Sidebar.tsx` — optionally add drop styling to file input area
- May be cleaner as a new `src/components/DropZone.tsx` component

**Acceptance criteria:**
- [ ] Dragging an STL file over the viewport shows a visual drop zone indicator
- [ ] Dropping an STL file loads it (same behavior as the file input)
- [ ] Non-STL files show an error message when dropped
- [ ] The visual indicator disappears when the drag leaves the window
- [ ] The existing file input in the sidebar still works
- [ ] Works in Chrome, Firefox, and Safari

---

### Task 5.6: Add keyboard shortcuts for layer navigation and zoom

**Problem:**
Layer navigation requires clicking small Previous/Next buttons or dragging the slider (`StlSlicer.tsx` lines 548-574). Zoom requires clicking +/- buttons (lines 491-522). No keyboard interaction is supported, making the tool slow to use when inspecting many layers.

**What to build:**
Keyboard shortcuts for common operations:

| Key | Action |
|-----|--------|
| `ArrowLeft` / `ArrowDown` | Previous layer |
| `ArrowRight` / `ArrowUp` | Next layer |
| `Home` | First layer |
| `End` | Last layer |
| `+` / `=` | Zoom in (2D view) |
| `-` | Zoom out (2D view) |
| `0` | Reset zoom |
| `F` | Fit to view |
| `Tab` | Toggle 2D/3D view |

**Implementation plan:**
1. Add a `useEffect` with a `keydown` event listener on `window` in `StlSlicer.tsx` (or the new `ViewPanel` if Task 5.3 is done).
2. Only activate shortcuts when not typing in an input field (`e.target instanceof HTMLInputElement` check).
3. Prevent default browser behavior for keys that conflict (e.g. Tab).

**Files:**
- `src/components/StlSlicer.tsx` — add keyboard event handler
- Or NEW: `src/hooks/useKeyboardShortcuts.ts` as a reusable hook

**Acceptance criteria:**
- [ ] Arrow keys navigate layers in both 2D and 3D view modes
- [ ] Home/End jump to first/last layer
- [ ] +/- zoom in 2D view
- [ ] Tab toggles view mode
- [ ] Shortcuts are disabled when typing in input fields (layer thickness, file name)
- [ ] No conflicts with browser default shortcuts
- [ ] Shortcuts are discoverable (listed in the 3D controls tooltip or a help overlay)
