# Phase 5 Mini-RFCs

## RFC 5.1: Procedural Texture Graph

### Problem Statement
Current texture authoring is preset/image-driven. A procedural graph enables composable patterns, non-destructive edits, and reproducible parameterized surfaces without external bitmap tooling.

### MVP Scope
- Add a lightweight node-graph model for procedural displacement source generation.
- Support a small node set sufficient for parity-plus with current presets:
  - `InputUV`, `Noise`, `Checker`, `Voronoi`, `Blend`, `Levels`, `Transform2D`, `OutputHeight`.
- Evaluate graph to a grayscale texture buffer used by existing displacement pipeline.
- Persist graph state in app settings (session/local storage) and embed a compact graph manifest in export metadata sidecar JSON.
- Introduce a new UI panel for graph editing with:
  - Node list + parameter inspector.
  - Connection editing (single-output to single/multi-input).
  - Preset graph templates.

### Out of Scope (MVP)
- Full visual node canvas with freeform drag connections and minimap.
- Arbitrary custom shader code nodes.
- Real-time per-vertex procedural evaluation during preview draw call.
- Networked graph sharing or cloud preset marketplace.

### Data Model
```ts
// persisted in settings.proceduralGraph
interface ProceduralGraphDoc {
  version: 1;
  graphId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  outputNodeId: string;
  metadata?: {
    name?: string;
    createdAt?: string; // ISO-8601
    updatedAt?: string; // ISO-8601
  };
}

interface GraphNode {
  id: string;
  type:
    | 'InputUV'
    | 'Noise'
    | 'Checker'
    | 'Voronoi'
    | 'Blend'
    | 'Levels'
    | 'Transform2D'
    | 'OutputHeight';
  params: Record<string, number | boolean | string>;
  ui?: { x: number; y: number; collapsed?: boolean };
}

interface GraphEdge {
  fromNodeId: string;
  fromSocket: string;
  toNodeId: string;
  toSocket: string;
}
```

### Serialization Strategy
- Canonical JSON with stable key ordering at save time.
- Forward-compatible `version` field with migration map (v1→vN).
- Validation pass before hydrate:
  - No missing node IDs.
  - DAG constraint for MVP (cycle rejection).
  - Type-safe socket compatibility checks.

### Execution Path
- **Authoring**: UI edits mutate an in-memory graph store.
- **Compile**: Graph compiler topologically sorts nodes and emits an execution plan.
- **Evaluate**:
  - Preferred path: GPU shader passes into offscreen render target texture.
  - Fallback path: CPU raster evaluation for environments with limited WebGL features.
- **Consume**:
  - Generated texture is routed through existing `previewMaterial` and displacement flow as if it were a custom uploaded map.

### Integration Points
- **Settings**
  - Extend existing settings payload with `proceduralGraph`, `proceduralGraphEnabled`, and selected graph preset key.
  - Preserve existing texture preset selection for seamless fallback.
- **Export pipeline**
  - Exported mesh remains unchanged structurally; displacement sampling source can be procedural texture output.
  - Add optional metadata sidecar (`<filename>.bumpmesh.json`) containing graph hash and parameters for reproducibility.
- **UI panels**
  - New “Procedural” panel adjacent to texture selection.
  - Keep projection/displacement controls unchanged; they apply post-graph exactly as with bitmap textures.

---

## RFC 5.2: Brush Painting Workflow

### Problem Statement
Current face masking tools are functional but limited for iterative, high-resolution texturing workflows. We need predictable brush behavior, scalable storage, and reversible edits.

### MVP Scope
- Add brush painting mode for texture influence weight (0..1), separate from binary exclusion/inclusion masks.
- Support circular brush with size, strength, and falloff controls.
- Implement undo/redo history for paint strokes.
- Introduce texture-resolution strategy that decouples paint map resolution from viewport size.
- Integrate with existing exclusion logic by composing final influence mask.

### Out of Scope (MVP)
- Layer stacks (multiply/add/subtract layers).
- Smudge/clone/heal brush families.
- Cross-session collaborative painting.
- Pressure/tilt tablet-specific APIs.

### Data Model
```ts
interface PaintState {
  version: 1;
  uvMaskResolution: 1024 | 2048 | 4096;
  channels: {
    influence: Uint8Array; // grayscale in UV atlas space
  };
  strokes: StrokeRecord[]; // for timeline and replay
  history: {
    undoStack: DeltaChunk[];
    redoStack: DeltaChunk[];
    maxBytes: number;
  };
}

interface StrokeRecord {
  id: string;
  tool: 'paint' | 'erase';
  brushSizePx: number;
  strength: number; // 0..1
  falloff: number;  // 0..1
  points: Array<{ u: number; v: number; t: number }>;
}

interface DeltaChunk {
  bounds: { x: number; y: number; w: number; h: number };
  before: Uint8Array;
  after: Uint8Array;
}
```

### GPU/CPU Path
- **GPU path (default)**
  - Stroke points rasterized into an offscreen mask texture.
  - Preview combines texture map × influence mask in shader for low-latency feedback.
- **CPU path (fallback)**
  - Brush dabs applied to UV mask buffer in typed arrays.
  - Preview texture updated via incremental texture upload.
- Both paths produce identical final influence data format before export.

### Undo/Redo Storage Strategy
- Store stroke-local rectangular deltas (before/after) rather than full texture snapshots.
- Memory ceiling via byte budget (default e.g., 256 MB) with oldest-undo eviction.
- Each completed stroke is one history transaction.

### Texture Resolution Strategy
- User-selectable quality presets:
  - Draft (1024), Standard (2048), High (4096).
- Resolution changes trigger resampling with warning if downscaling may lose detail.
- Export always uses current selected paint resolution unless “auto-downsample for memory safety” is enabled.

### Integration Points
- **Settings**
  - Add `paintMaskEnabled`, `paintMaskResolution`, brush defaults, and history memory cap.
- **Export pipeline**
  - Compose displacement sample = base texture/procedural graph output × paint influence × exclusion/inclusion mask.
  - Persist optional compact paint metadata (resolution + hash), not full mask bitmap by default.
- **UI panels**
  - Extend existing masking/exclusion panel with a “Paint Influence” sub-mode.
  - Add history controls (Undo/Redo/Clear) and resolution selector.

---

## RFC 5.3: Print Profile Tuning

### Problem Statement
Users currently tune displacement largely by trial-and-error. A print-profile-aware advisory layer can provide actionable parameter guidance for nozzle, layer height, and material constraints.

### MVP Scope
- Define a normalized print-profile input schema.
- Add rule engine that suggests safe parameter bands (amplitude, smoothing, minimum feature scale).
- Show warnings and recommendations in UI without hard-blocking export (except existing safety checks).
- Allow profile presets for common setups (e.g., 0.4 mm PLA, 0.6 mm PETG).

### Out of Scope (MVP)
- Full slicer integration or direct profile import from all slicer formats.
- Machine-specific acceleration/pressure-advance simulation.
- Automatic mesh repair/remeshing based on profile.

### Data Model
```ts
interface PrintProfile {
  version: 1;
  nozzleDiameterMm: number;
  layerHeightMm: number;
  material: 'PLA' | 'PETG' | 'ABS' | 'TPU' | 'PA' | 'Custom';
  lineWidthMm?: number;
  targetUse?: 'visual' | 'functional' | 'flexible';
  machine?: {
    name?: string;
    maxVolumetricFlowMm3s?: number;
  };
}

interface TuningAdvice {
  recommendedAmplitudeMm: { min: number; max: number };
  recommendedSmoothingPx: { min: number; max: number };
  minFeatureMm: number;
  severity: 'info' | 'warning' | 'critical';
  messages: string[];
  triggeredRuleIds: string[];
}
```

### Rule Engine Boundaries
- Deterministic, local rules only (no ML service dependency).
- Inputs limited to:
  - print profile
  - current texture/displacement settings
  - mesh scale metrics already available in app
- Outputs limited to:
  - recommendations/warnings for UI
  - optional pre-population defaults when profile changes
- Rule engine must **not** mutate mesh geometry directly.

### Integration Points
- **Settings**
  - Persist `printProfile` and `profileTuningEnabled`.
  - Track user override flags so recommendations do not repeatedly reset manual values.
- **Export pipeline**
  - Reuse advisory output in pre-export validation summary.
  - Keep existing export stages unchanged; add advisory report block in progress/details UI.
- **UI panels**
  - New “Print Profile” panel with schema fields and preset selector.
  - Inline advisory badges on displacement controls (e.g., amplitude slider).
  - “Why this warning?” expandable details tied to rule IDs.

## Rollout Notes (All RFCs)
- Feature-flag each RFC independently to reduce regression risk.
- Gate advanced workflows behind explicit opt-in until telemetry/feedback confirms stability.
- Provide migration defaults so existing saved settings continue to load without user intervention.
