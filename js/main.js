import * as THREE from 'three';
import { initViewer, loadGeometry, setMeshMaterial, setMeshGeometry, setWireframe,
         getControls, getCamera, getCurrentMesh,
         setExclusionOverlay, setHoverPreview, setViewerTheme,
         setProjection, requestRender,
         clearDiagOverlays, setDiagEdges, addDiagFaces,
         setFaceScalarOverlay, setSplitView } from './viewer.js';
import { loadModelFile, computeBounds, getTriangleCount }  from './stlLoader.js';
import { loadAllThumbnails, loadFullPreset, loadCustomTexture, IMAGE_PRESETS }  from './presetTextures.js';
import { createPreviewMaterial, updateMaterial } from './previewMaterial.js';
import { computeUV } from './mapping.js';
import { subdivide }          from './subdivision.js';
import { applyDisplacement }  from './displacement.js';
import { decimate }           from './decimation.js';
import { exportSTL, export3MF } from './exporter.js';
import { buildAdjacency, bucketFill,
         buildExclusionOverlayGeo, buildFaceWeights } from './exclusion.js';
import { runFastDiagnostics, runExpensiveDiagnostics,
         getEdgePositions, getShellAssignments } from './meshValidation.js';
import { derivePresetSettings } from './exportValidationCore.js';
import { t, initLang, setLang, getLang, applyTranslations, TRANSLATIONS } from './i18n.js';

// ── State ─────────────────────────────────────────────────────────────────────

let currentGeometry   = null;   // original loaded geometry
let currentBounds     = null;   // bounds of the original geometry
let currentStlName    = 'model'; // base filename of the loaded STL (no extension)
let activeMapEntry    = null;   // { name, texture, imageData, width, height, isCustom? }
let previewMaterial   = null;
let isExporting       = false;
let previewDebounce   = null;

// Boundary edge data texture for per-fragment falloff in bump-only preview
let _boundaryEdgeTex   = null;
let _boundaryEdgeCount = 0;
let _falloffDirty      = true;   // recompute falloff on next updateFaceMask
let _falloffGeometry   = null;   // geometry the falloff was last computed for

// ── Exclusion state ───────────────────────────────────────────────────────────
let excludedFaces      = new Set();   // triangle indices in currentGeometry
let triangleAdjacency  = null;        // Array from buildAdjacency
let triangleCentroids  = null;        // Float32Array from buildAdjacency
let triangleBoundRadii = null;        // Float32Array — max vertex-to-centroid dist per tri
let exclusionTool      = null;        // 'brush' | 'bucket' | null
let eraseMode          = false;
let brushIsRadius      = false;
let brushRadius        = 5.0;
let bucketThreshold    = 20;
let isPainting         = false;
let selectionMode      = false;       // false = exclude painted faces; true = include only painted faces
let _lastHoverTriIdx   = -1;          // last triangle index used for hover preview
let placeOnFaceActive  = false;       // true while "Place on Face" mode is active
const _raycaster       = new THREE.Raycaster();
let _lastPaintHitPoint = null;        // THREE.Vector3 — last brush paint position for shift-line
let _shiftLineMesh     = null;        // THREE.Line — preview line from last paint to cursor
let _lastEffectiveTexture = null;
let _effectiveMapCache    = null;
let _effectiveMapCacheKey = null;
let exportWorker          = null;
let exportWorkerState     = 'unknown'; // 'unknown' | 'operational' | 'permanent-fallback'
let exportWorkerReason    = '';
const EXPORT_STAGE_DEBUG = /\bexportStageDebug=1\b/.test(window.location.search);

// ── Spatial grid state (must precede loadDefaultCube call) ────────────────────
let _spatialGrid = null;
let _spatialCellSize = 0;
let _spatialMinX = 0, _spatialMinY = 0, _spatialMinZ = 0;

const settings = {
  beginnerMode:  true,
  mappingMode:   5,     // Triplanar default
  scaleU:        0.5,
  scaleV:        0.5,
  amplitude:     0.5,
  offsetU:       0.0,
  offsetV:       0.0,
  rotation:      0,
  refineLength:  1.0,
  maxTriangles:  750_000,
  lockScale:     true,
  bottomAngleLimit: 5,
  topAngleLimit:    0,
  mappingBlend:     1,
  seamBandWidth:    0.5,
  textureSmoothing: 0,
  capAngle:         20,
  boundaryFalloff:  0,
  symmetricDisplacement: false,
  useDisplacement: false,
  vaseModeSafe: false,
  vaseSeamContinuityBias: 0.35,
  vaseCircumferentialAttenuation: 0.65,
  vaseRadialGuardMm: 0.05,
};

// ── Canvas filter support (Safari / iOS WebView don't support ctx.filter) ────
const CANVAS_FILTER_SUPPORTED = 'filter' in CanvasRenderingContext2D.prototype;

/**
 * Box-blur one row of RGBA pixels (horizontal pass).
 * Operates in-place reading from `src` and writing to `dst`.
 */
function _boxBlurH(src, dst, w, h, r) {
  const iarr = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let ch = 0; ch < 4; ch++) {
      let val = 0;
      // Seed with left-edge pixel repeated r+1 times plus the first r pixels
      for (let x = -r; x <= r; x++) val += src[(row + Math.max(0, Math.min(x, w - 1))) * 4 + ch];
      for (let x = 0; x < w; x++) {
        val += src[(row + Math.min(x + r, w - 1)) * 4 + ch]
             - src[(row + Math.max(x - r - 1, 0)) * 4 + ch];
        dst[(row + x) * 4 + ch] = Math.round(val * iarr);
      }
    }
  }
}

/** Box-blur one column of RGBA pixels (vertical pass). */
function _boxBlurV(src, dst, w, h, r) {
  const iarr = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    for (let ch = 0; ch < 4; ch++) {
      let val = 0;
      for (let y = -r; y <= r; y++) val += src[(Math.max(0, Math.min(y, h - 1)) * w + x) * 4 + ch];
      for (let y = 0; y < h; y++) {
        val += src[(Math.min(y + r, h - 1) * w + x) * 4 + ch]
             - src[(Math.max(y - r - 1, 0) * w + x) * 4 + ch];
        dst[(y * w + x) * 4 + ch] = Math.round(val * iarr);
      }
    }
  }
}

/**
 * Apply an approximate Gaussian blur (sigma px) to `canvas` in-place.
 * Uses the native CSS filter on Chrome/Firefox; falls back to a 3-pass
 * separable box blur for Safari / iOS WebKit.
 */
function blurCanvas(canvas, sigma) {
  if (sigma <= 0) return;
  if (CANVAS_FILTER_SUPPORTED) {
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width; tmp.height = canvas.height;
    const tc = tmp.getContext('2d');
    tc.filter = `blur(${sigma}px)`;
    tc.drawImage(canvas, 0, 0);
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    canvas.getContext('2d').drawImage(tmp, 0, 0);
  } else {
    // 3 passes of box blur ≈ Gaussian; radius r where r(r+1) ≈ sigma²
    const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const a = imgData.data;
    const b = new Uint8ClampedArray(a.length);
    const w = canvas.width, h = canvas.height;
    for (let pass = 0; pass < 3; pass++) {
      _boxBlurH(a, b, w, h, r);
      _boxBlurV(b, a, w, h, r);
    }
    ctx.putImageData(imgData, 0, 0);
  }
}

// ── Precision masking state ────────────────────────────────────────────────────
let precisionMaskingEnabled = false;
let precisionGeometry       = null;   // subdivided geometry for finer masking
let precisionParentMap      = null;   // Int32Array: refined face → original face index
let precisionEdgeLength     = null;   // edge length used for current refinement
let precisionBusy           = false;  // true while async subdivision is running
let precisionCentroids      = null;   // Float32Array from buildAdjacency on refined mesh
let precisionBoundRadii     = null;   // Float32Array — max vertex-to-centroid per refined tri
let precisionAdjacency      = null;   // Array from buildAdjacency on refined mesh
let precisionExcludedFaces  = new Set(); // precision face indices excluded while precision is active

// ── Displacement preview state ────────────────────────────────────────────────
let dispPreviewGeometry  = null;   // subdivided geometry with smoothNormal attribute
let dispPreviewBusy      = false;  // true while async subdivision is running
let dispPreviewParentMap = null;   // Int32Array: subdivided face → original face index

// ── Operation tokens (stale-result guards) ────────────────────────────────────
// Each async operation captures the current token at start and checks it after
// every await. When a new model loads all tokens are incremented, causing any
// in-flight operation to silently abort rather than apply results to new state.
let precisionToken   = 0;
let dispPreviewToken = 0;
let exportToken      = 0;
let diagToken        = 0;
let lastFastDiag     = null;   // cached fast diagnostics result for language refresh
let lastAdvancedDiag = null;   // cached advanced diagnostics result for language refresh
let activeDiagHighlight = null; // which highlight is showing: 'openEdges'|'nonManifold'|'shells'|'overlaps'|null
const activeAnalysisOverlays = {
  signedDisplacement: false,
  triangleDensity: false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const canvas         = document.getElementById('viewport');
const brushCursorEl  = document.getElementById('brush-cursor');
const dropZone       = document.getElementById('drop-zone');
const dropHint       = document.getElementById('drop-hint');
const stlFileInput   = document.getElementById('stl-file-input');
const textureInput   = document.getElementById('texture-file-input');
const presetGrid     = document.getElementById('preset-grid');
const activeMapName  = document.getElementById('active-map-name');
const textureValidationEl = document.getElementById('texture-validation');
const meshInfo       = document.getElementById('mesh-info');
const exportBtn        = document.getElementById('export-btn');
const export3mfBtn     = document.getElementById('export-3mf-btn');
const exportPresetSelect = document.getElementById('export-preset');
const exportProgress   = document.getElementById('export-progress');
const exportProgBar    = document.getElementById('export-progress-bar');
const exportProgPct    = document.getElementById('export-progress-pct');
const exportProgLbl    = document.getElementById('export-progress-label');
const exportValidationEl = document.getElementById('export-validation');
const vaseModeSafeToggle = document.getElementById('vase-mode-safe');
const triLimitWarning  = document.getElementById('tri-limit-warning');
const wireframeToggle  = document.getElementById('wireframe-toggle');
const projectionToggle = document.getElementById('projection-toggle');
const overlayModeSelect = document.getElementById('overlay-mode');
const splitViewToggle   = document.getElementById('split-view-toggle');
const placeOnFaceBtn   = document.getElementById('place-on-face-btn');
const beginnerModeToggle = document.getElementById('beginner-mode-toggle');

const mappingSelect   = document.getElementById('mapping-mode');
const scaleUSlider    = document.getElementById('scale-u');
const scaleVSlider    = document.getElementById('scale-v');
const lockScaleBtn    = document.getElementById('lock-scale');
const offsetUSlider   = document.getElementById('offset-u');
const offsetVSlider   = document.getElementById('offset-v');
const amplitudeSlider = document.getElementById('amplitude');
const refineLenSlider = document.getElementById('refine-length');
const maxTriSlider    = document.getElementById('max-triangles');

const scaleUVal    = document.getElementById('scale-u-val');
const scaleVVal    = document.getElementById('scale-v-val');
const offsetUVal   = document.getElementById('offset-u-val');
const offsetVVal   = document.getElementById('offset-v-val');
const rotationSlider = document.getElementById('rotation');
const rotationVal    = document.getElementById('rotation-val');
const amplitudeVal      = document.getElementById('amplitude-val');
const amplitudeWarning  = document.getElementById('amplitude-warning');
const refineLenVal = document.getElementById('refine-length-val');
const resolutionWarning = document.getElementById('resolution-warning');
const maxTriVal    = document.getElementById('max-triangles-val');

const bottomAngleLimitSlider = document.getElementById('bottom-angle-limit');
const topAngleLimitSlider    = document.getElementById('top-angle-limit');
const bottomAngleLimitVal    = document.getElementById('bottom-angle-limit-val');
const topAngleLimitVal       = document.getElementById('top-angle-limit-val');
const seamBlendSlider        = document.getElementById('seam-blend');
const seamBlendVal           = document.getElementById('seam-blend-val');
const seamBandWidthSlider    = document.getElementById('seam-band-width');
const seamBandWidthVal       = document.getElementById('seam-band-width-val');
const textureSmoothingSlider = document.getElementById('texture-smoothing');
const textureSmoothingVal    = document.getElementById('texture-smoothing-val');
const capAngleSlider         = document.getElementById('cap-angle');
const capAngleVal            = document.getElementById('cap-angle-val');
const capAngleRow            = document.getElementById('cap-angle-row');
const boundaryFalloffSlider    = document.getElementById('boundary-falloff');
const boundaryFalloffVal       = document.getElementById('boundary-falloff-val');
const symmetricDispToggle    = document.getElementById('symmetric-displacement');
const dispPreviewToggle      = document.getElementById('displacement-preview');
if (vaseModeSafeToggle) vaseModeSafeToggle.checked = settings.vaseModeSafe;

// ── Exclusion panel DOM refs ──────────────────────────────────────────────────
const exclBrushBtn        = document.getElementById('excl-brush-btn');
const exclBucketBtn       = document.getElementById('excl-bucket-btn');
const exclBrushTypeRow    = document.getElementById('excl-brush-type-row');
const exclBrushSingleBtn  = document.getElementById('excl-brush-single');
const exclBrushRadiusBtn  = document.getElementById('excl-brush-radius-btn');
const exclRadiusRow       = document.getElementById('excl-radius-row');
const exclBrushRadiusSlider = document.getElementById('excl-brush-radius-slider');
const exclBrushRadiusVal    = document.getElementById('excl-brush-radius-val');
const exclThresholdRow    = document.getElementById('excl-threshold-row');
const exclThresholdSlider = document.getElementById('excl-threshold-slider');
const exclThresholdVal    = document.getElementById('excl-threshold-val');
const exclCount           = document.getElementById('excl-count');
const exclClearBtn        = document.getElementById('excl-clear-btn');
const exclModeExcludeBtn  = document.getElementById('excl-mode-exclude');
const exclModeIncludeBtn  = document.getElementById('excl-mode-include');
const exclSectionHeading  = document.getElementById('excl-section-heading');
const exclHint            = document.getElementById('excl-hint');

// ── Precision masking DOM refs ────────────────────────────────────────────────
const precisionMaskingRow     = document.getElementById('precision-masking-row');
const precisionMaskingToggle  = document.getElementById('precision-masking-toggle');
const precisionStatus         = document.getElementById('precision-status');
const precisionOutdated       = document.getElementById('precision-outdated');
const precisionRefreshBtn     = document.getElementById('precision-refresh-btn');
const precisionWarning        = document.getElementById('precision-warning');

// ── Mesh diagnostics DOM refs ────────────────────────────────────────────────
const meshDiagnostics    = document.getElementById('mesh-diagnostics');
const meshDiagDismiss    = document.getElementById('mesh-diag-dismiss');
const meshDiagFast       = document.getElementById('mesh-diag-fast');
const meshDiagRunBtn     = document.getElementById('mesh-diag-run-btn');
const meshDiagSpinner    = document.getElementById('mesh-diag-spinner');
const meshDiagAdvanced   = document.getElementById('mesh-diag-advanced');
const advancedControlGroups = Array.from(document.querySelectorAll('.advanced-control-group'));

// ── License panel DOM refs ────────────────────────────────────────────────────
const licenseLink    = document.getElementById('license-link');
const licenseOverlay = document.getElementById('license-overlay');
const licenseClose   = document.getElementById('license-close');
const imprintLink    = document.getElementById('imprint-link');
const imprintOverlay = document.getElementById('imprint-overlay');
const imprintClose   = document.getElementById('imprint-close');

// ── Language selector DOM refs ────────────────────────────────────────────────────
const languageSelector = document.querySelector('.lang-seg');

// ── Scale slider log helpers ──────────────────────────────────────────────────
// Slider stores 0–1000; actual scale spans 0.05–10 on a log axis.
// Middle position 500 → scale ~0.71 (log midpoint between 0.05 and 10).
const _LOG_MIN = Math.log(0.05);
const _LOG_MAX = Math.log(10);
const scaleToPos = v => Math.round(Math.max(0, Math.min(1000, (Math.log(Math.max(0.01, Math.min(10, v))) - _LOG_MIN) / (_LOG_MAX - _LOG_MIN) * 1000)));
const posToScale = p => parseFloat(Math.exp(_LOG_MIN + (p / 1000) * (_LOG_MAX - _LOG_MIN)).toFixed(2));
let advancedSettingSnapshot = null;

function setLinkedControl(slider, valInput, value, formatter = null) {
  if (!slider || !valInput) return;
  slider.value = value;
  if (valInput.tagName === 'SPAN') {
    valInput.textContent = formatter ? formatter(value) : value;
  } else {
    valInput.value = formatter ? formatter(value) : value;
  }
}

function captureAdvancedSettings() {
  advancedSettingSnapshot = {
    mappingBlend: settings.mappingBlend,
    seamBandWidth: settings.seamBandWidth,
    capAngle: settings.capAngle,
    offsetU: settings.offsetU,
    offsetV: settings.offsetV,
    rotation: settings.rotation,
    useDisplacement: settings.useDisplacement,
    precisionMaskingEnabled,
  };
}

function restoreAdvancedSettings() {
  if (!advancedSettingSnapshot) return;
  settings.mappingBlend = advancedSettingSnapshot.mappingBlend;
  settings.seamBandWidth = advancedSettingSnapshot.seamBandWidth;
  settings.capAngle = advancedSettingSnapshot.capAngle;
  settings.offsetU = advancedSettingSnapshot.offsetU;
  settings.offsetV = advancedSettingSnapshot.offsetV;
  settings.rotation = advancedSettingSnapshot.rotation;

  setLinkedControl(seamBlendSlider, seamBlendVal, settings.mappingBlend, v => Number(v).toFixed(2));
  setLinkedControl(seamBandWidthSlider, seamBandWidthVal, settings.seamBandWidth, v => Number(v).toFixed(2));
  setLinkedControl(capAngleSlider, capAngleVal, settings.capAngle, v => Math.round(Number(v)));
  setLinkedControl(offsetUSlider, offsetUVal, settings.offsetU, v => Number(v).toFixed(2));
  setLinkedControl(offsetVSlider, offsetVVal, settings.offsetV, v => Number(v).toFixed(2));
  setLinkedControl(rotationSlider, rotationVal, settings.rotation, v => Math.round(Number(v)));

  if (advancedSettingSnapshot.useDisplacement) {
    dispPreviewToggle.checked = true;
    toggleDisplacementPreview(true);
  }
  if (advancedSettingSnapshot.precisionMaskingEnabled && !precisionMaskingRow.classList.contains('hidden')) {
    precisionMaskingToggle.checked = true;
    togglePrecisionMasking(true);
  }
}

function applyBeginnerModeUI() {
  const beginnerMode = !!settings.beginnerMode;
  document.body.classList.toggle('beginner-mode', beginnerMode);
  advancedControlGroups.forEach(group => {
    group.classList.toggle('collapsed-advanced-control', beginnerMode);
    if (beginnerMode) group.setAttribute('aria-hidden', 'true');
    else group.removeAttribute('aria-hidden');
  });

  if (beginnerMode) {
    if (!advancedSettingSnapshot) captureAdvancedSettings();
    settings.mappingBlend = 1;
    settings.seamBandWidth = 0.35;
    settings.capAngle = 20;
    settings.offsetU = 0;
    settings.offsetV = 0;
    settings.rotation = 0;

    setLinkedControl(seamBlendSlider, seamBlendVal, 1, () => '1.00');
    setLinkedControl(seamBandWidthSlider, seamBandWidthVal, 0.35, () => '0.35');
    setLinkedControl(capAngleSlider, capAngleVal, 20, () => 20);
    setLinkedControl(offsetUSlider, offsetUVal, 0, () => '0.00');
    setLinkedControl(offsetVSlider, offsetVVal, 0, () => '0.00');
    setLinkedControl(rotationSlider, rotationVal, 0, () => 0);

    if (dispPreviewToggle.checked || settings.useDisplacement) {
      dispPreviewToggle.checked = false;
      toggleDisplacementPreview(false);
    }
    if (precisionMaskingEnabled) {
      precisionMaskingToggle.checked = false;
      togglePrecisionMasking(false);
    }
  } else {
    restoreAdvancedSettings();
    advancedSettingSnapshot = null;
  }
  checkResolutionWarning();
  updatePreview();
}

function _applyScaleU(v) {
  v = Math.max(0.01, Math.min(10, v));
  settings.scaleU = v;
  scaleUSlider.value = scaleToPos(v);
  scaleUVal.value = v;
  if (settings.lockScale) { settings.scaleV = v; scaleVSlider.value = scaleToPos(v); scaleVVal.value = v; }
  clearTimeout(previewDebounce); previewDebounce = setTimeout(updatePreview, 80);
}

// ── Init ──────────────────────────────────────────────────────────────────────

let PRESETS = [];

initViewer(canvas);

// Apply saved theme to 3D viewport on startup
setViewerTheme(document.documentElement.getAttribute('data-theme') === 'light');

const beginnerModeKey = 'stlt-beginner-mode';
const savedBeginnerMode = localStorage.getItem(beginnerModeKey);
settings.beginnerMode = savedBeginnerMode === null ? true : savedBeginnerMode !== '0';
if (beginnerModeToggle) beginnerModeToggle.checked = settings.beginnerMode;

// Populate the language selector
function populateLanguageSelector() {
  if (!languageSelector) return;
  languageSelector.innerHTML = '';

  const select = document.createElement('select');
  select.className = 'lang-dropdown';
  select.id = 'lang-select';
  select.name = 'lang-select';
  select.setAttribute('aria-label', 'Select language');

  for (const langKey in TRANSLATIONS) {
    const opt = document.createElement('option');
    opt.value = langKey;
    opt.className = 'lang-option';
    opt.textContent = TRANSLATIONS[langKey]['lang.name'] || langKey.toUpperCase();
    select.appendChild(opt);
  }

  select.addEventListener('change', async (e) => {
    const ok = await setLang(e.target.value);
    if (!ok) {
      // Revert the dropdown to the language that is actually active
      select.value = getLang();
      alert('Could not load the selected language. Please check your connection and try again.');
      return;
    }

    // Re-translate <option> elements (innerHTML won't reach these)
    document.querySelectorAll('#mapping-mode option[data-i18n-opt]').forEach(opt => {
      opt.textContent = t(opt.dataset.i18nOpt);
    });

    // Refresh dynamic count text to current language
    if (currentGeometry) {
      const triCount = getTriangleCount(currentGeometry);
      const mb = ((currentGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
      const sx = currentBounds.size.x.toFixed(2);
      const sy = currentBounds.size.y.toFixed(2);
      const sz = currentBounds.size.z.toFixed(2);
      meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });
      refreshExclusionOverlay();
      if (lastFastDiag) renderFastDiag(lastFastDiag);
      if (lastAdvancedDiag) renderAdvancedDiag(lastAdvancedDiag);
    }

    if (activeMapEntry?._validation) {
      renderTextureValidation(activeMapEntry._validation);
    }
    renderExportValidation();
  });

  languageSelector.appendChild(select);
}
populateLanguageSelector();

// Initialise language (reads localStorage / browser preference, applies translations)
{
  const { enFailed } = await initLang();
  if (enFailed) {
    // English base strings failed — the UI will show raw keys. Surface a plain
    // English message since t() won't work reliably at this point.
    console.error('[i18n] English language file failed to load — UI text will be missing');
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#c0392b;color:#fff;padding:10px 16px;font-family:sans-serif;font-size:14px;text-align:center';
    banner.textContent = 'Warning: language files could not be loaded. The interface may show missing text. Check your network connection and reload the page.';
    document.body.prepend(banner);
  }
}

// Sync lang dropdown to current language
(function() {
  const lang = getLang();
  const select = languageSelector.querySelector('select');
  if (select) {
    select.value = lang;
  }
})();

// Theme toggle
document.getElementById('theme-toggle').addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') !== 'light';
  document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
  localStorage.setItem('stlt-theme', isLight ? 'light' : 'dark');
  setViewerTheme(isLight);
});

wireEvents();
// Sync scale number inputs with the slider's initial position
scaleUVal.value = posToScale(parseFloat(scaleUSlider.value));
scaleVVal.value = posToScale(parseFloat(scaleVSlider.value));

// Load geometry immediately — don't wait for textures
loadDefaultCube();

// Build swatches with placeholder canvases, then load thumbnails
const DEFAULT_PRESET_NAME = 'Crystal';
const _presetSwatches = IMAGE_PRESETS.map((p, idx) => {
  const swatch = document.createElement('div');
  swatch.className = 'preset-swatch preset-loading';
  swatch.setAttribute('role', 'button');
  swatch.setAttribute('tabindex', '0');
  swatch.title = p.name;

  const placeholder = document.createElement('canvas');
  placeholder.width = 80; placeholder.height = 80;
  swatch.appendChild(placeholder);

  const label = document.createElement('span');
  label.className = 'preset-label';
  label.textContent = p.name;
  swatch.appendChild(label);

  swatch.addEventListener('click', () => selectPreset(idx, swatch));
  swatch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectPreset(idx, swatch);
    }
  });
  presetGrid.appendChild(swatch);
  return swatch;
});

// Load lightweight thumbnails (~49 KB total), then auto-select Crystal
loadAllThumbnails().then(thumbs => {
  thumbs.forEach((thumb, idx) => {
    if (!thumb) return;
    PRESETS[idx] = thumb;         // thumbnail-only entry for now
    const swatch = _presetSwatches[idx];
    if (!swatch) return;
    swatch.classList.remove('preset-loading');
    const placeholder = swatch.querySelector('canvas');
    swatch.replaceChild(thumb.thumbCanvas, placeholder);
  });
  // Auto-select the default preset
  const crystalIdx = IMAGE_PRESETS.findIndex(p => p.name === DEFAULT_PRESET_NAME);
  if (crystalIdx >= 0 && PRESETS[crystalIdx]) {
    selectPreset(crystalIdx, _presetSwatches[crystalIdx]);
  }
}).catch(err => console.error('Failed to load thumbnails:', err));

// ── Preset grid ───────────────────────────────────────────────────────────────

function resetTextureSmoothing() {
  settings.textureSmoothing = 0;
  textureSmoothingSlider.value = 0;
  textureSmoothingVal.value    = 0;
  vaseValidationCache = { key: '', metrics: null };
}

function _quantileFromHist(hist, q, total) {
  const target = Math.max(0, Math.min(total - 1, Math.floor(q * (total - 1))));
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc > target) return i / 255;
  }
  return 1;
}

function analyzeTextureQuality(entry) {
  const { imageData, width, height } = entry;
  const data = imageData.data;
  const pxCount = width * height;
  const hist = new Uint32Array(256);
  const gray = new Uint8Array(pxCount);
  let sumL = 0;
  let sumL2 = 0;
  let colorDiffSum = 0;

  for (let i = 0, px = 0; i < data.length; i += 4, px++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // Keep seam checks in the same perceptual space as the histogram metrics.
    const l = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    gray[px] = l;
    hist[l]++;
    sumL += l;
    sumL2 += l * l;
    colorDiffSum += (Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r)) / (3 * 255);
  }

  const mean = sumL / pxCount;
  const variance = Math.max(0, sumL2 / pxCount - mean * mean);
  const stdNorm = Math.sqrt(variance) / 255;
  const p01 = _quantileFromHist(hist, 0.01, pxCount);
  const p99 = _quantileFromHist(hist, 0.99, pxCount);
  const dynamicRange = Math.max(0, p99 - p01);
  const clipLow = hist[0] / pxCount;
  const clipHigh = hist[255] / pxCount;

  let seamAcc = 0;
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    seamAcc += Math.abs(gray[rowOff] - gray[rowOff + (width - 1)]);
  }
  const lastRowOff = (height - 1) * width;
  for (let x = 0; x < width; x++) {
    seamAcc += Math.abs(gray[x] - gray[lastRowOff + x]);
  }
  const seamScore = seamAcc / ((width + height) * 255);

  return {
    grayscaleDeviation: colorDiffSum / pxCount,
    histogramStd: stdNorm,
    dynamicRange,
    clipLow,
    clipHigh,
    seamScore,
  };
}

function validateTextureEntry(entry) {
  if (entry._validation) return entry._validation;
  const metrics = analyzeTextureQuality(entry);
  const issues = [];

  if (metrics.grayscaleDeviation > 0.12) {
    issues.push({ level: 'error', message: t('textureValidation.strongColor') });
  } else if (metrics.grayscaleDeviation > 0.03) {
    issues.push({ level: 'warn', message: t('textureValidation.notGrayscale') });
  }

  if (metrics.dynamicRange < 0.10 || metrics.histogramStd < 0.10) {
    issues.push({ level: 'warn', message: t('textureValidation.lowContrast') });
  }

  if (metrics.clipLow + metrics.clipHigh > 0.18) {
    issues.push({ level: 'warn', message: 'Histogram clipping detected; details may crush at min/max height.' });
  }

  if (metrics.seamScore > 0.10) {
    issues.push({ level: 'warn', message: 'High seam mismatch score; tiling seams may be visible.' });
  }

  const severity = issues.some(i => i.level === 'error')
    ? 'error'
    : issues.some(i => i.level === 'warn')
      ? 'warn'
      : 'ok';

  const result = { metrics, issues, severity };
  entry._validation = result;
  return result;
}

function renderTextureValidation(validation) {
  if (!textureValidationEl) return;
  textureValidationEl.classList.remove('hidden', 'ok', 'warn', 'error');
  textureValidationEl.classList.add(validation.severity);
  const m = validation.metrics;
  const headline = validation.severity === 'ok'
    ? t('textureValidation.headlineOk')
    : validation.severity === 'warn'
      ? t('textureValidation.headlineWarn')
      : t('textureValidation.headlineError');
  const metricLine = t('textureValidation.metrics', {
    gray: m.grayscaleDeviation.toFixed(3),
    range: m.dynamicRange.toFixed(2),
    seam: m.seamScore.toFixed(2),
  });
  const issueLine = validation.issues.length
    ? validation.issues.map(i => `• ${i.message}`).join('<br/>')
    : `• ${t('textureValidation.ready')}`;
  textureValidationEl.innerHTML = `${headline}<br/>${metricLine}<br/>${issueLine}`;
}

function clearTextureValidation() {
  if (!textureValidationEl) return;
  textureValidationEl.className = 'texture-validation hidden';
  textureValidationEl.textContent = '';
}

let _selectGeneration = 0;   // debounce rapid preset clicks

async function selectPreset(idx, swatchEl) {
  const gen = ++_selectGeneration;
  document.querySelectorAll('.preset-swatch').forEach(s => s.classList.remove('active'));
  swatchEl.classList.add('active');

  const entry = PRESETS[idx];
  if (!entry) return;
  activeMapName.textContent = entry.name;
  resetTextureSmoothing();
  if (entry.defaultScale != null) _applyScaleU(entry.defaultScale);

  // If full texture is already loaded, use it directly
  if (entry.texture) {
    const validation = validateTextureEntry(entry);
    renderTextureValidation(validation);
    if (validation.severity === 'error') return;
    activeMapEntry = entry;
    updatePreview();
    return;
  }

  // Load full-resolution texture on demand
  swatchEl.classList.add('preset-loading-full');
  try {
    const full = await loadFullPreset(idx);
    if (gen !== _selectGeneration) return;   // user clicked another preset meanwhile
    PRESETS[idx] = { ...entry, ...full };
    const validation = validateTextureEntry(PRESETS[idx]);
    renderTextureValidation(validation);
    if (validation.severity === 'error') {
      swatchEl.classList.remove('active');
      swatchEl.classList.remove('preset-loading-full');
      return;
    }
    activeMapEntry = PRESETS[idx];
    swatchEl.classList.remove('preset-loading-full');
    updatePreview();
  } catch (err) {
    console.error('Failed to load full texture:', err);
    swatchEl.classList.remove('preset-loading-full');
  }
}

// ── Accessibility: Modal focus trap ───────────────────────────────────────────
function trapFocus(overlay) {
  const focusable = overlay.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  first.focus();

  function handler(e) {
    if (e.key === 'Escape') {
      overlay.classList.add('hidden');
      overlay.removeEventListener('keydown', handler);
      return;
    }
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  overlay.addEventListener('keydown', handler);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireEvents() {
  // ── Model loading ──
  stlFileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleModelFile(e.target.files[0]);
  });

  // Drag & drop on the viewport section
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = [...e.dataTransfer.files].find(f => /\.(stl|obj|3mf)$/i.test(f.name));
    if (file) handleModelFile(file);
  });

  // Allow clicking the drop zone to open the file picker (except on canvas)
  dropZone.addEventListener('click', (e) => {
    if (e.target === dropZone) stlFileInput.click();
  });

  // ── Mesh diagnostics: advanced checks ──
  meshDiagRunBtn.addEventListener('click', async () => {
    if (!currentGeometry || !triangleAdjacency) return;
    const myToken = diagToken;
    meshDiagRunBtn.disabled = true;
    meshDiagSpinner.classList.remove('hidden');
    meshDiagAdvanced.classList.add('hidden');

    try {
      const token = { get() { return diagToken; } };
      const results = await runExpensiveDiagnostics(currentGeometry, token);

      if (diagToken !== myToken) return; // model changed, discard

      if (!results) return; // aborted

      lastAdvancedDiag = results;
      renderAdvancedDiag(results);
      meshDiagAdvanced.classList.remove('hidden');
    } catch (err) {
      console.error('Advanced diagnostics failed:', err);
    } finally {
      if (diagToken === myToken) {
        meshDiagSpinner.classList.add('hidden');
        meshDiagRunBtn.disabled = false;
      }
    }
  });

  // ── Custom texture upload ──
  textureInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const candidate = await loadCustomTexture(file);
      const validation = validateTextureEntry(candidate);
      renderTextureValidation(validation);
      if (validation.severity === 'error') {
        alert(validation.issues.map(i => i.message).join('\n'));
        textureInput.value = '';
        return;
      }
      activeMapEntry = candidate;
      activeMapEntry.isCustom = true;
      activeMapName.textContent = file.name;
      document.querySelectorAll('.preset-swatch').forEach(s => s.classList.remove('active'));
      resetTextureSmoothing();
      updatePreview();
    } catch (err) {
      console.error('Failed to load texture:', err);
    }
  });

  // ── Settings ──
  beginnerModeToggle?.addEventListener('change', () => {
    settings.beginnerMode = beginnerModeToggle.checked;
    localStorage.setItem(beginnerModeKey, settings.beginnerMode ? '1' : '0');
    applyBeginnerModeUI();
  });

  mappingSelect.addEventListener('change', () => {
    settings.mappingMode = parseInt(mappingSelect.value, 10);
    capAngleRow.style.display = settings.mappingMode === 3 ? '' : 'none';
    updatePreview();
  });

  // Scale U — when lock is on, mirror to V
  const applyScaleU = (v) => _applyScaleU(v);
  scaleUSlider.addEventListener('input', () => applyScaleU(posToScale(parseFloat(scaleUSlider.value))));
  scaleUSlider.addEventListener('dblclick', () => applyScaleU(posToScale(parseFloat(scaleUSlider.defaultValue))));
  scaleUVal.addEventListener('change', () => applyScaleU(parseFloat(scaleUVal.value)));
  addFineWheelSupport(scaleUVal, applyScaleU);

  // Scale V — when lock is on, mirror to U
  const applyScaleV = (v) => {
    v = Math.max(0.01, Math.min(10, v));
    settings.scaleV = v;
    scaleVSlider.value = scaleToPos(v);
    scaleVVal.value = v;
    if (settings.lockScale) { settings.scaleU = v; scaleUSlider.value = scaleToPos(v); scaleUVal.value = v; }
    clearTimeout(previewDebounce); previewDebounce = setTimeout(updatePreview, 80);
  };
  scaleVSlider.addEventListener('input', () => applyScaleV(posToScale(parseFloat(scaleVSlider.value))));
  scaleVSlider.addEventListener('dblclick', () => applyScaleV(posToScale(parseFloat(scaleVSlider.defaultValue))));
  scaleVVal.addEventListener('change', () => applyScaleV(parseFloat(scaleVVal.value)));
  addFineWheelSupport(scaleVVal, applyScaleV);

  // Lock toggle
  lockScaleBtn.addEventListener('click', () => {
    settings.lockScale = !settings.lockScale;
    lockScaleBtn.classList.toggle('active', settings.lockScale);
    lockScaleBtn.setAttribute('aria-pressed', String(settings.lockScale));
    if (settings.lockScale) {
      settings.scaleV = settings.scaleU;
      scaleVSlider.value = scaleToPos(settings.scaleU);
      scaleVVal.value = settings.scaleU;
      updatePreview();
    }
  });

  linkSlider(offsetUSlider,   offsetUVal,   v => { settings.offsetU   = v; return v.toFixed(2); });
  linkSlider(offsetVSlider,   offsetVVal,   v => { settings.offsetV   = v; return v.toFixed(2); });
  linkSlider(rotationSlider,  rotationVal,  v => { settings.rotation  = v; return Math.round(v); });
  linkSlider(amplitudeSlider, amplitudeVal, v => { settings.amplitude = v; checkAmplitudeWarning(); return v.toFixed(2); });
  amplitudeVal.addEventListener('change', checkAmplitudeWarning);
  linkSlider(boundaryFalloffSlider, boundaryFalloffVal, v => { settings.boundaryFalloff = v; _falloffDirty = true; return v.toFixed(1); });
  linkSlider(refineLenSlider, refineLenVal, v => { settings.refineLength  = v; checkResolutionWarning(); return v.toFixed(2); }, false);
  refineLenVal.addEventListener('change', checkResolutionWarning);
  linkSlider(maxTriSlider, maxTriVal, v => { settings.maxTriangles = v; return formatM(v); }, false);
  linkSlider(bottomAngleLimitSlider, bottomAngleLimitVal, v => { settings.bottomAngleLimit = v; _falloffDirty = true; return v; });
  linkSlider(topAngleLimitSlider,    topAngleLimitVal,    v => { settings.topAngleLimit    = v; _falloffDirty = true; return v; });
  linkSlider(seamBlendSlider,        seamBlendVal,        v => { settings.mappingBlend     = v; return v.toFixed(2); });
  linkSlider(seamBandWidthSlider,    seamBandWidthVal,    v => { settings.seamBandWidth    = v; return v.toFixed(2); });
  linkSlider(textureSmoothingSlider, textureSmoothingVal, v => { settings.textureSmoothing = v; return v.toFixed(1); });
  linkSlider(capAngleSlider,          capAngleVal,          v => { settings.capAngle         = v; return Math.round(v); });
  symmetricDispToggle.addEventListener('change', () => {
    settings.symmetricDisplacement = symmetricDispToggle.checked;
    updatePreview();
  });
  if (vaseModeSafeToggle) {
    vaseModeSafeToggle.addEventListener('change', () => {
      settings.vaseModeSafe = vaseModeSafeToggle.checked;
      renderExportValidation();
      updatePreview();
    });
  }

  dispPreviewToggle.addEventListener('change', () => {
    toggleDisplacementPreview(dispPreviewToggle.checked);
  });

  // ── Place on Face ──
  placeOnFaceBtn.addEventListener('click', () => {
    togglePlaceOnFace(!placeOnFaceActive);
  });

  // ── License ──
  licenseLink.addEventListener('click', () => { licenseOverlay.classList.remove('hidden'); trapFocus(licenseOverlay); });
  licenseClose.addEventListener('click', () => licenseOverlay.classList.add('hidden'));
  licenseOverlay.addEventListener('click', (e) => {
    if (e.target === licenseOverlay) licenseOverlay.classList.add('hidden');
  });

  // ── Imprint & Privacy ──
  imprintLink.addEventListener('click', () => { imprintOverlay.classList.remove('hidden'); trapFocus(imprintOverlay); });
  imprintClose.addEventListener('click', () => imprintOverlay.classList.add('hidden'));
  imprintOverlay.addEventListener('click', (e) => {
    if (e.target === imprintOverlay) imprintOverlay.classList.add('hidden');
  });

  // ── Mesh diagnostics dismiss ──
  meshDiagDismiss.addEventListener('click', () => {
    meshDiagnostics.classList.add('hidden');
    clearDiagHighlight();
  });

  if (diagSignedDispToggle) {
    diagSignedDispToggle.addEventListener('change', () => {
      activeAnalysisOverlays.signedDisplacement = diagSignedDispToggle.checked;
      if (diagSignedDispToggle.checked) activeDiagHighlight = null;
      refreshDiagOverlays();
    });
  }
  if (diagTriDensityToggle) {
    diagTriDensityToggle.addEventListener('change', () => {
      activeAnalysisOverlays.triangleDensity = diagTriDensityToggle.checked;
      if (diagTriDensityToggle.checked) activeDiagHighlight = null;
      refreshDiagOverlays();
    });
  }

  // ── Support banner dismiss ──
  document.getElementById('store-cta-dismiss').addEventListener('click', () => {
    document.getElementById('store-cta-wrapper').classList.add('store-cta-hidden');
  });

  // ── Export ──
  if (exportPresetSelect) {
    exportPresetSelect.addEventListener('change', () => {
      applyExportPreset(exportPresetSelect.value);
    });
  }

  const startExport = (format) => {
    const validation = renderExportValidation();
    if (validation.errors.length) {
      alert(validation.errors.join('\n'));
      return;
    }
    if (sessionStorage.getItem('stlt-no-sponsor') === '1') {
      handleExport(format);
      return;
    }
    const overlay = document.getElementById('sponsor-overlay');
    const closeBtn = document.getElementById('sponsor-close');
    const storeLink = overlay.querySelector('.sponsor-link');
    overlay.classList.remove('hidden');
    trapFocus(overlay);

    const dismiss = () => {
      if (document.getElementById('sponsor-dont-show').checked) {
        sessionStorage.setItem('stlt-no-sponsor', '1');
      }
      overlay.classList.add('hidden');
      handleExport(format);
    };

    closeBtn.onclick = dismiss;
    // Also start processing when the user clicks through to the store
    storeLink.onclick = () => setTimeout(dismiss, 150);
  };
  exportBtn.addEventListener('click', () => startExport('stl'));
  export3mfBtn.addEventListener('click', () => startExport('3mf'));

  // ── Wireframe ──
  wireframeToggle.addEventListener('change', () => setWireframe(wireframeToggle.checked));

  // ── Projection toggle ──
  projectionToggle.addEventListener('change', () => setProjection(projectionToggle.checked));
  applyBeginnerModeUI();

  // ── Exclusion tool wiring ─────────────────────────────────────────────────

  exclBrushBtn.addEventListener('click', () => setExclusionTool('brush'));
  exclBucketBtn.addEventListener('click', () => setExclusionTool('bucket'));

  // Shift key toggles erase mode
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && exclusionTool) eraseMode = true;
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') eraseMode = false;
  });

  exclBrushSingleBtn.addEventListener('click', () => {
    brushIsRadius = false;
    exclBrushSingleBtn.classList.add('active');
    exclBrushRadiusBtn.classList.remove('active');
    exclRadiusRow.classList.add('hidden');
    precisionMaskingRow.classList.add('hidden');
    if (precisionMaskingEnabled) deactivatePrecisionMasking();
    canvas.style.cursor = exclusionTool ? 'crosshair' : '';
    brushCursorEl.style.display = 'none';
  });

  exclBrushRadiusBtn.addEventListener('click', () => {
    brushIsRadius = true;
    exclBrushRadiusBtn.classList.add('active');
    exclBrushSingleBtn.classList.remove('active');
    if (exclusionTool === 'brush') exclRadiusRow.classList.remove('hidden');
    if (exclusionTool === 'brush') precisionMaskingRow.classList.remove('hidden');
    if (exclusionTool === 'brush') canvas.style.cursor = 'none';
  });

  exclBrushRadiusSlider.addEventListener('input', () => {
    brushRadius = parseFloat(exclBrushRadiusSlider.value) / 2;
    exclBrushRadiusVal.value = parseFloat(exclBrushRadiusSlider.value);
    checkPrecisionOutdated();
  });
  exclBrushRadiusSlider.addEventListener('dblclick', () => {
    exclBrushRadiusSlider.value = exclBrushRadiusSlider.defaultValue;
    brushRadius = parseFloat(exclBrushRadiusSlider.value) / 2;
    exclBrushRadiusVal.value = parseFloat(exclBrushRadiusSlider.value);
    checkPrecisionOutdated();
  });
  exclBrushRadiusVal.addEventListener('change', () => {
    let diam = Math.max(0.2, Math.min(100, parseFloat(exclBrushRadiusVal.value) || 10));
    brushRadius = diam / 2;
    exclBrushRadiusSlider.value = diam;
    exclBrushRadiusVal.value = diam;
    checkPrecisionOutdated();
  });
  addFineWheelSupport(exclBrushRadiusVal, (v) => {
    const diam = Math.max(0.2, Math.min(100, v));
    brushRadius = diam / 2;
    exclBrushRadiusSlider.value = diam;
    exclBrushRadiusVal.value = diam;
    checkPrecisionOutdated();
  });

  exclThresholdSlider.addEventListener('input', () => {
    bucketThreshold = parseFloat(exclThresholdSlider.value);
    exclThresholdVal.value = bucketThreshold;
    _lastHoverTriIdx = -1; // invalidate hover so next mousemove re-computes
  });
  exclThresholdSlider.addEventListener('dblclick', () => {
    exclThresholdSlider.value = exclThresholdSlider.defaultValue;
    bucketThreshold = parseFloat(exclThresholdSlider.value);
    exclThresholdVal.value = bucketThreshold;
    _lastHoverTriIdx = -1;
  });
  exclThresholdVal.addEventListener('change', () => {
    bucketThreshold = Math.max(0, Math.min(180, parseFloat(exclThresholdVal.value) || 20));
    exclThresholdSlider.value = bucketThreshold;
    exclThresholdVal.value = bucketThreshold;
    _lastHoverTriIdx = -1;
  });
  addFineWheelSupport(exclThresholdVal, (v) => {
    bucketThreshold = Math.max(0, Math.min(180, v));
    exclThresholdSlider.value = bucketThreshold;
    exclThresholdVal.value = bucketThreshold;
    _lastHoverTriIdx = -1;
  });

  exclClearBtn.addEventListener('click', () => {
    excludedFaces = new Set();
    precisionExcludedFaces = new Set();
    refreshExclusionOverlay();
  });

  exclModeExcludeBtn.addEventListener('click', () => setSelectionMode(false));
  exclModeIncludeBtn.addEventListener('click', () => setSelectionMode(true));

  // ── Precision masking wiring ──────────────────────────────────────────────
  precisionMaskingToggle.addEventListener('change', () => {
    togglePrecisionMasking(precisionMaskingToggle.checked);
  });
  precisionRefreshBtn.addEventListener('click', () => {
    refreshPrecisionMesh();
  });

  // ── Canvas mouse events for exclusion painting ────────────────────────────
  canvas.addEventListener('mousedown', (e) => {
    if (!currentGeometry || e.button !== 0) return;

    // Place on Face mode
    if (placeOnFaceActive) {
      e.preventDefault();
      handlePlaceOnFaceClick(e);
      return;
    }

    if (!exclusionTool) return;

    // Block painting while precision mesh is being built
    if (precisionBusy) return;

    if (exclusionTool === 'bucket') {
      e.preventDefault();
      _lastHoverTriIdx = -1;
      setHoverPreview(null);
      const triIdx = pickTriangle(e);
      if (triIdx >= 0) {
        const filled = bucketFill(triIdx, triangleAdjacency, bucketThreshold);
        // Bucket fill always uses original face indices
        for (const t of filled) {
          if (eraseMode) excludedFaces.delete(t); else excludedFaces.add(t);
        }
        // If precision is active, also sync to precisionExcludedFaces
        if (precisionMaskingEnabled && precisionParentMap) {
          const len = precisionParentMap.length;
          for (let i = 0; i < len; i++) {
            if (filled.has(precisionParentMap[i])) {
              if (eraseMode) precisionExcludedFaces.delete(i); else precisionExcludedFaces.add(i);
            }
          }
        }
        refreshExclusionOverlay();
        _lastHoverTriIdx = -1;
        setHoverPreview(null);
      }
    } else {
      // Brush mode: only start painting if we actually hit the mesh
      const triIdx = pickTriangle(e);
      if (triIdx < 0) return;          // miss → let OrbitControls handle the drag
      e.preventDefault();
      getControls().enabled = false;
      isPainting = true;
      _lastHoverTriIdx = -1;
      setHoverPreview(null);
      paintAt(e);
    }
  });

  // RAF-Batching: paint events fire immediately, hover/cursor batched per frame
  let _pendingHoverEvent = null;
  let _hoverRafId = 0;

  canvas.addEventListener('mousemove', (e) => {
    // Paint-Events sofort verarbeiten (jeder Event zaehlt fuer lueckenloses Malen)
    if (isPainting && exclusionTool === 'brush') {
      paintAt(e);
      // Cursor-Update kann warten
      _pendingHoverEvent = e;
      if (!_hoverRafId) {
        _hoverRafId = requestAnimationFrame(() => {
          _hoverRafId = 0;
          if (_pendingHoverEvent) updateBrushCursor(_pendingHoverEvent);
          _pendingHoverEvent = null;
        });
      }
      return;
    }
    // Alle anderen Hover-Pfade: RAF-Batching OK
    _pendingHoverEvent = e;
    if (!_hoverRafId) {
      _hoverRafId = requestAnimationFrame(() => {
        _hoverRafId = 0;
        const ev = _pendingHoverEvent;
        if (!ev) return;
        _pendingHoverEvent = null;
        if (placeOnFaceActive && currentGeometry) { updatePlaceOnFaceHover(ev); return; }
        if (exclusionTool === 'brush') {
          updateBrushCursor(ev);
          if (!isPainting && currentGeometry) updateBrushHover(ev);
          _updateShiftLinePreview(ev);
        } else if (exclusionTool === 'bucket' && !isPainting && currentGeometry) {
          updateBucketHover(ev);
        }
      });
    }
  });

  canvas.addEventListener('mouseleave', () => {
    _lastHoverTriIdx = -1;
    setHoverPreview(null);
    brushCursorEl.style.display = 'none';
  });

  document.addEventListener('mouseup', () => {
    if (!isPainting) return;
    isPainting = false;
    getControls().enabled = true;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (placeOnFaceActive) togglePlaceOnFace(false);
      if (exclusionTool) setExclusionTool(null);
      licenseOverlay.classList.add('hidden');
      imprintOverlay.classList.add('hidden');
      _clearShiftLinePreview();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control') _clearShiftLinePreview();
  });
}

// ── Exclusion helpers ─────────────────────────────────────────────────────────

function setSelectionMode(include) {
  if (selectionMode === include) return;
  selectionMode = include;
  exclModeExcludeBtn.classList.toggle('active', !selectionMode);
  exclModeIncludeBtn.classList.toggle('active', selectionMode);
  exclModeExcludeBtn.setAttribute('aria-pressed', String(!selectionMode));
  exclModeIncludeBtn.setAttribute('aria-pressed', String(selectionMode));
  if (exclusionTool) setExclusionTool(null);
  exclSectionHeading.textContent = selectionMode ? t('sections.surfaceSelection') : t('sections.surfaceMasking');
  exclHint.textContent = selectionMode
    ? t('excl.hintInclude')
    : t('excl.hintExclude');
  // Clear the painted set — faces had opposite semantics in the previous mode
  excludedFaces = new Set();
  precisionExcludedFaces = new Set();
  refreshExclusionOverlay();
}

function setExclusionTool(tool) {
  // Clicking the active tool toggles it off; passing null always deactivates
  exclusionTool = (exclusionTool === tool) ? null : tool;

  // Deactivate place-on-face if an exclusion tool is being activated
  if (exclusionTool && placeOnFaceActive) togglePlaceOnFace(false);

  // Exit 3D displacement preview when a masking tool is activated
  if (exclusionTool && settings.useDisplacement) {
    settings.useDisplacement = false;
    dispPreviewToggle.checked = false;
    toggleDisplacementPreview(false);
  }
  exclBrushBtn.classList.toggle('active', exclusionTool === 'brush');
  exclBucketBtn.classList.toggle('active', exclusionTool === 'bucket');
  // Show brush-type row only while brush is active
  exclBrushTypeRow.classList.toggle('hidden', exclusionTool !== 'brush');
  // Show radius row only while brush + radius mode is active
  exclRadiusRow.classList.toggle('hidden', !(exclusionTool === 'brush' && brushIsRadius));
  // Show precision masking row only when brush + circle mode is active
  precisionMaskingRow.classList.toggle('hidden', !(exclusionTool === 'brush' && brushIsRadius));
  // Show threshold row only while bucket is active
  exclThresholdRow.classList.toggle('hidden', exclusionTool !== 'bucket');
  canvas.style.cursor = (exclusionTool === 'brush' && brushIsRadius) ? 'none' : exclusionTool ? 'crosshair' : '';
  // Clear hover preview whenever the tool changes or is deactivated
  _lastHoverTriIdx = -1;
  setHoverPreview(null);
  // Hide brush cursor if tool deactivated or switched away from radius brush
  if (!(exclusionTool === 'brush' && brushIsRadius)) {
    brushCursorEl.style.display = 'none';
  }
  // Re-enable controls if tool was deactivated mid-paint
  if (!exclusionTool) {
    isPainting = false;
    getControls().enabled = true;
    // Recompute boundary falloff now that masking is done
    if (_falloffDirty && currentGeometry) {
      const activeGeo = (precisionMaskingEnabled && precisionGeometry)
        ? precisionGeometry
        : (settings.useDisplacement && dispPreviewGeometry)
          ? dispPreviewGeometry : currentGeometry;
      updateFaceMask(activeGeo);
    }
  }
}

const _ndcResult = new THREE.Vector2();
function _canvasNDC(e) {
  const rect = canvas.getBoundingClientRect();
  _ndcResult.set(
    ((e.clientX - rect.left) / rect.width)  *  2 - 1,
    ((e.clientY - rect.top)  / rect.height) * -2 + 1,
  );
  return _ndcResult;
}

// The preview material uses THREE.DoubleSide, so the raycaster can return
// back-face hits of adjacent triangles that are marginally closer than the
// intended front-facing triangle.  This helper returns the first hit whose
// face normal (in world space) points toward the camera ray origin.
const _normalMatrix = new THREE.Matrix3();
function getFrontFaceHit(hits, mesh) {
  if (!hits.length) return null;
  _normalMatrix.getNormalMatrix(mesh.matrixWorld);
  for (const hit of hits) {
    const wn = hit.face.normal.clone().applyMatrix3(_normalMatrix).normalize();
    if (wn.dot(_raycaster.ray.direction) < 0) return hit;
  }
  return hits[0]; // fallback — should not happen with a closed mesh
}

function pickTriangle(e) {
  const mesh = getCurrentMesh();
  if (!mesh) return -1;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) return -1;
  let fi = hit.faceIndex;
  // When displacement preview is active the mesh uses the subdivided geometry,
  // so the raycaster returns a subdivided face index.  Map it back to the
  // original face index so that excludedFaces always stores original indices.
  if (dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
    fi = dispPreviewParentMap[fi];
  }
  // Same mapping for precision masking geometry
  if (precisionGeometry && mesh.geometry === precisionGeometry && precisionParentMap) {
    fi = precisionParentMap[fi];
  }
  return fi;
}

/**
 * Squared distance from point P to the closest point on triangle ABC.
 * Uses the Voronoi-region method (no allocations, pure arithmetic).
 */
function distSqPointToTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx-ax, aby = by-ay, abz = bz-az;
  const acx = cx-ax, acy = cy-ay, acz = cz-az;
  const apx = px-ax, apy = py-ay, apz = pz-az;

  const d1 = abx*apx + aby*apy + abz*apz;
  const d2 = acx*apx + acy*apy + acz*apz;
  if (d1 <= 0 && d2 <= 0) return apx*apx + apy*apy + apz*apz; // vertex A

  const bpx = px-bx, bpy = py-by, bpz = pz-bz;
  const d3 = abx*bpx + aby*bpy + abz*bpz;
  const d4 = acx*bpx + acy*bpy + acz*bpz;
  if (d3 >= 0 && d4 <= d3) return bpx*bpx + bpy*bpy + bpz*bpz; // vertex B

  const cpx = px-cx, cpy = py-cy, cpz = pz-cz;
  const d5 = abx*cpx + aby*cpy + abz*cpz;
  const d6 = acx*cpx + acy*cpy + acz*cpz;
  if (d6 >= 0 && d5 <= d6) return cpx*cpx + cpy*cpy + cpz*cpz; // vertex C

  const vc = d1*d4 - d3*d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { // edge AB
    const v = d1 / (d1 - d3);
    const qx = ax+v*abx-px, qy = ay+v*aby-py, qz = az+v*abz-pz;
    return qx*qx + qy*qy + qz*qz;
  }

  const vb = d5*d2 - d1*d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { // edge AC
    const w = d2 / (d2 - d6);
    const qx = ax+w*acx-px, qy = ay+w*acy-py, qz = az+w*acz-pz;
    return qx*qx + qy*qy + qz*qz;
  }

  const va = d3*d6 - d5*d4;
  if (va <= 0 && (d4-d3) >= 0 && (d5-d6) >= 0) { // edge BC
    const w = (d4-d3) / ((d4-d3) + (d5-d6));
    const qx = bx+w*(cx-bx)-px, qy = by+w*(cy-by)-py, qz = bz+w*(cz-bz)-pz;
    return qx*qx + qy*qy + qz*qz;
  }

  // Inside triangle
  const den = 1 / (va + vb + vc);
  const v = vb*den, w = vc*den;
  const qx = ax+abx*v+acx*w-px, qy = ay+aby*v+acy*w-py, qz = az+abz*v+acz*w-pz;
  return qx*qx + qy*qy + qz*qz;
}

// ── Spatial grid for fast sphere queries ──────────────────────────────────

function buildSpatialGrid(centroids, triCount, bounds) {
  const vol = bounds.size.x * bounds.size.y * bounds.size.z;
  const cellSize = Math.max(Math.cbrt(vol / Math.max(triCount, 1)) * 2, 1e-6);
  _spatialCellSize = cellSize;
  _spatialMinX = bounds.min.x;
  _spatialMinY = bounds.min.y;
  _spatialMinZ = bounds.min.z;
  const grid = new Map();
  for (let t = 0; t < triCount; t++) {
    const gx = Math.floor((centroids[t*3]   - _spatialMinX) / cellSize);
    const gy = Math.floor((centroids[t*3+1] - _spatialMinY) / cellSize);
    const gz = Math.floor((centroids[t*3+2] - _spatialMinZ) / cellSize);
    const key = (gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791);
    let list = grid.get(key);
    if (!list) { list = []; grid.set(key, list); }
    list.push(t);
  }
  _spatialGrid = grid;
}

/** Test all triangles against a sphere and invoke cb(triIdx) for each hit. */
function forEachTriInSphere(hitPt, r2, cb) {
  const usePrecision = precisionMaskingEnabled && precisionGeometry;
  const geo = usePrecision ? precisionGeometry : currentGeometry;
  const centroids = usePrecision ? precisionCentroids : triangleCentroids;
  const boundRadii = usePrecision ? precisionBoundRadii : triangleBoundRadii;
  const pos = geo.attributes.position;
  const r = Math.sqrt(r2);

  if (!_spatialGrid) {
    // Fallback: linear scan (grid not built yet)
    const triCount = centroids.length / 3;
    for (let t = 0; t < triCount; t++) {
      const dx = centroids[t*3] - hitPt.x, dy = centroids[t*3+1] - hitPt.y, dz = centroids[t*3+2] - hitPt.z;
      const bound = r + boundRadii[t];
      if (dx*dx + dy*dy + dz*dz > bound*bound) continue;
      const i = t * 3;
      const d2 = distSqPointToTri(hitPt.x, hitPt.y, hitPt.z,
        pos.getX(i), pos.getY(i), pos.getZ(i),
        pos.getX(i+1), pos.getY(i+1), pos.getZ(i+1),
        pos.getX(i+2), pos.getY(i+2), pos.getZ(i+2));
      if (d2 <= r2) cb(t);
    }
    return;
  }

  const cs = _spatialCellSize;
  const xMin = Math.floor((hitPt.x - r - _spatialMinX) / cs);
  const xMax = Math.floor((hitPt.x + r - _spatialMinX) / cs);
  const yMin = Math.floor((hitPt.y - r - _spatialMinY) / cs);
  const yMax = Math.floor((hitPt.y + r - _spatialMinY) / cs);
  const zMin = Math.floor((hitPt.z - r - _spatialMinZ) / cs);
  const zMax = Math.floor((hitPt.z + r - _spatialMinZ) / cs);

  for (let gx = xMin; gx <= xMax; gx++) {
    for (let gy = yMin; gy <= yMax; gy++) {
      for (let gz = zMin; gz <= zMax; gz++) {
        const key = (gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791);
        const list = _spatialGrid.get(key);
        if (!list) continue;
        for (let li = 0; li < list.length; li++) {
          const t = list[li];
          const dx = centroids[t*3] - hitPt.x, dy = centroids[t*3+1] - hitPt.y, dz = centroids[t*3+2] - hitPt.z;
          const bound = r + boundRadii[t];
          if (dx*dx + dy*dy + dz*dz > bound*bound) continue;
          const i = t * 3;
          const d2 = distSqPointToTri(hitPt.x, hitPt.y, hitPt.z,
            pos.getX(i), pos.getY(i), pos.getZ(i),
            pos.getX(i+1), pos.getY(i+1), pos.getZ(i+1),
            pos.getX(i+2), pos.getY(i+2), pos.getZ(i+2));
          if (d2 <= r2) cb(t);
        }
      }
    }
  }
}

function _paintSingleHit(hit, mesh) {
  const usePrecision = precisionMaskingEnabled && precisionGeometry && precisionParentMap;
  if (usePrecision) {
    if (brushIsRadius) {
      const r2 = brushRadius * brushRadius;
      forEachTriInSphere(hit.point, r2, t => {
        if (eraseMode) precisionExcludedFaces.delete(t); else precisionExcludedFaces.add(t);
      });
    } else {
      const precIdx = hit.faceIndex;
      if (eraseMode) precisionExcludedFaces.delete(precIdx); else precisionExcludedFaces.add(precIdx);
    }
  } else {
    let triIdx = hit.faceIndex;
    if (dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
      triIdx = dispPreviewParentMap[triIdx];
    }
    if (brushIsRadius) {
      const r2 = brushRadius * brushRadius;
      forEachTriInSphere(hit.point, r2, t => {
        if (eraseMode) excludedFaces.delete(t); else excludedFaces.add(t);
      });
    } else {
      if (eraseMode) excludedFaces.delete(triIdx); else excludedFaces.add(triIdx);
    }
  }
}

function _paintLineBetween(from, to, mesh) {
  // Sample points along the line and paint at each
  const dist = from.distanceTo(to);
  const step = brushIsRadius ? Math.max(brushRadius * 0.5, 0.1) : 0.5;
  const steps = Math.max(Math.ceil(dist / step), 1);
  const dir = new THREE.Vector3().subVectors(to, from);
  const cam = getCamera();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pt = new THREE.Vector3().lerpVectors(from, to, t);
    // Project 3D point to screen, then raycast back to find mesh hit
    const ndc = pt.clone().project(cam);
    _raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cam);
    const hits = _raycaster.intersectObject(mesh);
    const hit = getFrontFaceHit(hits, mesh);
    if (hit) _paintSingleHit(hit, mesh);
  }
}

function paintAt(e) {
  const mesh = getCurrentMesh();
  if (!mesh) return;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) return;

  // Shift+click: draw line from last paint point to current
  if (e.ctrlKey && _lastPaintHitPoint) {
    _paintLineBetween(_lastPaintHitPoint, hit.point, mesh);
    _clearShiftLinePreview();
  } else {
    _paintSingleHit(hit, mesh);
  }

  _lastPaintHitPoint = hit.point.clone();
  refreshExclusionOverlay();
}

// ── Place on Face ─────────────────────────────────────────────────────────────

// ── Shift-line preview for brush painting ─────────────────────────────────

function _updateShiftLinePreview(e) {
  if (!e.ctrlKey || !_lastPaintHitPoint || !exclusionTool || exclusionTool !== 'brush') {
    _clearShiftLinePreview();
    return;
  }
  const mesh = getCurrentMesh();
  if (!mesh) return;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) { _clearShiftLinePreview(); return; }

  const points = [_lastPaintHitPoint, hit.point];
  if (_shiftLineMesh) {
    _shiftLineMesh.geometry.setFromPoints(points);
    _shiftLineMesh.geometry.attributes.position.needsUpdate = true;
  } else {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color: 0x00ffaa, linewidth: 2, depthTest: false });
    _shiftLineMesh = new THREE.Line(geo, mat);
    _shiftLineMesh.renderOrder = 999;
    const scene = mesh.parent.parent; // meshGroup → scene
    if (scene) scene.add(_shiftLineMesh);
  }
  requestRender();
}

function _clearShiftLinePreview() {
  if (_shiftLineMesh) {
    if (_shiftLineMesh.parent) _shiftLineMesh.parent.remove(_shiftLineMesh);
    _shiftLineMesh.geometry.dispose();
    _shiftLineMesh.material.dispose();
    _shiftLineMesh = null;
    requestRender();
  }
}

// ── Place on Face ─────────────────────────────────────────────────────────────

function togglePlaceOnFace(active) {
  placeOnFaceActive = active;
  placeOnFaceBtn.classList.toggle('active', active);

  if (active) {
    // Deactivate exclusion tool
    if (exclusionTool) setExclusionTool(null);
    // Deactivate precision masking (geometry will be rotated/replaced)
    if (precisionMaskingEnabled) deactivatePrecisionMasking();
    canvas.style.cursor = 'crosshair';
  } else {
    if (!exclusionTool) canvas.style.cursor = '';
    _lastHoverTriIdx = -1;
    setHoverPreview(null);
  }
}

function updatePlaceOnFaceHover(e) {
  const mesh = getCurrentMesh();
  if (!mesh) { setHoverPreview(null); return; }
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) { _lastHoverTriIdx = -1; setHoverPreview(null); return; }

  let triIdx = hit.faceIndex;
  if (dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
    triIdx = dispPreviewParentMap[triIdx];
  }
  if (triIdx === _lastHoverTriIdx) return;
  _lastHoverTriIdx = triIdx;
  setHoverPreview(buildExclusionOverlayGeo(currentGeometry, new Set([triIdx])));
}

function handlePlaceOnFaceClick(e) {
  const mesh = getCurrentMesh();
  if (!mesh) return;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) return;

  // Get the face normal (mesh has identity transform)
  const faceNormal = hit.face.normal.clone().normalize();

  // Compute quaternion that rotates faceNormal to -Z (face down on print bed)
  const targetDir = new THREE.Vector3(0, 0, -1);
  const quat = new THREE.Quaternion().setFromUnitVectors(faceNormal, targetDir);

  // Apply rotation to all vertex positions
  const pos = currentGeometry.attributes.position.array;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) {
    v.set(pos[i], pos[i + 1], pos[i + 2]);
    v.applyQuaternion(quat);
    pos[i]     = v.x;
    pos[i + 1] = v.y;
    pos[i + 2] = v.z;
  }

  // Re-center geometry
  currentGeometry.computeBoundingBox();
  const center = new THREE.Vector3();
  currentGeometry.boundingBox.getCenter(center);
  currentGeometry.translate(-center.x, -center.y, -center.z);

  // Recompute normals from scratch (fixes lighting + angle masking)
  currentGeometry.computeVertexNormals();
  // Delete stale faceNormal attribute so updateFaceMask() recomputes it
  // from the new rotated positions (needed for correct angle masking in 2D preview)
  if (currentGeometry.attributes.faceNormal) {
    currentGeometry.deleteAttribute('faceNormal');
  }

  // Now reload as if this were a freshly loaded STL
  currentBounds = computeBounds(currentGeometry);
  checkAmplitudeWarning();
  checkResolutionWarning();

  // Dispose old preview material so it gets fully recreated
  if (previewMaterial) {
    previewMaterial.dispose();
    previewMaterial = null;
  }

  loadGeometry(currentGeometry);

  // Reset displacement preview
  if (dispPreviewGeometry) { dispPreviewGeometry.dispose(); dispPreviewGeometry = null; }
  settings.useDisplacement = false;
  dispPreviewToggle.checked = false;

  // Reset precision masking (geometry was rotated)
  if (precisionGeometry) { precisionGeometry.dispose(); precisionGeometry = null; }
  precisionParentMap = null; precisionEdgeLength = null;
  precisionCentroids = null; precisionBoundRadii = null; precisionAdjacency = null;
  precisionMaskingEnabled = false; precisionMaskingToggle.checked = false;
  precisionStatus.textContent = '';
  precisionOutdated.classList.add('hidden'); precisionRefreshBtn.classList.add('hidden');
  precisionWarning.classList.add('hidden'); precisionMaskingRow.classList.add('hidden');
  precisionExcludedFaces = new Set();

  // Deactivate tools but keep excludedFaces (face indices are stable after rotation)
  exclusionTool     = null;
  eraseMode         = false;
  isPainting        = false;
  exclBrushBtn.classList.remove('active');
  exclBucketBtn.classList.remove('active');
  exclBrushTypeRow.classList.add('hidden');
  exclRadiusRow.classList.add('hidden');
  exclThresholdRow.classList.add('hidden');
  canvas.style.cursor = '';
  setHoverPreview(null);
  _lastHoverTriIdx = -1;

  // Rebuild adjacency
  const adjData = buildAdjacency(currentGeometry);
  triangleAdjacency = adjData.adjacency;
  triangleCentroids = adjData.centroids; triangleBoundRadii = adjData.boundRadii;
  buildSpatialGrid(triangleCentroids, currentGeometry.attributes.position.count / 3, currentBounds);

  // Update edge length for new bounds
  const diag = Math.sqrt(currentBounds.size.x ** 2 + currentBounds.size.y ** 2 + currentBounds.size.z ** 2);
  const defaultEdge = Math.max(0.05, Math.min(5.0, +(diag / 300).toFixed(2)));
  settings.refineLength = defaultEdge;
  refineLenSlider.value = defaultEdge;
  refineLenVal.value = defaultEdge;
  checkResolutionWarning();

  // Update mesh info
  const triCount = getTriangleCount(currentGeometry);
  const mb = ((currentGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
  const sx = currentBounds.size.x.toFixed(2);
  const sy = currentBounds.size.y.toFixed(2);
  const sz = currentBounds.size.z.toFixed(2);
  meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

  exportBtn.disabled = (activeMapEntry === null);
  export3mfBtn.disabled = (activeMapEntry === null);
  updatePreview();

  // Rebuild exclusion overlay with new vertex positions (face indices unchanged)
  if (excludedFaces.size > 0) {
    refreshExclusionOverlay();
  } else {
    setExclusionOverlay(null);
  }

  // Exit place-on-face mode
  togglePlaceOnFace(false);
}

function refreshExclusionOverlay() {
  if (!currentGeometry) return;

  // Choose which geometry and face set to build the overlay from
  const usePrecision = precisionMaskingEnabled && precisionGeometry;
  const overlayGeo = usePrecision ? precisionGeometry : currentGeometry;
  const overlayFaceSet = usePrecision ? precisionExcludedFaces : excludedFaces;

  _falloffDirty = true;

  // Never show the flat-coloured MeshLambertMaterial overlay — the custom
  // shader handles mask visualisation with smooth, view-dependent shading.
  setExclusionOverlay(null);
  const n = usePrecision ? precisionExcludedFaces.size : excludedFaces.size;
  exclCount.textContent = selectionMode
    ? t(n === 1 ? 'excl.faceSelected' : 'excl.facesSelected', { n: n.toLocaleString() })
    : t(n === 1 ? 'excl.faceExcluded' : 'excl.facesExcluded', { n: n.toLocaleString() });

  // Update the faceMask attribute on the active preview geometry so the shader
  // reflects user-painted exclusions in real time.
  const activeGeo = usePrecision
    ? precisionGeometry
    : (settings.useDisplacement && dispPreviewGeometry)
      ? dispPreviewGeometry : currentGeometry;
  updateFaceMask(activeGeo);
}

function updateBrushCursor(e) {
  if (!brushIsRadius || !currentGeometry) {
    brushCursorEl.style.display = 'none';
    return;
  }
  const mesh = getCurrentMesh();
  if (!mesh) { brushCursorEl.style.display = 'none'; return; }
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const frontHit = getFrontFaceHit(hits, mesh);
  if (!frontHit) { brushCursorEl.style.display = 'none'; return; }

  const hitPt = frontHit.point;
  const cam   = getCamera();

  // Offset the hit point by brushRadius along the camera's right axis
  // then project both to screen space to get pixel-accurate circle size
  const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
  const edgePt   = hitPt.clone().addScaledVector(camRight, brushRadius);

  const rect  = canvas.getBoundingClientRect();
  const toScreen = (v) => {
    const c = v.clone().project(cam);
    return {
      x: (c.x * 0.5 + 0.5) * rect.width,
      y: (1 - (c.y * 0.5 + 0.5)) * rect.height,
    };
  };

  const sc = toScreen(hitPt);
  const se = toScreen(edgePt);
  const screenRadius = Math.sqrt((se.x - sc.x) ** 2 + (se.y - sc.y) ** 2);
  const diam = screenRadius * 2;

  brushCursorEl.style.display = 'block';
  brushCursorEl.style.left    = `${rect.left + sc.x - screenRadius}px`;
  brushCursorEl.style.top     = `${rect.top  + sc.y - screenRadius}px`;
  brushCursorEl.style.width   = `${diam}px`;
  brushCursorEl.style.height  = `${diam}px`;
}

function updateBrushHover(e) {
  const mesh = getCurrentMesh();
  if (!mesh) { setHoverPreview(null); return; }
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) { _lastHoverTriIdx = -1; setHoverPreview(null); return; }

  // Use raw face index for cache when precision is active (small faces → frequent updates)
  const usePrecision = precisionMaskingEnabled && precisionGeometry && precisionParentMap;
  let triIdx = hit.faceIndex;
  if (!usePrecision) {
    if (dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
      triIdx = dispPreviewParentMap[triIdx];
    }
  }
  if (triIdx === _lastHoverTriIdx) return;
  _lastHoverTriIdx = triIdx;

  const hoverGeo = usePrecision ? precisionGeometry : currentGeometry;
  const hoverColor = eraseMode ? 0x999999 : 0xffee00;
  if (brushIsRadius) {
    const r2 = brushRadius * brushRadius;
    const hovered = new Set();
    forEachTriInSphere(hit.point, r2, t => hovered.add(t));
    setHoverPreview(buildExclusionOverlayGeo(hoverGeo, hovered), hoverColor);
  } else {
    // For single mode with precision, find the refined face index for the hover highlight
    if (usePrecision) {
      const rawIdx = hit.faceIndex;
      const hovered = new Set([rawIdx]);
      setHoverPreview(buildExclusionOverlayGeo(precisionGeometry, hovered), hoverColor);
    } else {
      const hovered = new Set([triIdx]);
      setHoverPreview(buildExclusionOverlayGeo(currentGeometry, hovered), hoverColor);
    }
  }
}

function updateBucketHover(e) {
  const triIdx = pickTriangle(e);
  if (triIdx === _lastHoverTriIdx) return; // unchanged — skip expensive BFS
  _lastHoverTriIdx = triIdx;
  if (triIdx < 0 || !triangleAdjacency) {
    setHoverPreview(null);
    return;
  }
  const hovered = bucketFill(triIdx, triangleAdjacency, bucketThreshold);
  const usePrecision = precisionMaskingEnabled && precisionGeometry && precisionParentMap;
  if (usePrecision) {
    // Map original face indices to precision face indices for overlay
    const refinedHover = new Set();
    const len = precisionParentMap.length;
    for (let i = 0; i < len; i++) {
      if (hovered.has(precisionParentMap[i])) refinedHover.add(i);
    }
    setHoverPreview(buildExclusionOverlayGeo(precisionGeometry, refinedHover), eraseMode ? 0x999999 : 0xffee00);
  } else {
    setHoverPreview(buildExclusionOverlayGeo(currentGeometry, hovered), eraseMode ? 0x999999 : 0xffee00);
  }
}

// ── Slider helper ─────────────────────────────────────────────────────────────

const INPUT_WHEEL_DECIMALS = 3;
function getInputPrecision(input) {
  const configured = parseInt(input.dataset.wheelDecimals, 10);
  if (!isNaN(configured) && configured >= 0) return configured;
  const step = input.step;
  if (step === 'any') return INPUT_WHEEL_DECIMALS;
  const stepNum = parseFloat(step);
  if (isNaN(stepNum)) return INPUT_WHEEL_DECIMALS;
  if (Number.isInteger(stepNum)) return 0;
  const frac = step.includes('.') ? step.split('.')[1].replace(/0+$/, '').length : 0;
  return Math.max(INPUT_WHEEL_DECIMALS, frac);
}

function roundToPrecision(value, precision) {
  if (precision <= 0) return Math.round(value);
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clampToInputBounds(input, value) {
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  let clamped = value;
  if (!isNaN(min)) clamped = Math.max(min, clamped);
  if (!isNaN(max)) clamped = Math.min(max, clamped);
  return clamped;
}

function formatInputValue(input, value) {
  const precision = getInputPrecision(input);
  if (precision <= 0) return String(Math.round(value));
  return value.toFixed(precision).replace(/\.?0+$/, '');
}

function addFineWheelSupport(input, applyFn) {
  input.addEventListener('wheel', (e) => {
    if (input.disabled || input.readOnly) return;
    e.preventDefault();
    input.focus({ preventScroll: true });

    const precision = getInputPrecision(input);

    let step = precision <= 0 ? 1 : 1 / (10 ** precision);

   
    if (e.shiftKey) {
      step *= 10;        // faster
    } else if (e.ctrlKey || e.metaKey) {
      step *= 0.1;       // ultra fine 
    }

    const current = parseFloat(input.value);
    const fallback = parseFloat(input.defaultValue || input.min || '0');
    const base = isNaN(current) ? (isNaN(fallback) ? 0 : fallback) : current;

    const direction = e.deltaY < 0 ? 1 : -1;
    const next = clampToInputBounds(
      input,
      roundToPrecision(base + direction * step, precision + 2) 
    );

    applyFn(next);
  }, { passive: false });
}

function applyExportPreset(presetKey) {
  const nextSettings = derivePresetSettings(settings, presetKey);
  if (!nextSettings) return;
  settings.vaseModeSafe = nextSettings.vaseModeSafe;
  if (vaseModeSafeToggle) vaseModeSafeToggle.checked = settings.vaseModeSafe;
  settings.refineLength = nextSettings.refineLength;
  settings.maxTriangles = nextSettings.maxTriangles;
  refineLenSlider.value = nextSettings.refineLength;
  refineLenVal.value = formatInputValue(refineLenVal, nextSettings.refineLength);
  maxTriSlider.value = nextSettings.maxTriangles;
  maxTriVal.textContent = formatM(nextSettings.maxTriangles);
  checkResolutionWarning();
  renderExportValidation();
  clearTimeout(previewDebounce);
  previewDebounce = setTimeout(updatePreview, 80);
}

function linkSlider(slider, valInput, onChangeFn, livePreview = true) {
  const isSpan = valInput.tagName === 'SPAN';
  const applyLinkedValue = (raw) => {
    const clamped = clampToInputBounds(valInput, raw);
    slider.value = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), clamped));
    onChangeFn(clamped);
    valInput.value = formatInputValue(valInput, clamped);
    if (livePreview) {
      clearTimeout(previewDebounce);
      previewDebounce = setTimeout(updatePreview, 80);
    }
  };
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    const display = onChangeFn(v);
    if (isSpan) valInput.textContent = display; else valInput.value = display;
    if (livePreview) {
      clearTimeout(previewDebounce);
      previewDebounce = setTimeout(updatePreview, 80);
    }
  });
  // Double-click resets to default value
  slider.addEventListener('dblclick', () => {
    slider.value = slider.defaultValue;
    const v = parseFloat(slider.value);
    const display = onChangeFn(v);
    if (isSpan) valInput.textContent = display; else valInput.value = display;
    if (livePreview) {
      clearTimeout(previewDebounce);
      previewDebounce = setTimeout(updatePreview, 80);
    }
  });
  if (!isSpan) {
    valInput.addEventListener('change', () => {
      const raw = parseFloat(valInput.value);
      if (isNaN(raw)) { valInput.value = formatInputValue(valInput, parseFloat(slider.value)); return; }
      applyLinkedValue(raw);
    });
    addFineWheelSupport(valInput, applyLinkedValue);
  }
}

function formatM(n) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M`
       : n >= 1_000    ? `${(n / 1_000).toFixed(0)} k`
       : String(n);
}

// ── STL loading ───────────────────────────────────────────────────────────────

function loadDefaultCube() {
  // Create a 50×50×50 mm box; convert to non-indexed so it behaves like a
  // real STL (buildAdjacency and displacement expect non-indexed geometry).
  const geo = new THREE.BoxGeometry(50, 50, 50).toNonIndexed();
  geo.computeBoundingBox();
  geo.computeVertexNormals();

  // Invalidate any in-flight async operations tied to the previous model
  precisionToken++;
  dispPreviewToken++;
  exportToken++;

  currentGeometry = geo;
  currentBounds   = computeBounds(geo);
  currentStlName  = 'cube_50x50x50';
  lastVaseMetrics = null;
  vaseValidationCache = { key: '', metrics: null };
  checkAmplitudeWarning();

  loadGeometry(geo);
  dropHint.classList.add('hidden');

  // Reset displacement preview
  if (dispPreviewGeometry) { dispPreviewGeometry.dispose(); dispPreviewGeometry = null; }
  settings.useDisplacement = false;
  dispPreviewToggle.checked = false;

  // Reset exclusion state
  excludedFaces     = new Set();
  exclusionTool     = null;
  eraseMode         = false;
  isPainting        = false;
  if (placeOnFaceActive) togglePlaceOnFace(false);
  exclBrushBtn.classList.remove('active');
  exclBucketBtn.classList.remove('active');
  exclBrushTypeRow.classList.add('hidden');
  exclRadiusRow.classList.add('hidden');
  exclThresholdRow.classList.add('hidden');
  canvas.style.cursor = '';
  setExclusionOverlay(null);
  setHoverPreview(null);
  _lastHoverTriIdx = -1;
  exclCount.textContent = t('excl.initExcluded');

  const adjData = buildAdjacency(geo);
  triangleAdjacency = adjData.adjacency;
  triangleCentroids = adjData.centroids; triangleBoundRadii = adjData.boundRadii;
  buildSpatialGrid(triangleCentroids, geo.attributes.position.count / 3, currentBounds);

  settings.scaleU  = 0.5; scaleUSlider.value = scaleToPos(0.5); scaleUVal.value = 0.5;
  settings.scaleV  = 0.5; scaleVSlider.value = scaleToPos(0.5); scaleVVal.value = 0.5;
  settings.offsetU = 0; offsetUSlider.value = 0; offsetUVal.value = 0;
  settings.offsetV = 0; offsetVSlider.value = 0; offsetVVal.value = 0;
  triLimitWarning.classList.add('hidden');

  const diag = Math.sqrt(currentBounds.size.x ** 2 + currentBounds.size.y ** 2 + currentBounds.size.z ** 2);
  const defaultEdge = Math.max(0.05, Math.min(5.0, +(diag / 250).toFixed(2)));
  settings.refineLength = defaultEdge;
  refineLenSlider.value = defaultEdge;
  refineLenVal.value = defaultEdge;
  checkResolutionWarning();

  const triCount = getTriangleCount(geo);
  const mb = ((geo.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
  const sx = currentBounds.size.x.toFixed(2);
  const sy = currentBounds.size.y.toFixed(2);
  const sz = currentBounds.size.z.toFixed(2);
  meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

  exportBtn.disabled = (activeMapEntry === null);
  export3mfBtn.disabled = (activeMapEntry === null);
  updatePreview();
}

async function handleModelFile(file) {
  try {
    const { geometry, bounds, nanCount, degenerateCount } = await loadModelFile(file);

    // Invalidate any in-flight async operations tied to the previous model
    precisionToken++;
    dispPreviewToken++;
    exportToken++;
    diagToken++;

    currentGeometry = geometry;
    currentBounds   = bounds;
    currentStlName  = file.name.replace(/\.(stl|obj|3mf)$/i, '');
    lastVaseMetrics = null;
    vaseValidationCache = { key: '', metrics: null };
    checkAmplitudeWarning();

    // Log (but don't block the user with an alert) if bad triangles were
    // silently removed during load — this is non-critical; the all-invalid
    // case is already thrown as an error by validateAndCleanGeometry.
    const removedCount = (nanCount ?? 0) + (degenerateCount ?? 0);
    if (removedCount > 0) {
      console.warn(`Removed ${nanCount} NaN and ${degenerateCount} degenerate triangles at load time`);
    }

    // Dispose old preview material and reset state for the new mesh
    if (previewMaterial) {
      previewMaterial.dispose();
      previewMaterial = null;
    }

    // Auto-select first preset on first load
    if (!activeMapEntry && PRESETS.length > 0) {
      const idx = PRESETS.findIndex(p => p != null);
      if (idx >= 0) {
        const swatches = document.querySelectorAll('.preset-swatch');
        if (swatches[idx]) selectPreset(idx, swatches[idx]);
      }
    }
    mappingSelect.value = String(settings.mappingMode);
    capAngleRow.style.display = settings.mappingMode === 3 ? '' : 'none';

    // Show mesh with a default material until a map is selected
    loadGeometry(geometry);
    dropHint.classList.add('hidden');

    // Reset displacement preview for the new mesh
    if (dispPreviewGeometry) { dispPreviewGeometry.dispose(); dispPreviewGeometry = null; }
    settings.useDisplacement = false;
    dispPreviewToggle.checked = false;

    // Reset precision masking for the new mesh
    if (precisionGeometry) { precisionGeometry.dispose(); precisionGeometry = null; }
    precisionParentMap  = null;
    precisionEdgeLength = null;
    precisionCentroids  = null;
    precisionBoundRadii = null;
    precisionAdjacency  = null;
    precisionMaskingEnabled = false;
    precisionMaskingToggle.checked = false;
    precisionStatus.textContent = '';
    precisionOutdated.classList.add('hidden');
    precisionRefreshBtn.classList.add('hidden');
    precisionWarning.classList.add('hidden');
    precisionMaskingRow.classList.add('hidden');

    // Reset mesh diagnostics for the new mesh
    meshDiagnostics.classList.add('hidden');
    meshDiagAdvanced.classList.add('hidden');
    lastFastDiag = null;
    lastAdvancedDiag = null;
    activeAnalysisOverlays.signedDisplacement = false;
    activeAnalysisOverlays.triangleDensity = false;
    if (diagSignedDispToggle) diagSignedDispToggle.checked = false;
    if (diagTriDensityToggle) diagTriDensityToggle.checked = false;
    clearDiagHighlight();

    // Reset exclusion state for the new mesh
    excludedFaces     = new Set();
    precisionExcludedFaces = new Set();
    exclusionTool     = null;
    eraseMode         = false;
    isPainting        = false;
    if (placeOnFaceActive) togglePlaceOnFace(false);
    exclBrushBtn.classList.remove('active');
    exclBucketBtn.classList.remove('active');
    exclBrushTypeRow.classList.add('hidden');
    exclRadiusRow.classList.add('hidden');
    exclThresholdRow.classList.add('hidden');
    canvas.style.cursor = '';
    setExclusionOverlay(null);
    setHoverPreview(null);
    _lastHoverTriIdx = -1;
    exclCount.textContent = t('excl.initExcluded');
    // Build adjacency data for brush/bucket tools (synchronous; fast enough for
    // typical STL sizes processed by this tool)
    const adjData = buildAdjacency(geometry);
    triangleAdjacency = adjData.adjacency;
    triangleCentroids = adjData.centroids; triangleBoundRadii = adjData.boundRadii;
    buildSpatialGrid(triangleCentroids, geometry.attributes.position.count / 3, bounds);
    updateMeshDiagnostics(adjData, geometry.attributes.position.count / 3);

    // Reset scale & offset sliders so scale=1 = one tile covers the full bounding box
    const resetVal = (slider, valEl, value) => {
      slider.value = value;
      valEl.value = value;
    };
    settings.scaleU  = 0.5; scaleUSlider.value = scaleToPos(0.5); scaleUVal.value = 0.5;
    settings.scaleV  = 0.5; scaleVSlider.value = scaleToPos(0.5); scaleVVal.value = 0.5;
    settings.offsetU = 0; resetVal(offsetUSlider, offsetUVal, 0);
    settings.offsetV = 0; resetVal(offsetVSlider, offsetVVal, 0);
    triLimitWarning.classList.add('hidden');

    // Default edge length = 1/250 of the bounding box diagonal
    const diag = Math.sqrt(bounds.size.x ** 2 + bounds.size.y ** 2 + bounds.size.z ** 2);
    const defaultEdge = Math.max(0.05, Math.min(5.0, +(diag / 250).toFixed(2)));
    settings.refineLength = defaultEdge;
    refineLenSlider.value = defaultEdge;
    refineLenVal.value = defaultEdge;
    checkResolutionWarning();

    const triCount = getTriangleCount(geometry);
    const mb = ((geometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
    const sx = bounds.size.x.toFixed(2);
    const sy = bounds.size.y.toFixed(2);
    const sz = bounds.size.z.toFixed(2);
    meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

    exportBtn.disabled = (activeMapEntry === null);
    export3mfBtn.disabled = (activeMapEntry === null);
    updatePreview();
  } catch (err) {
    console.error('Failed to load model:', err);
    alert(t('alerts.loadFailed', { msg: err.message }));
  }
}

// ── Live preview ──────────────────────────────────────────────────────────────

function checkAmplitudeWarning() {
  if (!currentBounds) return;
  const minDim = Math.min(currentBounds.size.x, currentBounds.size.y, currentBounds.size.z);
  const danger = Math.abs(settings.amplitude) > minDim * 0.1;
  amplitudeWarning.classList.toggle('hidden', !danger);
  amplitudeSlider.classList.toggle('amp-danger', danger);
  amplitudeVal.classList.toggle('amp-danger', danger);
}

// Shell colours — evenly spaced hues, high saturation
const SHELL_COLORS = [0xe6194b, 0x3cb44b, 0x4363d8, 0xf58231, 0x911eb4, 0x42d4f4, 0xf032e6, 0xbfef45, 0xfabed4, 0xdcbeff, 0x9a6324, 0x800000, 0xaaffc3, 0x808000, 0x000075, 0xa9a9a9];

/**
 * Determine the worst severity across fast + advanced diagnostics and apply it
 * to the popup container.  'error' > 'warn' > 'ok'.
 */
function applyDiagSeverity() {
  let severity = 'ok';
  if (lastFastDiag) {
    if (lastFastDiag.openEdges > 0 || lastFastDiag.nonManifoldEdges > 0) severity = 'error';
    else if (lastFastDiag.shellCount > 1 && severity !== 'error') severity = 'warn';
  }
  if (lastAdvancedDiag) {
    if (lastAdvancedDiag.intersectingPairs > 0) severity = 'error';
    else if (lastAdvancedDiag.overlappingPairs > 0 && severity !== 'error') severity = 'warn';
  }
  meshDiagnostics.classList.remove('diag-ok', 'diag-warn', 'diag-error');
  meshDiagnostics.classList.add('diag-' + severity);
}

function clearDiagHighlight() {
  activeDiagHighlight = null;
  // Reset all toggle buttons in the popup
  meshDiagnostics.querySelectorAll('.diag-show-btn').forEach(btn => {
    btn.textContent = t('diag.show');
  });
  refreshDiagOverlays();
}

function _buildSignedDisplacementOverlayGeo() {
  if (!currentGeometry?.attributes?.position || !activeMapEntry?.imageData || !currentBounds) return null;
  const srcPos = currentGeometry.attributes.position.array;
  const srcNrm = currentGeometry.attributes.normal ? currentGeometry.attributes.normal.array : null;
  const triVerts = currentGeometry.attributes.position.count;
  if (!triVerts) return null;

  const outPos = new Float32Array(srcPos);
  const outNrm = srcNrm ? new Float32Array(srcNrm) : null;
  const outCol = new Float32Array(triVerts * 3);
  const tmpPos = new THREE.Vector3();
  const tmpNrm = new THREE.Vector3();
  const { imageData, width, height } = activeMapEntry;
  const mapData = imageData.data;
  const texMax = Math.max(width, height, 1);
  const uvSettings = {
    ...settings,
    textureAspectU: texMax / Math.max(width, 1),
    textureAspectV: texMax / Math.max(height, 1),
  };

  const maxAbsDisp = Math.max(Math.abs(settings.amplitude), 1e-6);
  for (let i = 0; i < triVerts; i++) {
    tmpPos.fromArray(srcPos, i * 3);
    if (srcNrm) tmpNrm.fromArray(srcNrm, i * 3);
    else tmpNrm.set(0, 0, 1);
    const uv = computeUV(tmpPos, tmpNrm, settings.mappingMode, uvSettings, currentBounds);
    let grey = 0;
    if (uv.triplanar) {
      for (const s of uv.samples) grey += _sampleBilinearGrey(mapData, width, height, s.u, s.v) * s.w;
    } else {
      grey = _sampleBilinearGrey(mapData, width, height, uv.u, uv.v);
    }
    const signedDisp = (settings.symmetricDisplacement ? (grey - 0.5) : grey) * settings.amplitude;
    const signedNorm = THREE.MathUtils.clamp(signedDisp / maxAbsDisp, -1, 1);
    const color = _signedHeatColor(signedNorm);
    outCol[i * 3] = color.r;
    outCol[i * 3 + 1] = color.g;
    outCol[i * 3 + 2] = color.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  if (outNrm) geo.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(outCol, 3));
  return geo;
}

function _buildTriangleDensityOverlayGeo() {
  if (!currentGeometry?.attributes?.position) return null;
  const srcPos = currentGeometry.attributes.position.array;
  const srcNrm = currentGeometry.attributes.normal ? currentGeometry.attributes.normal.array : null;
  const triCount = srcPos.length / 9;
  if (!triCount) return null;

  const outPos = new Float32Array(srcPos);
  const outNrm = srcNrm ? new Float32Array(srcNrm) : null;
  const outCol = new Float32Array((srcPos.length / 3) * 3);
  const areas = new Float32Array(triCount);
  let minArea = Infinity;
  let maxArea = 0;

  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const ax = srcPos[b], ay = srcPos[b + 1], az = srcPos[b + 2];
    const bx = srcPos[b + 3], by = srcPos[b + 4], bz = srcPos[b + 5];
    const cx = srcPos[b + 6], cy = srcPos[b + 7], cz = srcPos[b + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const crx = aby * acz - abz * acy;
    const cry = abz * acx - abx * acz;
    const crz = abx * acy - aby * acx;
    const area = 0.5 * Math.sqrt(crx * crx + cry * cry + crz * crz);
    areas[t] = area;
    if (area < minArea) minArea = area;
    if (area > maxArea) maxArea = area;
  }

  const safeMin = Math.max(minArea, 1e-12);
  const safeMax = Math.max(maxArea, safeMin + 1e-12);
  const logMin = Math.log(safeMin);
  const logRange = Math.max(1e-12, Math.log(safeMax) - logMin);
  for (let t = 0; t < triCount; t++) {
    const risk = THREE.MathUtils.clamp((Math.log(Math.max(areas[t], 1e-12)) - logMin) / logRange, 0, 1);
    const color = _signedHeatColor(risk * 2 - 1);
    const vBase = t * 9;
    for (let k = 0; k < 3; k++) {
      const cIdx = vBase + k * 3;
      outCol[cIdx] = color.r;
      outCol[cIdx + 1] = color.g;
      outCol[cIdx + 2] = color.b;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  if (outNrm) geo.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(outCol, 3));
  return geo;
}

function _sampleBilinearGrey(data, w, h, u, v) {
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;
  v = 1 - v;
  const fx = u * (w - 1);
  const fy = v * (h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = data[(y0 * w + x0) * 4] / 255;
  const v10 = data[(y0 * w + x1) * 4] / 255;
  const v01 = data[(y1 * w + x0) * 4] / 255;
  const v11 = data[(y1 * w + x1) * 4] / 255;
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

function _signedHeatColor(normVal) {
  const t = THREE.MathUtils.clamp(normVal, -1, 1);
  const neutral = new THREE.Color(0xcbd5e1);
  const cold = new THREE.Color(0x1d4ed8);
  const hot = new THREE.Color(0xdc2626);
  return t < 0 ? neutral.clone().lerp(cold, -t) : neutral.clone().lerp(hot, t);
}

function refreshDiagOverlays() {
  clearDiagOverlays();

  // Reset all buttons then mark the active one
  meshDiagnostics.querySelectorAll('.diag-show-btn').forEach(btn => {
    btn.textContent = (btn.dataset.kind === activeDiagHighlight) ? t('diag.hide') : t('diag.show');
  });

  if (!currentGeometry) return;

  if (activeAnalysisOverlays.signedDisplacement) {
    const dispGeo = _buildSignedDisplacementOverlayGeo();
    if (dispGeo) addDiagFaces(dispGeo, 0xffffff, 0.75, true, true);
  }
  if (activeAnalysisOverlays.triangleDensity) {
    const densityGeo = _buildTriangleDensityOverlayGeo();
    if (densityGeo) addDiagFaces(densityGeo, 0xffffff, 0.65, true, true);
  }

  const kind = activeDiagHighlight;
  if (!kind) return;

  if (kind === 'openEdges' || kind === 'nonManifold') {
    const edgeData = getEdgePositions(currentGeometry);
    const positions = kind === 'openEdges' ? edgeData.open : edgeData.nonManifold;
    setDiagEdges(positions, 0xff0000);
  } else if (kind === 'shells') {
    const shellIds = getShellAssignments(triangleAdjacency, currentGeometry.attributes.position.count / 3);
    const shellCount = lastFastDiag ? lastFastDiag.shellCount : 0;
    const srcPos = currentGeometry.attributes.position.array;
    const srcNrm = currentGeometry.attributes.normal ? currentGeometry.attributes.normal.array : null;
    const triCount = srcPos.length / 9;

    for (let s = 0; s < shellCount; s++) {
      // Count triangles in this shell
      let count = 0;
      for (let tt = 0; tt < triCount; tt++) if (shellIds[tt] === s) count++;
      const outPos = new Float32Array(count * 9);
      const outNrm = srcNrm ? new Float32Array(count * 9) : null;
      let dst = 0;
      for (let tt = 0; tt < triCount; tt++) {
        if (shellIds[tt] !== s) continue;
        const src = tt * 9;
        outPos.set(srcPos.subarray(src, src + 9), dst);
        if (outNrm) outNrm.set(srcNrm.subarray(src, src + 9), dst);
        dst += 9;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
      if (outNrm) geo.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
      addDiagFaces(geo, SHELL_COLORS[s % SHELL_COLORS.length], 0.55);
    }
  } else if (kind === 'intersects' && lastAdvancedDiag && lastAdvancedDiag.intersectFaces) {
    const geo = buildExclusionOverlayGeo(currentGeometry, lastAdvancedDiag.intersectFaces);
    addDiagFaces(geo, 0xff0000, 0.7, true);
  } else if (kind === 'overlaps' && lastAdvancedDiag && lastAdvancedDiag.overlapFaces) {
    const geo = buildExclusionOverlayGeo(currentGeometry, lastAdvancedDiag.overlapFaces);
    addDiagFaces(geo, 0xf59e0b, 0.7);
  }
}

function toggleDiagHighlight(kind) {
  if (activeDiagHighlight === kind) {
    clearDiagHighlight();
    return;
  }
  activeDiagHighlight = kind;
  refreshDiagOverlays();
}

/**
 * Build a single issue line element with a "Show" toggle button.
 * @param {string} text  – the issue description
 * @param {string} kind  – highlight kind key
 * @returns {HTMLElement}
 */
function makeDiagLine(text, kind) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:8px';
  const span = document.createElement('span');
  span.textContent = '\u26a0 ' + text;
  const btn = document.createElement('button');
  btn.className = 'diag-show-btn';
  btn.dataset.kind = kind;
  btn.textContent = activeDiagHighlight === kind ? t('diag.hide') : t('diag.show');
  btn.addEventListener('click', () => toggleDiagHighlight(kind));
  row.appendChild(span);
  row.appendChild(btn);
  return row;
}

function renderFastDiag(diag) {
  meshDiagFast.innerHTML = '';

  if (diag.openEdges === 0 && diag.nonManifoldEdges === 0 && diag.shellCount <= 1) {
    meshDiagFast.textContent = t('diag.meshOk');
  } else {
    if (diag.openEdges > 0)
      meshDiagFast.appendChild(makeDiagLine(t('diag.openEdges', { n: diag.openEdges }), 'openEdges'));
    if (diag.nonManifoldEdges > 0)
      meshDiagFast.appendChild(makeDiagLine(t('diag.nonManifoldEdges', { n: diag.nonManifoldEdges }), 'nonManifold'));
    if (diag.shellCount > 1)
      meshDiagFast.appendChild(makeDiagLine(t('diag.multipleShells', { n: diag.shellCount }), 'shells'));
    const tip = document.createElement('div');
    tip.style.cssText = 'margin-top:4px;opacity:0.8;font-size:10px';
    tip.innerHTML = t('diag.recommendFix');
    meshDiagFast.appendChild(tip);
  }
  applyDiagSeverity();
}

function renderAdvancedDiag(results) {
  meshDiagAdvanced.innerHTML = '';

  if (results.intersectingPairs === 0 && results.overlappingPairs === 0) {
    meshDiagAdvanced.textContent = t('diag.advancedOk');
  } else {
    if (results.intersectingPairs > 0)
      meshDiagAdvanced.appendChild(makeDiagLine(t('diag.intersectingTris', { n: results.intersectingPairs }), 'intersects'));
    if (results.overlappingPairs > 0)
      meshDiagAdvanced.appendChild(makeDiagLine(t('diag.overlappingTris', { n: results.overlappingPairs }), 'overlaps'));
    const tip = document.createElement('div');
    tip.style.cssText = 'margin-top:4px;opacity:0.8;font-size:10px';
    tip.innerHTML = t('diag.recommendFix');
    meshDiagAdvanced.appendChild(tip);
  }
  applyDiagSeverity();
  renderExportValidation();
}

function updateMeshDiagnostics(adjData, triCount) {
  lastFastDiag = runFastDiagnostics(adjData, triCount);
  lastAdvancedDiag = null;
  clearDiagHighlight();
  renderFastDiag(lastFastDiag);

  meshDiagnostics.classList.remove('hidden');
  meshDiagAdvanced.classList.add('hidden');
  meshDiagRunBtn.disabled = false;
  renderExportValidation();
}

function _formatEstimateRange(range, opts = {}) {
  const formatter = new Intl.NumberFormat(undefined, opts);
  return `${formatter.format(Math.round(range.low))}–${formatter.format(Math.round(range.high))}`;
}

function _estimateExportRanges() {
  if (!currentGeometry?.attributes?.position) return null;

  const triangleCount = currentGeometry.attributes.position.count / 3;
  const maxTriangles = Math.max(1, settings.maxTriangles || triangleCount || 1);
  const refineLength = Math.max(1e-4, settings.refineLength || 1);

  // Reuse the same edge-ratio heuristic as precision masking, then apply a
  // broad uncertainty band to avoid false precision.
  const heuristicPre = estimateSubdivisionTriCount(currentGeometry, refineLength);
  const conservativeFloor = triangleCount;
  const estimatedPreDecimationTriangles = {
    low: Math.max(conservativeFloor, Math.round(heuristicPre * 0.78)),
    high: Math.max(conservativeFloor, Math.round(heuristicPre * 1.35)),
  };

  // Decimation target is maxTriangles, but outputs can vary a bit by topology.
  const estimatedPostDecimationTriangles = {
    low: Math.min(estimatedPreDecimationTriangles.low, maxTriangles),
    high: Math.min(estimatedPreDecimationTriangles.high, Math.round(maxTriangles * 1.08)),
  };

  // Peak memory estimate from likely export-time attribute buffers.
  const attr = currentGeometry.attributes;
  let bytesPerVertex = (3 + 3) * 4; // position + normal (float32)
  if (attr.uv) bytesPerVertex += 2 * 4;
  if (attr.weights || attr.skinWeight) bytesPerVertex += 4 * 4;

  // Exclusion weight is handled per-triangle in export path.
  const hasExclusionWeights = excludedFaces && excludedFaces.size > 0;
  const bytesPerTriangle = bytesPerVertex * 3 + (hasExclusionWeights ? 4 : 0);
  const overheadMultiplier = { low: 2.2, high: 3.4 };
  const estimatedPeakMemoryMB = {
    low: (estimatedPreDecimationTriangles.low * bytesPerTriangle * overheadMultiplier.low) / (1024 * 1024),
    high: (estimatedPreDecimationTriangles.high * bytesPerTriangle * overheadMultiplier.high) / (1024 * 1024),
  };

  return {
    triangleCount,
    estimatedPreDecimationTriangles,
    estimatedPostDecimationTriangles,
    estimatedPeakMemoryMB,
  };
}

function _sampleGray(imageData, w, h, u, v) {
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;
  v = 1 - v;
  const fx = u * (w - 1), fy = v * (h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0, ty = fy - y0;
  const d = imageData.data;
  const v00 = d[(y0 * w + x0) * 4] / 255;
  const v10 = d[(y0 * w + x1) * 4] / 255;
  const v01 = d[(y1 * w + x0) * 4] / 255;
  const v11 = d[(y1 * w + x1) * 4] / 255;
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

function _estimateVaseMetrics() {
  if (!settings.vaseModeSafe || settings.mappingMode !== 3 || !currentGeometry?.attributes?.position || !activeMapEntry?.imageData) {
    return null;
  }
  const geom = currentGeometry;
  const pos = geom.attributes.position;
  const nrm = geom.attributes.normal;
  const key = [
    geom.uuid, activeMapEntry.name, activeMapEntry.width, activeMapEntry.height,
    settings.scaleU, settings.scaleV, settings.offsetU, settings.offsetV,
    settings.rotation, settings.amplitude, settings.mappingBlend, settings.seamBandWidth,
    settings.vaseSeamContinuityBias, settings.vaseCircumferentialAttenuation, settings.vaseRadialGuardMm,
  ].join('|');
  if (vaseValidationCache.key === key) return vaseValidationCache.metrics;

  const bounds = currentBounds;
  const step = Math.max(1, Math.floor(pos.count / 1200));
  let seamZoneCount = 0;
  let hfAcc = 0;
  let hfAttAcc = 0;
  let inwardRiskCount = 0;
  let maxInwardRisk = 0;
  let samples = 0;
  const du = 1 / Math.max(64, activeMapEntry.width);

  for (let i = 0; i < pos.count; i += step) {
    const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const n = new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    const uv = computeUV(p, n, settings.mappingMode, settings, bounds);
    const chosen = uv.triplanar ? uv.samples.reduce((a, b) => (a.w > b.w ? a : b)) : uv;
    const u = chosen.u;
    const v = chosen.v;
    const base = _sampleGray(activeMapEntry.imageData, activeMapEntry.width, activeMapEntry.height, u, v);
    const gL = _sampleGray(activeMapEntry.imageData, activeMapEntry.width, activeMapEntry.height, u - du, v);
    const gR = _sampleGray(activeMapEntry.imageData, activeMapEntry.width, activeMapEntry.height, u + du, v);
    const hf = Math.abs(gL - 2 * base + gR);
    const hfGain = Math.min(1, hf * 8);
    hfAcc += hf;
    hfAttAcc += hf * (1 - settings.vaseCircumferentialAttenuation * hfGain);

    const centeredGrey = settings.symmetricDisplacement ? (base - 0.5) : base;
    const disp = centeredGrey * settings.amplitude;
    const rx = p.x - bounds.center.x;
    const ry = p.y - bounds.center.y;
    const radialLen = Math.hypot(rx, ry) || 1;
    const inwardDot = -((rx / radialLen) * n.x + (ry / radialLen) * n.y);
    const inwardMm = Math.max(0, disp * inwardDot);
    maxInwardRisk = Math.max(maxInwardRisk, inwardMm);
    if (inwardMm > settings.vaseRadialGuardMm) inwardRiskCount++;

    const seamDist = Math.min(u, 1 - u);
    const seamBand = (settings.seamBandWidth ?? 0.5) * 0.1;
    if (seamBand > 1e-4 && seamDist < seamBand) seamZoneCount++;
    samples++;
  }

  const metrics = {
    seamZoneRatio: samples > 0 ? seamZoneCount / samples : 0,
    circumferentialHFMean: samples > 0 ? hfAcc / samples : 0,
    attenuatedHFMean: samples > 0 ? hfAttAcc / samples : 0,
    radialReversalRiskCount: inwardRiskCount,
    maxInwardRiskMm: maxInwardRisk,
  };
  vaseValidationCache = { key, metrics };
  return metrics;
}

function collectExportValidation() {
  const warnings = [];
  const errors = [];

  if (!currentGeometry?.attributes?.position) {
    return { warnings, errors, estimate: null };
  }

  const triCount = currentGeometry.attributes.position.count / 3;

  if (lastFastDiag?.nonManifoldEdges > 0) {
    errors.push(t('diag.nonManifoldEdges', { n: lastFastDiag.nonManifoldEdges }));
  }
  if (lastAdvancedDiag?.intersectingPairs > 0) {
    errors.push(t('diag.intersectingTris', { n: lastAdvancedDiag.intersectingPairs }));
  }
  if (lastFastDiag?.openEdges > 0) {
    warnings.push(t('diag.openEdges', { n: lastFastDiag.openEdges }));
  }
  if (lastFastDiag?.shellCount > 1) {
    warnings.push(t('diag.multipleShells', { n: lastFastDiag.shellCount }));
  }
  if (lastAdvancedDiag?.overlappingPairs > 0) {
    warnings.push(t('diag.overlappingTris', { n: lastAdvancedDiag.overlappingPairs }));
  }
  if (triCount > settings.maxTriangles) {
    warnings.push(t('warnings.safetyCapHit'));
  }

  if (settings.vaseModeSafe) {
    if (settings.mappingMode !== 3) {
      errors.push(t('exportValidation.vaseNeedsCylindrical'));
    }
    const vaseMetrics = lastVaseMetrics || _estimateVaseMetrics();
    if (!vaseMetrics) {
      errors.push(t('exportValidation.vaseValidationUnavailable'));
    } else {
      const seamRisk = (vaseMetrics.seamBlendSamples > 0)
        ? Math.abs(0.5 - vaseMetrics.seamBlendMixMean)
        : vaseMetrics.seamZoneRatio;
      const hfMetric = vaseMetrics.attenuatedHFMean ?? vaseMetrics.circumferentialHFMean;
      const radialRiskCount = vaseMetrics.radialReversalRiskCount ?? vaseMetrics.radialReversalCorrections ?? 0;
      const radialRiskMm = vaseMetrics.maxInwardRiskMm ?? vaseMetrics.maxRadialInwardMm ?? 0;

      if (seamRisk > 0.22) {
        errors.push(t('exportValidation.vaseSeamUnsafe'));
      }
      if (hfMetric > 0.055) {
        errors.push(t('exportValidation.vaseHighFrequency'));
      }
      if (radialRiskCount > 0 || radialRiskMm > settings.vaseRadialGuardMm + 1e-4) {
        errors.push(t('exportValidation.vaseRadialRisk', {
          bands: radialRiskCount,
          mm: radialRiskMm.toFixed(3),
        }));
      }
    }
  }

  return {
    warnings,
    errors,
    estimate: hasGeometry ? _estimateExportRanges() : null,
  };
}

function renderExportValidation() {
  const validation = collectExportValidation();
  if (!exportValidationEl) return validation;

  const hasMessages = validation.errors.length > 0 || validation.warnings.length > 0 || !!validation.estimate;
  exportValidationEl.classList.toggle('hidden', !hasMessages);
  exportValidationEl.classList.toggle('has-errors', validation.errors.length > 0);
  exportValidationEl.classList.toggle('has-warnings', validation.warnings.length > 0);

  const lines = [];
  if (validation.estimate) {
    const est = validation.estimate;
    const estimateText = [
      t('exportValidation.estimatePre', { n: _formatEstimateRange(est.estimatedPreDecimationTriangles) }),
      t('exportValidation.estimatePost', { n: _formatEstimateRange(est.estimatedPostDecimationTriangles) }),
      t('exportValidation.estimatePeakMemory', {
        n: _formatEstimateRange(est.estimatedPeakMemoryMB, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
      }),
    ].join(' · ');
    lines.push(`<div class="estimate-line">${t('exportValidation.estimatePrefix')} ${estimateText}</div>`);
  }

  for (const msg of validation.errors) lines.push(`⛔ ${msg}`);
  for (const msg of validation.warnings) lines.push(`⚠ ${msg}`);

  if (!lines.length) {
    exportValidationEl.classList.add('hidden');
    exportValidationEl.innerHTML = '';
  } else {
    exportValidationEl.innerHTML = lines.join('<br/>');
  }

  return validation;
}

function checkResolutionWarning() {
  if (!currentBounds) return;
  const diag = Math.sqrt(
    currentBounds.size.x ** 2 +
    currentBounds.size.y ** 2 +
    currentBounds.size.z ** 2
  );
  const tooCoarse = settings.refineLength > diag / 100;
  resolutionWarning.classList.toggle('hidden', !tooCoarse);
  refineLenSlider.classList.toggle('res-warn', tooCoarse);
  refineLenVal.classList.toggle('res-warn', tooCoarse);
}

/**
 * Set (or update) the `faceMask` vertex attribute on a geometry.
 * 1.0 = textured, 0.0 = user-excluded.  Angle masking stays in the shader.
 *
 * Always creates a fresh Float32BufferAttribute so that Three.js allocates a
 * new WebGL buffer and uploads the current data.  This avoids subtle buffer-
 * caching issues where in-place array edits + needsUpdate could keep stale
 * GPU data on some drivers.
 */
function updateFaceMask(geometry) {
  if (!geometry) return;
  const posCount = geometry.attributes.position.count;
  const triCount = posCount / 3;

  // Reuse existing buffer if length matches exactly, otherwise allocate new
  const existing = geometry.getAttribute('faceMask');
  const reuseBuffer = existing && existing.array.length === posCount;
  const maskArr = reuseBuffer ? existing.array : new Float32Array(posCount);

  // Determine which face set to check
  const isPrecision = (geometry === precisionGeometry && precisionMaskingEnabled);
  const faceSet = isPrecision ? precisionExcludedFaces : excludedFaces;

  // Fast path: no user exclusion active
  if (faceSet.size === 0 && !selectionMode) {
    maskArr.fill(1.0);
  } else {
    const isDisp = (geometry === dispPreviewGeometry && dispPreviewParentMap);
    for (let t = 0; t < triCount; t++) {
      // For precision geometry, t is already a precision face index.
      // For disp preview, map through dispPreviewParentMap to original.
      // Otherwise t is already an original face index.
      const faceIdx = isDisp ? dispPreviewParentMap[t] : t;
      const excluded = selectionMode ? !faceSet.has(faceIdx) : faceSet.has(faceIdx);
      const val = excluded ? 0.0 : 1.0;
      maskArr[t * 3]     = val;
      maskArr[t * 3 + 1] = val;
      maskArr[t * 3 + 2] = val;
    }
  }

  if (reuseBuffer) {
    existing.needsUpdate = true;
  } else {
    geometry.setAttribute('faceMask', new THREE.Float32BufferAttribute(maskArr, 1));
  }

  // Ensure faceNormal attribute exists (needed by shader for angle masking).
  // For the original geometry normal == faceNormal; for subdivided geometry
  // addFaceNormals() is called after subdivision, but guard here in case the
  // attribute is still missing.
  if (!geometry.attributes.faceNormal) {
    addFaceNormals(geometry);
  }

  // Ensure falloff attributes exist so the shader doesn't read 0.0 for missing
  // attributes (which would make totalMask = 0 → entire model appears masked).
  // This matters when a fresh geometry is displayed while the masking tool is
  // active (e.g. entering precision mode) because the expensive recomputation
  // below is intentionally skipped during active masking.
  if (!geometry.attributes.boundaryFalloffAttr) {
    const arr = new Float32Array(posCount);
    arr.fill(1.0);
    geometry.setAttribute('boundaryFalloffAttr', new THREE.Float32BufferAttribute(arr, 1));
  }
  if (!geometry.attributes.boundaryMaskTypeAttr) {
    const arr = new Float32Array(posCount);
    arr.fill(1.0);
    geometry.setAttribute('boundaryMaskTypeAttr', new THREE.Float32BufferAttribute(arr, 1));
  }

  // Skip expensive per-vertex falloff and boundary edge recomputation while
  // actively masking; both will be recalculated when the masking tool is
  // deactivated (in setExclusionTool → updateFaceMask with exclusionTool=null).
  if (!exclusionTool && (_falloffDirty || geometry !== _falloffGeometry)) {
    computeBoundaryFalloffAttr(geometry, maskArr);
    computeBoundaryEdges(geometry, maskArr);
    _falloffDirty = false;
    _falloffGeometry = geometry;
  }
  syncBoundaryEdgeUniforms();
  requestRender();
}

/**
 * Compute a per-vertex `boundaryFalloffAttr` float attribute on the geometry.
 * Vertices near the boundary between masked and non-masked regions get values
 * ramping from 0 (at boundary) to 1 (at or beyond boundaryFalloff distance).
 * The shader multiplies displacement/bump by this attribute.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {Float32Array}         userMaskArr – per-vertex user-exclusion mask from updateFaceMask
 */
function computeBoundaryFalloffAttr(geometry, userMaskArr) {
  const posAttr = geometry.attributes.position;
  const posCount = posAttr.count;
  const triCount = posCount / 3;
  const falloff = settings.boundaryFalloff ?? 0;

  // Reuse existing attribute buffers when sizes match to avoid Three.js
  // WebGL binding state cache issues when replacing attribute objects on
  // a geometry that is already attached to a rendered mesh.
  const existingFalloff = geometry.getAttribute('boundaryFalloffAttr');
  const reuseFalloff = existingFalloff && existingFalloff.array.length === posCount;
  const falloffArr = reuseFalloff ? existingFalloff.array : new Float32Array(posCount);
  falloffArr.fill(1.0);

  const existingType = geometry.getAttribute('boundaryMaskTypeAttr');
  const reuseType = existingType && existingType.array.length === posCount;
  const maskTypeArr = reuseType ? existingType.array : new Float32Array(posCount);
  maskTypeArr.fill(1.0);

  if (falloff <= 0) {
    if (reuseFalloff) existingFalloff.needsUpdate = true;
    else geometry.setAttribute('boundaryFalloffAttr', new THREE.Float32BufferAttribute(falloffArr, 1));
    if (reuseType) existingType.needsUpdate = true;
    else geometry.setAttribute('boundaryMaskTypeAttr', new THREE.Float32BufferAttribute(maskTypeArr, 1));
    return;
  }

  // Compute per-face combined mask (angle masking + user exclusion).
  // Mirrors the vertex shader logic so the preview boundary matches export.
  const faceNrmAttr = geometry.attributes.faceNormal;
  const faceMask = new Float32Array(triCount); // 0 = masked, 1 = textured
  const isUserMasked = new Uint8Array(triCount); // 1 if user-excluded
  for (let t = 0; t < triCount; t++) {
    const userVal = userMaskArr[t * 3]; // same for all 3 verts of this face
    if (userVal < 0.5) { faceMask[t] = 0; isUserMasked[t] = 1; continue; }

    let angleMask = 1.0;
    if (faceNrmAttr) {
      const fnz = faceNrmAttr.getZ(t * 3);
      const fnx = faceNrmAttr.getX(t * 3);
      const fny = faceNrmAttr.getY(t * 3);
      const len = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
      const nz = len > 1e-6 ? fnz / len : 0;
      const surfaceAngle = Math.acos(Math.min(1, Math.abs(nz))) * (180 / Math.PI);
      if (nz < 0 && settings.bottomAngleLimit >= 1)
        angleMask = surfaceAngle > settings.bottomAngleLimit ? 1.0 : 0.0;
      if (nz >= 0 && settings.topAngleLimit >= 1)
        angleMask = Math.min(angleMask, surfaceAngle > settings.topAngleLimit ? 1.0 : 0.0);
    }
    faceMask[t] = angleMask;
  }

  // Build per-unique-position map and identify boundary positions.
  const QUANT = 1e4;
  const posKey = (x, y, z) =>
    `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;

  const posFromKey = new Map();  // posKey → [x, y, z]
  // Per-position: [maskedArea, totalArea] to find boundary vertices
  const maskFracMap = new Map();
  const userMaskAreaMap = new Map(); // posKey → area of user-masked faces
  const tmpV = new THREE.Vector3();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    vA.fromBufferAttribute(posAttr, t * 3);
    vB.fromBufferAttribute(posAttr, t * 3 + 1);
    vC.fromBufferAttribute(posAttr, t * 3 + 2);
    e1.subVectors(vB, vA);
    e2.subVectors(vC, vA);
    fn.crossVectors(e1, e2);
    const area = fn.length();
    const masked = faceMask[t] < 0.5;

    for (let v = 0; v < 3; v++) {
      tmpV.fromBufferAttribute(posAttr, t * 3 + v);
      const k = posKey(tmpV.x, tmpV.y, tmpV.z);
      if (!posFromKey.has(k)) posFromKey.set(k, [tmpV.x, tmpV.y, tmpV.z]);
      const mf = maskFracMap.get(k);
      if (mf) {
        if (masked) mf[0] += area;
        mf[1] += area;
      } else {
        maskFracMap.set(k, [masked ? area : 0, area]);
      }
      // Track user-mask area per position to classify boundary type
      if (isUserMasked[t]) {
        const prev = userMaskAreaMap.get(k) || 0;
        userMaskAreaMap.set(k, prev + area);
      }
    }
  }

  // Boundary positions: shared between masked and non-masked faces.
  // Each entry: [x, y, z, maskType] where maskType 0 = user, 1 = angle.
  const boundaryPositions = [];
  for (const [k, pos] of posFromKey) {
    const mf = maskFracMap.get(k);
    const frac = mf[1] > 0 ? mf[0] / mf[1] : 0;
    if (frac > 0 && frac < 1) {
      const userArea = userMaskAreaMap.get(k) || 0;
      boundaryPositions.push([pos[0], pos[1], pos[2], userArea > 0 ? 0 : 1]);
    }
  }

  if (boundaryPositions.length === 0) {
    if (reuseFalloff) existingFalloff.needsUpdate = true;
    else geometry.setAttribute('boundaryFalloffAttr', new THREE.Float32BufferAttribute(falloffArr, 1));
    if (reuseType) existingType.needsUpdate = true;
    else geometry.setAttribute('boundaryMaskTypeAttr', new THREE.Float32BufferAttribute(maskTypeArr, 1));
    return;
  }

  // Spatial grid of boundary positions for fast nearest-neighbor search
  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
  let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
  for (const bp of boundaryPositions) {
    if (bp[0] < gMinX) gMinX = bp[0]; if (bp[0] > gMaxX) gMaxX = bp[0];
    if (bp[1] < gMinY) gMinY = bp[1]; if (bp[1] > gMaxY) gMaxY = bp[1];
    if (bp[2] < gMinZ) gMinZ = bp[2]; if (bp[2] > gMaxZ) gMaxZ = bp[2];
  }
  const gPad = falloff + 1e-3;
  gMinX -= gPad; gMinY -= gPad; gMinZ -= gPad;
  gMaxX += gPad; gMaxY += gPad; gMaxZ += gPad;

  const gRes = Math.max(4, Math.min(128, Math.ceil(Math.cbrt(boundaryPositions.length) * 2)));
  const gDx = (gMaxX - gMinX) / gRes || 1;
  const gDy = (gMaxY - gMinY) / gRes || 1;
  const gDz = (gMaxZ - gMinZ) / gRes || 1;
  const bGrid = new Map();
  const bCellKey = (ix, iy, iz) => (ix * gRes + iy) * gRes + iz;

  for (const bp of boundaryPositions) {
    const ix = Math.max(0, Math.min(gRes - 1, Math.floor((bp[0] - gMinX) / gDx)));
    const iy = Math.max(0, Math.min(gRes - 1, Math.floor((bp[1] - gMinY) / gDy)));
    const iz = Math.max(0, Math.min(gRes - 1, Math.floor((bp[2] - gMinZ) / gDz)));
    const ck = bCellKey(ix, iy, iz);
    const cell = bGrid.get(ck);
    if (cell) cell.push(bp); else bGrid.set(ck, [bp]);
  }

  const searchX = Math.ceil(falloff / gDx);
  const searchY = Math.ceil(falloff / gDy);
  const searchZ = Math.ceil(falloff / gDz);

  // Compute per-unique-position falloff factor and mask type
  const falloffCache = new Map(); // posKey → factor [0,1]
  const maskTypeCache = new Map(); // posKey → 0 (user mask) or 1 (angle mask)
  for (const [k, pos] of posFromKey) {
    const mf = maskFracMap.get(k);
    const frac = mf[1] > 0 ? mf[0] / mf[1] : 0;
    if (frac >= 1) continue; // fully masked vertex — keep 1.0 (mask zeroes it anyway)
    // Boundary vertices (shared between masked and unmasked faces) are AT
    // the boundary → distance 0 → falloff factor 0.
    if (frac > 0) {
      falloffCache.set(k, 0);
      const userArea = userMaskAreaMap.get(k) || 0;
      maskTypeCache.set(k, userArea > 0 ? 0 : 1);
      continue;
    }

    const px = pos[0], py = pos[1], pz = pos[2];
    const cix = Math.max(0, Math.min(gRes - 1, Math.floor((px - gMinX) / gDx)));
    const ciy = Math.max(0, Math.min(gRes - 1, Math.floor((py - gMinY) / gDy)));
    const ciz = Math.max(0, Math.min(gRes - 1, Math.floor((pz - gMinZ) / gDz)));

    let minDist2 = falloff * falloff;
    let nearestType = 1; // default: angle mask
    for (let dix = -searchX; dix <= searchX; dix++) {
      const nix = cix + dix;
      if (nix < 0 || nix >= gRes) continue;
      for (let diy = -searchY; diy <= searchY; diy++) {
        const niy = ciy + diy;
        if (niy < 0 || niy >= gRes) continue;
        for (let diz = -searchZ; diz <= searchZ; diz++) {
          const niz = ciz + diz;
          if (niz < 0 || niz >= gRes) continue;
          const cell = bGrid.get(bCellKey(nix, niy, niz));
          if (!cell) continue;
          for (const bp of cell) {
            const dx = px - bp[0], dy = py - bp[1], dz = pz - bp[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < minDist2) { minDist2 = d2; nearestType = bp[3]; }
          }
        }
      }
    }
    const dist = Math.sqrt(minDist2);
    const factor = Math.min(1, dist / falloff);
    if (factor < 1) {
      falloffCache.set(k, factor);
      maskTypeCache.set(k, nearestType);
    }
  }

  // Write per-vertex attributes
  for (let i = 0; i < posCount; i++) {
    tmpV.fromBufferAttribute(posAttr, i);
    const k = posKey(tmpV.x, tmpV.y, tmpV.z);
    if (falloffCache.has(k)) falloffArr[i] = falloffCache.get(k);
    if (maskTypeCache.has(k)) maskTypeArr[i] = maskTypeCache.get(k);
  }

  if (reuseFalloff) existingFalloff.needsUpdate = true;
  else geometry.setAttribute('boundaryFalloffAttr', new THREE.Float32BufferAttribute(falloffArr, 1));
  if (reuseType) existingType.needsUpdate = true;
  else geometry.setAttribute('boundaryMaskTypeAttr', new THREE.Float32BufferAttribute(maskTypeArr, 1));
}

/**
 * Compute boundary edge segments between masked and non-masked faces and
 * pack them into a DataTexture for per-fragment distance queries in the
 * bump-only preview shader.  Each edge is stored as two RGBA texels
 * (endpoint A xyz, endpoint B xyz).
 */
function computeBoundaryEdges(geometry, userMaskArr) {
  const posAttr = geometry.attributes.position;
  const posCount = posAttr.count;
  const triCount = posCount / 3;
  const falloff = settings.boundaryFalloff ?? 0;

  if (_boundaryEdgeTex) { _boundaryEdgeTex.dispose(); _boundaryEdgeTex = null; }
  _boundaryEdgeCount = 0;
  if (falloff <= 0) return;

  const faceNrmAttr = geometry.attributes.faceNormal;
  const faceMaskBool = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    if (userMaskArr[t * 3] < 0.5) { faceMaskBool[t] = 0; continue; }
    let angleMask = 1.0;
    if (faceNrmAttr) {
      const fnx = faceNrmAttr.getX(t * 3);
      const fny = faceNrmAttr.getY(t * 3);
      const fnz = faceNrmAttr.getZ(t * 3);
      const len = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
      const nz = len > 1e-6 ? fnz / len : 0;
      const surfAngle = Math.acos(Math.min(1, Math.abs(nz))) * (180 / Math.PI);
      if (nz < 0 && settings.bottomAngleLimit >= 1)
        angleMask = surfAngle > settings.bottomAngleLimit ? 1.0 : 0.0;
      if (nz >= 0 && settings.topAngleLimit >= 1)
        angleMask = Math.min(angleMask, surfAngle > settings.topAngleLimit ? 1.0 : 0.0);
    }
    faceMaskBool[t] = angleMask > 0.5 ? 1 : 0;
  }

  const QUANT = 1e4;
  const pk = (x, y, z) =>
    `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;
  const ek = (k1, k2) => k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
  const tmpV = new THREE.Vector3();

  const edgeFaces = new Map();
  const edgePos   = new Map();

  for (let t = 0; t < triCount; t++) {
    const keys = [], pts = [];
    for (let v = 0; v < 3; v++) {
      tmpV.fromBufferAttribute(posAttr, t * 3 + v);
      keys.push(pk(tmpV.x, tmpV.y, tmpV.z));
      pts.push([tmpV.x, tmpV.y, tmpV.z]);
    }
    for (let e = 0; e < 3; e++) {
      const edgeKey = ek(keys[e], keys[(e + 1) % 3]);
      const list = edgeFaces.get(edgeKey);
      if (list) list.push(t);
      else {
        edgeFaces.set(edgeKey, [t]);
        edgePos.set(edgeKey, [pts[e], pts[(e + 1) % 3]]);
      }
    }
  }

  const MAX_EDGES = 64;
  const edges = [];
  for (const [key, faces] of edgeFaces) {
    if (edges.length >= MAX_EDGES) break;
    let hasMasked = false, hasTextured = false;
    for (const f of faces) {
      if (faceMaskBool[f] === 0) hasMasked = true;
      else hasTextured = true;
      if (hasMasked && hasTextured) break;
    }
    if (hasMasked && hasTextured) edges.push(edgePos.get(key));
  }

  if (edges.length === 0) return;

  const texWidth = edges.length * 2;
  const data = new Float32Array(texWidth * 4);
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i];
    const off = i * 8;
    data[off] = a[0]; data[off + 1] = a[1]; data[off + 2] = a[2]; data[off + 3] = 0;
    data[off + 4] = b[0]; data[off + 5] = b[1]; data[off + 6] = b[2]; data[off + 7] = 0;
  }

  _boundaryEdgeTex = new THREE.DataTexture(data, texWidth, 1, THREE.RGBAFormat, THREE.FloatType);
  _boundaryEdgeTex.minFilter = THREE.NearestFilter;
  _boundaryEdgeTex.magFilter = THREE.NearestFilter;
  _boundaryEdgeTex.needsUpdate = true;
  _boundaryEdgeCount = edges.length;
}

function syncBoundaryEdgeUniforms() {
  if (!previewMaterial || !previewMaterial.uniforms.boundaryEdgeTex) return;
  const u = previewMaterial.uniforms;
  if (_boundaryEdgeTex) {
    u.boundaryEdgeTex.value = _boundaryEdgeTex;
    u.boundaryEdgeTexWidth.value = _boundaryEdgeTex.image.width;
  }
  u.boundaryEdgeCount.value = _boundaryEdgeCount;
  u.boundaryFalloffDist.value = settings.boundaryFalloff ?? 0;
}

/**
 * Build a mapping from each subdivided face to its nearest original face
 * using a grid-accelerated nearest-centroid lookup, with face normal
 * tiebreaking to prevent boundary faces from being mapped to the wrong
 * original face (e.g. a subdivided face on a cube edge mapped to the
 * adjacent face instead of the correct one).
 */
function buildParentFaceMap(subdivGeo) {
  if (!triangleCentroids || !currentGeometry) return null;

  const origPos = currentGeometry.attributes.position.array;
  const origTriCount = currentGeometry.attributes.position.count / 3;
  const subPos = subdivGeo.attributes.position.array;
  const subTriCount = subdivGeo.attributes.position.count / 3;

  // Precompute original face normals
  const origNormals = new Float32Array(origTriCount * 3);
  const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _fn = new THREE.Vector3();
  for (let t = 0; t < origTriCount; t++) {
    const b = t * 9;
    _e1.set(origPos[b + 3] - origPos[b], origPos[b + 4] - origPos[b + 1], origPos[b + 5] - origPos[b + 2]);
    _e2.set(origPos[b + 6] - origPos[b], origPos[b + 7] - origPos[b + 1], origPos[b + 8] - origPos[b + 2]);
    _fn.crossVectors(_e1, _e2).normalize();
    origNormals[t * 3] = _fn.x; origNormals[t * 3 + 1] = _fn.y; origNormals[t * 3 + 2] = _fn.z;
  }

  // Bounding box of original centroids
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < origTriCount; i++) {
    const cx = triangleCentroids[i * 3], cy = triangleCentroids[i * 3 + 1], cz = triangleCentroids[i * 3 + 2];
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;
  }
  const pad = 1e-3;
  minX -= pad; minY -= pad; minZ -= pad;
  maxX += pad; maxY += pad; maxZ += pad;

  const res = Math.max(4, Math.min(128, Math.ceil(Math.cbrt(origTriCount) * 2)));
  const dx = (maxX - minX) / res || 1;
  const dy = (maxY - minY) / res || 1;
  const dz = (maxZ - minZ) / res || 1;

  // Build spatial grid of original centroids
  const grid = new Map();
  const cellKey = (ix, iy, iz) => (ix * res + iy) * res + iz;
  for (let i = 0; i < origTriCount; i++) {
    const cx = triangleCentroids[i * 3], cy = triangleCentroids[i * 3 + 1], cz = triangleCentroids[i * 3 + 2];
    const ix = Math.max(0, Math.min(res - 1, Math.floor((cx - minX) / dx)));
    const iy = Math.max(0, Math.min(res - 1, Math.floor((cy - minY) / dy)));
    const iz = Math.max(0, Math.min(res - 1, Math.floor((cz - minZ) / dz)));
    const k = cellKey(ix, iy, iz);
    const cell = grid.get(k);
    if (cell) cell.push(i); else grid.set(k, [i]);
  }

  // For each subdivided face, find nearest original face by centroid distance
  // with face-normal tiebreaking to resolve boundary ambiguity.
  const parentMap = new Int32Array(subTriCount);
  for (let st = 0; st < subTriCount; st++) {
    const base = st * 9;
    const sx = (subPos[base] + subPos[base + 3] + subPos[base + 6]) / 3;
    const sy = (subPos[base + 1] + subPos[base + 4] + subPos[base + 7]) / 3;
    const sz = (subPos[base + 2] + subPos[base + 5] + subPos[base + 8]) / 3;

    // Subdivided face normal
    _e1.set(subPos[base + 3] - subPos[base], subPos[base + 4] - subPos[base + 1], subPos[base + 5] - subPos[base + 2]);
    _e2.set(subPos[base + 6] - subPos[base], subPos[base + 7] - subPos[base + 1], subPos[base + 8] - subPos[base + 2]);
    _fn.crossVectors(_e1, _e2).normalize();
    const snx = _fn.x, sny = _fn.y, snz = _fn.z;

    const ix = Math.max(0, Math.min(res - 1, Math.floor((sx - minX) / dx)));
    const iy = Math.max(0, Math.min(res - 1, Math.floor((sy - minY) / dy)));
    const iz = Math.max(0, Math.min(res - 1, Math.floor((sz - minZ) / dz)));

    let bestDist = Infinity, bestIdx = 0;
    // Two-pass: prefer original faces whose normal aligns with the subdivided
    // face (dot > 0.4 ≈ within ~66°), then among those pick the nearest
    // centroid.  This prevents boundary faces at sharp seams (cube edges etc.)
    // from being mapped to the adjacent face even when that face's centroid
    // happens to be closer.  Falls back to pure nearest-centroid if no
    // normal-matching candidate is found.
    let bestDistAligned = Infinity, bestIdxAligned = -1;
    for (let dix = -1; dix <= 1; dix++) {
      for (let diy = -1; diy <= 1; diy++) {
        for (let diz = -1; diz <= 1; diz++) {
          const nix = ix + dix, niy = iy + diy, niz = iz + diz;
          if (nix < 0 || nix >= res || niy < 0 || niy >= res || niz < 0 || niz >= res) continue;
          const cell = grid.get(cellKey(nix, niy, niz));
          if (!cell) continue;
          for (const oi of cell) {
            const cdx = sx - triangleCentroids[oi * 3];
            const cdy = sy - triangleCentroids[oi * 3 + 1];
            const cdz = sz - triangleCentroids[oi * 3 + 2];
            const centroidDist = cdx * cdx + cdy * cdy + cdz * cdz;
            if (centroidDist < bestDist) { bestDist = centroidDist; bestIdx = oi; }
            const dot = snx * origNormals[oi * 3] + sny * origNormals[oi * 3 + 1] + snz * origNormals[oi * 3 + 2];
            if (dot > 0.4 && centroidDist < bestDistAligned) {
              bestDistAligned = centroidDist; bestIdxAligned = oi;
            }
          }
        }
      }
    }

    // If the local grid search didn't find a normal-aligned original face
    // (common for sparse original meshes like cubes where face centroids
    // are far from the grid cell of a corner-adjacent subdivided face),
    // fall back to a brute-force scan over ALL original faces.
    if (bestIdxAligned < 0) {
      for (let oi = 0; oi < origTriCount; oi++) {
        const cdx = sx - triangleCentroids[oi * 3];
        const cdy = sy - triangleCentroids[oi * 3 + 1];
        const cdz = sz - triangleCentroids[oi * 3 + 2];
        const centroidDist = cdx * cdx + cdy * cdy + cdz * cdz;
        if (centroidDist < bestDist) { bestDist = centroidDist; bestIdx = oi; }
        const dot = snx * origNormals[oi * 3] + sny * origNormals[oi * 3 + 1] + snz * origNormals[oi * 3 + 2];
        if (dot > 0.4 && centroidDist < bestDistAligned) {
          bestDistAligned = centroidDist; bestIdxAligned = oi;
        }
      }
    }
    parentMap[st] = bestIdxAligned >= 0 ? bestIdxAligned : bestIdx;
  }

  return parentMap;
}

function getEffectiveMapEntry() {
  if (!activeMapEntry || settings.textureSmoothing === 0) {
    _effectiveMapCache    = null;
    _effectiveMapCacheKey = null;
    return activeMapEntry;
  }
  const { fullCanvas, width, height, name } = activeMapEntry;
  const cacheKey = `${name}_${width}_${height}_${settings.textureSmoothing}`;
  if (_effectiveMapCacheKey === cacheKey && _effectiveMapCache) {
    return _effectiveMapCache;
  }
  // Tile the source 3×3 before blurring so edge pixels have correct
  // neighbours and the blurred centre tile is seamlessly tileable.
  const tiled = document.createElement('canvas');
  tiled.width  = width  * 3;
  tiled.height = height * 3;
  const tc = tiled.getContext('2d');
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      tc.drawImage(fullCanvas, col * width, row * height);
    }
  }
  // Blur the 3×3 canvas, then crop out only the centre tile.
  const blurred = document.createElement('canvas');
  blurred.width  = width  * 3;
  blurred.height = height * 3;
  blurred.getContext('2d').drawImage(tiled, 0, 0);
  blurCanvas(blurred, settings.textureSmoothing);
  const offscreen = document.createElement('canvas');
  offscreen.width  = width;
  offscreen.height = height;
  offscreen.getContext('2d').drawImage(blurred, width, height, width, height, 0, 0, width, height);
  const imageData = offscreen.getContext('2d').getImageData(0, 0, width, height);
  const texture   = new THREE.CanvasTexture(offscreen);
  texture.wrapS   = texture.wrapT = THREE.RepeatWrapping;
  if (_lastEffectiveTexture) _lastEffectiveTexture.dispose();
  _lastEffectiveTexture = texture;
  _effectiveMapCache    = { ...activeMapEntry, imageData, texture };
  _effectiveMapCacheKey = cacheKey;
  return _effectiveMapCache;
}

function _wrapDelta(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
}

function _sampleLumaAtUV(imageData, width, height, u, v) {
  if (!imageData || !imageData.data || width <= 0 || height <= 0) return 0.5;
  const uu = ((u % 1) + 1) % 1;
  const vv = ((v % 1) + 1) % 1;
  const x = Math.min(width - 1, Math.max(0, Math.floor(uu * (width - 1))));
  const y = Math.min(height - 1, Math.max(0, Math.floor((1 - vv) * (height - 1))));
  const off = (y * width + x) * 4;
  const d = imageData.data;
  return (0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2]) / 255;
}

function computeFaceStressScores(geometry, mapEntry, mapSettings) {
  const posAttr = geometry?.getAttribute('position');
  if (!posAttr) return { seamRisk: null, maskStress: null };
  const pos = posAttr.array;
  const triCount = Math.floor(posAttr.count / 3);
  const seamRisk = new Float32Array(triCount);
  const maskStress = new Float32Array(triCount);
  const faceMaskAttr = geometry.getAttribute('faceMask');
  const faceMask = faceMaskAttr?.array || null;
  const faceNormalAttr = geometry.getAttribute('faceNormal');

  const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
  const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const uv0 = { u: 0, v: 0 }, uv1 = { u: 0, v: 0 }, uv2 = { u: 0, v: 0 };
  const centroid = new THREE.Vector3();

  const uvFromMapping = (p, normal, out) => {
    const uv = computeUV(p, normal, settings.mappingMode, mapSettings, currentBounds);
    if (uv?.triplanar && uv.samples?.length) {
      let wu = 0, wv = 0, ww = 0;
      for (const s of uv.samples) {
        const w = s.w ?? 0;
        wu += (s.u ?? 0) * w;
        wv += (s.v ?? 0) * w;
        ww += w;
      }
      out.u = ww > 1e-6 ? wu / ww : 0;
      out.v = ww > 1e-6 ? wv / ww : 0;
      return;
    }
    out.u = uv?.u ?? 0;
    out.v = uv?.v ?? 0;
  };

  const du = 1 / Math.max(64, mapEntry?.width || 64);
  const dv = 1 / Math.max(64, mapEntry?.height || 64);

  for (let t = 0; t < triCount; t++) {
    const off = t * 9;
    v0.set(pos[off], pos[off + 1], pos[off + 2]);
    v1.set(pos[off + 3], pos[off + 4], pos[off + 5]);
    v2.set(pos[off + 6], pos[off + 7], pos[off + 8]);
    if (faceNormalAttr) {
      const no = t * 9;
      n.set(faceNormalAttr.array[no], faceNormalAttr.array[no + 1], faceNormalAttr.array[no + 2]).normalize();
    } else {
      e1.subVectors(v1, v0);
      e2.subVectors(v2, v0);
      n.crossVectors(e1, e2).normalize();
    }

    uvFromMapping(v0, n, uv0);
    uvFromMapping(v1, n, uv1);
    uvFromMapping(v2, n, uv2);

    const d01 = Math.hypot(_wrapDelta(uv0.u, uv1.u), _wrapDelta(uv0.v, uv1.v));
    const d12 = Math.hypot(_wrapDelta(uv1.u, uv2.u), _wrapDelta(uv1.v, uv2.v));
    const d20 = Math.hypot(_wrapDelta(uv2.u, uv0.u), _wrapDelta(uv2.v, uv0.v));
    seamRisk[t] = Math.min(1, Math.max(d01, d12, d20) / 0.35);

    const m0 = faceMask ? faceMask[t * 3] : 1;
    const m1 = faceMask ? faceMask[t * 3 + 1] : m0;
    const m2 = faceMask ? faceMask[t * 3 + 2] : m0;
    const maskGrad = Math.max(m0, m1, m2) - Math.min(m0, m1, m2);

    centroid.copy(v0).add(v1).add(v2).multiplyScalar(1 / 3);
    const cuv = { u: 0, v: 0 };
    uvFromMapping(centroid, n, cuv);
    const l = _sampleLumaAtUV(mapEntry?.imageData, mapEntry?.width || 1, mapEntry?.height || 1, cuv.u, cuv.v);
    const lx = _sampleLumaAtUV(mapEntry?.imageData, mapEntry?.width || 1, mapEntry?.height || 1, cuv.u + du, cuv.v);
    const ly = _sampleLumaAtUV(mapEntry?.imageData, mapEntry?.width || 1, mapEntry?.height || 1, cuv.u, cuv.v + dv);
    const texGrad = Math.min(1, Math.hypot(lx - l, ly - l) * 12);
    maskStress[t] = Math.min(1, maskGrad * 0.65 + texGrad * 0.35);
  }
  return { seamRisk, maskStress };
}

function updateOverlayAndSplit(activeGeo, effectiveEntry, fullSettings) {
  const rightGeo = (settings.useDisplacement && dispPreviewGeometry) ? dispPreviewGeometry : activeGeo;
  const leftGeo = currentGeometry || activeGeo;

  const activeScores = computeFaceStressScores(activeGeo, effectiveEntry, fullSettings);
  const leftScores = splitViewEnabled ? computeFaceStressScores(leftGeo, effectiveEntry, fullSettings) : null;
  const rightScores = splitViewEnabled ? computeFaceStressScores(rightGeo, effectiveEntry, fullSettings) : null;

  const pick = (scores) => {
    if (!scores || overlayMode === 'none') return null;
    if (overlayMode === 'seam-risk') return scores.seamRisk;
    if (overlayMode === 'mask-stress') return scores.maskStress;
    return null;
  };

  setFaceScalarOverlay({
    mode: overlayMode,
    geometry: activeGeo,
    scores: pick(activeScores),
    splitLeft: splitViewEnabled ? { geometry: leftGeo, scores: pick(leftScores) } : null,
    splitRight: splitViewEnabled ? { geometry: rightGeo, scores: pick(rightScores) } : null,
  });
  setSplitView(splitViewEnabled, leftGeo, rightGeo);
}

function updatePreview() {
  if (!currentGeometry || !currentBounds) return;

  // Texture aspect correction so non-square textures keep their proportions.
  // A 512×279 texture needs aspectV = 512/279 ≈ 1.84 so V tiles faster (more
  // repetitions), making each tile shorter in world-space to match the texture's
  // wider-than-tall content.  The wider axis gets aspect = 1 (unchanged).
  const tw = activeMapEntry?.width ?? 1, th = activeMapEntry?.height ?? 1;
  const tmax = Math.max(tw, th, 1);
  const fullSettings = {
    ...settings,
    bounds: currentBounds,
    textureAspectU: tmax / Math.max(tw, 1),
    textureAspectV: tmax / Math.max(th, 1),
  };

  if (!activeMapEntry) {
    // No map yet — plain material
    if (previewMaterial) {
      setMeshMaterial(null);
      previewMaterial.dispose();
      previewMaterial = null;
    }
    exportBtn.disabled = true;
    export3mfBtn.disabled = true;
    clearTextureValidation();
    return;
  }

  // Choose geometry: precision mode → subdivided preview → original
  const activeGeo = (precisionMaskingEnabled && precisionGeometry)
    ? precisionGeometry
    : (settings.useDisplacement && dispPreviewGeometry)
      ? dispPreviewGeometry
      : currentGeometry;

  // Ensure faceMask attribute is current before rendering
  updateFaceMask(activeGeo);

  const effectiveEntry = getEffectiveMapEntry();

  if (!previewMaterial) {
    previewMaterial = createPreviewMaterial(effectiveEntry.texture, fullSettings);
    loadGeometry(activeGeo, previewMaterial);
  } else {
    updateMaterial(previewMaterial, effectiveEntry.texture, fullSettings);
  }

  updateOverlayAndSplit(activeGeo, effectiveEntry, fullSettings);

  syncBoundaryEdgeUniforms();
  exportBtn.disabled = false;
  export3mfBtn.disabled = false;
  renderExportValidation();
  if (activeAnalysisOverlays.signedDisplacement || activeAnalysisOverlays.triangleDensity || activeDiagHighlight) {
    refreshDiagOverlays();
  }
}

// ── Displacement preview ──────────────────────────────────────────────────────

/**
 * Compute and set flat geometric face normals as a `faceNormal` attribute.
 * Unlike the `normal` attribute (which may be smooth/interpolated after
 * subdivision), `faceNormal` is always the true per-triangle normal computed
 * from the cross product of the triangle's edges.  The shader uses this for
 * angle-based masking so that smooth normals at edges don't cause mask bleeding.
 */
function addFaceNormals(geometry) {
  const pos   = geometry.attributes.position.array;
  const count = geometry.attributes.position.count;
  const fn    = new Float32Array(count * 3);
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n  = new THREE.Vector3();
  for (let i = 0; i < count; i += 3) {
    vA.set(pos[i * 3],       pos[i * 3 + 1],       pos[i * 3 + 2]);
    vB.set(pos[(i+1) * 3],   pos[(i+1) * 3 + 1],   pos[(i+1) * 3 + 2]);
    vC.set(pos[(i+2) * 3],   pos[(i+2) * 3 + 1],   pos[(i+2) * 3 + 2]);
    e1.subVectors(vB, vA);
    e2.subVectors(vC, vA);
    n.crossVectors(e1, e2).normalize();
    for (let v = 0; v < 3; v++) {
      fn[(i + v) * 3]     = n.x;
      fn[(i + v) * 3 + 1] = n.y;
      fn[(i + v) * 3 + 2] = n.z;
    }
  }
  geometry.setAttribute('faceNormal', new THREE.Float32BufferAttribute(fn, 3));
}

/**
 * Compute area-weighted smooth normals for a non-indexed geometry and store
 * them as a `smoothNormal` vec3 attribute.  Every copy of the same position
 * gets the same averaged normal so vertex-shader displacement is watertight.
 */
function addSmoothNormals(geometry) {
  const pos   = geometry.attributes.position.array;
  const count = geometry.attributes.position.count;
  const nrm   = geometry.attributes.normal.array;

  // Vertex-dedup pass: assign a numeric ID to each unique quantised position.
  const QUANT = 1e4;
  const dedupMap = new Map();
  let nextId = 0;
  const vertId = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos[i*3]*QUANT)}_${Math.round(pos[i*3+1]*QUANT)}_${Math.round(pos[i*3+2]*QUANT)}`;
    let id = dedupMap.get(key);
    if (id === undefined) { id = nextId++; dedupMap.set(key, id); }
    vertId[i] = id;
  }

  // Accumulate area-weighted buffer normals per unique position into flat arrays.
  // The subdivision pipeline splits indexed vertices at sharp dihedral edges
  // (>30 deg) so the interpolated buffer normals are smooth across soft edges
  // (cylinder, sphere) but sharp across hard edges (cube).  Using these buffer
  // normals instead of geometric face normals eliminates visible faceting steps
  // on round surfaces while still preserving hard edges.
  const uc = nextId;
  const snx = new Float64Array(uc), sny = new Float64Array(uc), snz = new Float64Array(uc);
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();

  for (let i = 0; i < count; i += 3) {
    vA.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    vB.set(pos[(i + 1) * 3], pos[(i + 1) * 3 + 1], pos[(i + 1) * 3 + 2]);
    vC.set(pos[(i + 2) * 3], pos[(i + 2) * 3 + 1], pos[(i + 2) * 3 + 2]);
    e1.subVectors(vB, vA);
    e2.subVectors(vC, vA);
    fn.crossVectors(e1, e2);
    const area = fn.length();
    if (area < 1e-12) continue;
    for (let v = 0; v < 3; v++) {
      const vi = i + v;
      const id = vertId[vi];
      snx[id] += nrm[vi * 3]     * area;
      sny[id] += nrm[vi * 3 + 1] * area;
      snz[id] += nrm[vi * 3 + 2] * area;
    }
  }

  // Normalize accumulated normals
  for (let id = 0; id < uc; id++) {
    const len = Math.sqrt(snx[id] * snx[id] + sny[id] * sny[id] + snz[id] * snz[id]) || 1;
    snx[id] /= len; sny[id] /= len; snz[id] /= len;
  }

  // Write smoothNormal attribute via vertId lookup
  const sn = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const id = vertId[i];
    sn[i * 3] = snx[id]; sn[i * 3 + 1] = sny[id]; sn[i * 3 + 2] = snz[id];
  }
  geometry.setAttribute('smoothNormal', new THREE.Float32BufferAttribute(sn, 3));
}

// ── Precision masking ─────────────────────────────────────────────────────────

/** Compute the target max edge length from the brush diameter. */
function computePrecisionEdgeLength(brushDiameter) {
  // ~20 edge segments around the brush circumference, clamped to a sane floor
  return Math.max(0.05, Math.PI * brushDiameter / 20);
}

/**
 * Estimate how many triangles subdivision will produce for a given edge length.
 * Uses a sample of existing edges to compute average edge length, then
 * assumes area-proportional subdivision: triCount × (avgEdge / target)².
 */
function estimateSubdivisionTriCount(geometry, targetEdge) {
  const pos = geometry.attributes.position;
  const triCount = pos.count / 3;
  // Sample up to 3000 edges (1000 triangles × 3 edges)
  const sampleTris = Math.min(triCount, 1000);
  let totalEdgeLen = 0;
  let edgeCount = 0;
  for (let t = 0; t < sampleTris; t++) {
    const i = t * 3;
    for (let e = 0; e < 3; e++) {
      const a = i + e, b = i + (e + 1) % 3;
      const dx = pos.getX(a) - pos.getX(b);
      const dy = pos.getY(a) - pos.getY(b);
      const dz = pos.getZ(a) - pos.getZ(b);
      totalEdgeLen += Math.sqrt(dx * dx + dy * dy + dz * dz);
      edgeCount++;
    }
  }
  if (edgeCount === 0) return triCount;
  const avgEdge = totalEdgeLen / edgeCount;
  const ratio = avgEdge / targetEdge;
  return Math.max(triCount, Math.round(triCount * ratio * ratio));
}

/** Deactivate precision masking and bake the refined mesh as the new base geometry. */
function deactivatePrecisionMasking() {
  if (precisionGeometry) {
    // Bake: the precision geometry becomes the new currentGeometry
    if (currentGeometry && currentGeometry !== precisionGeometry) {
      currentGeometry.dispose();
    }
    currentGeometry = precisionGeometry;

    // Promote precision adjacency data to the base adjacency
    triangleAdjacency  = precisionAdjacency;
    triangleCentroids  = precisionCentroids;
    triangleBoundRadii = precisionBoundRadii;

    // Rebuild spatial grid for the promoted base mesh
    const triCount = currentGeometry.attributes.position.count / 3;
    buildSpatialGrid(triangleCentroids, triCount, currentBounds);

    // Promote precision excluded faces to the base set
    excludedFaces = precisionExcludedFaces;

    // Update mesh info display
    const mb = ((currentGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
    const sx = currentBounds.size.x.toFixed(2);
    const sy = currentBounds.size.y.toFixed(2);
    const sz = currentBounds.size.z.toFixed(2);
    meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });
  } else if (precisionExcludedFaces.size > 0 && precisionParentMap) {
    // No precision geometry but have selections — map back to original
    excludedFaces = new Set();
    for (const pf of precisionExcludedFaces) {
      excludedFaces.add(precisionParentMap[pf]);
    }
  }

  // Clear all precision state
  precisionExcludedFaces = new Set();
  precisionGeometry   = null;
  precisionParentMap  = null;
  precisionEdgeLength = null;
  precisionCentroids  = null;
  precisionBoundRadii = null;
  precisionAdjacency  = null;
  precisionMaskingEnabled = false;
  precisionMaskingToggle.checked = false;
  precisionStatus.textContent = '';
  precisionOutdated.classList.add('hidden');
  precisionRefreshBtn.classList.add('hidden');
  precisionWarning.classList.add('hidden');
  if (currentGeometry) {
    setMeshGeometry(currentGeometry);
    updateFaceMask(currentGeometry);
    if (excludedFaces.size > 0) refreshExclusionOverlay();
    else setExclusionOverlay(null);
  }
}

/** Refresh (or initially build) the precision mesh from current brush size. */
async function refreshPrecisionMesh() {
  if (!currentGeometry || precisionBusy) return;

  const brushDiameter = parseFloat(exclBrushRadiusSlider.value);
  const targetEdge = computePrecisionEdgeLength(brushDiameter);

  // Estimate triangle count and warn if > 5M
  const estimated = estimateSubdivisionTriCount(currentGeometry, targetEdge);
  if (estimated > 5_000_000) {
    const estLabel = (estimated / 1_000_000).toFixed(1) + 'M';
    const msg = t('precision.warningBody', { n: estLabel });
    if (!confirm(msg)) return;
  }

  const myToken = ++precisionToken;
  precisionBusy = true;
  precisionStatus.textContent = t('precision.refining');
  precisionOutdated.classList.add('hidden');
  precisionRefreshBtn.classList.add('hidden');
  precisionWarning.classList.add('hidden');

  try {
    await yieldFrame();
    if (precisionToken !== myToken) return;

    const { geometry: subdivided, safetyCapHit, faceParentId } = await subdivide(
      currentGeometry, targetEdge, null, null, { fast: true }
    );
    if (precisionToken !== myToken) { subdivided.dispose(); return; }

    // Dispose previous precision geometry if any
    if (precisionGeometry) precisionGeometry.dispose();
    precisionGeometry  = subdivided;
    precisionParentMap = faceParentId;
    precisionEdgeLength = targetEdge;

    // Build adjacency data for the refined mesh
    const adjData = buildAdjacency(precisionGeometry);
    precisionAdjacency  = adjData.adjacency;
    precisionCentroids  = adjData.centroids;
    precisionBoundRadii = adjData.boundRadii;

    // Rebuild spatial grid for the precision mesh so brush queries are fast
    const precTriCount = precisionGeometry.attributes.position.count / 3;
    buildSpatialGrid(precisionCentroids, precTriCount, currentBounds);

    // Seed precisionExcludedFaces from existing excludedFaces
    precisionExcludedFaces = new Set();
    if (excludedFaces.size > 0) {
      const len = precisionParentMap.length;
      for (let i = 0; i < len; i++) {
        if (excludedFaces.has(precisionParentMap[i])) precisionExcludedFaces.add(i);
      }
    }

    // Swap display mesh to refined geometry
    setMeshGeometry(precisionGeometry);
    updateFaceMask(precisionGeometry);
    // Force per-vertex falloff computation on the fresh geometry even though
    // the masking tool is still active – updateFaceMask only computes boundary
    // edges during painting; the full vertex-level falloff is deferred until
    // the tool is deactivated, but we need it now for the initial state.
    {
      const maskAttr = precisionGeometry.getAttribute('faceMask');
      if (maskAttr) {
        computeBoundaryFalloffAttr(precisionGeometry, maskAttr.array);
        _falloffDirty = false;
        _falloffGeometry = precisionGeometry;
      }
    }
    if (precisionExcludedFaces.size > 0) refreshExclusionOverlay();
    else setExclusionOverlay(null);

    // Update status label
    const triCount = precisionGeometry.attributes.position.count / 3;
    const triLabel = triCount >= 1_000_000
      ? (triCount / 1_000_000).toFixed(1) + 'M'
      : triCount >= 1_000
        ? (triCount / 1_000).toFixed(0) + 'k'
        : String(triCount);
    precisionStatus.textContent = t('precision.triCount', { n: triLabel });

    // Update mesh info in the lower-left corner
    const mb = ((precisionGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
    const sx = currentBounds.size.x.toFixed(2);
    const sy = currentBounds.size.y.toFixed(2);
    const sz = currentBounds.size.z.toFixed(2);
    meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

    if (safetyCapHit) {
      triLimitWarning.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Precision masking subdivision failed:', err);
    deactivatePrecisionMasking();
  } finally {
    precisionBusy = false;
  }
}

/** Toggle precision masking on/off. */
async function togglePrecisionMasking(enable) {
  if (enable) {
    // Mutually exclusive with displacement preview
    if (settings.useDisplacement) {
      settings.useDisplacement = false;
      dispPreviewToggle.checked = false;
      await toggleDisplacementPreview(false);
    }
    precisionMaskingEnabled = true;
    await refreshPrecisionMesh();
    // If refresh was cancelled (e.g. user declined warning), revert
    if (!precisionGeometry) {
      precisionMaskingEnabled = false;
      precisionMaskingToggle.checked = false;
    }
  } else {
    deactivatePrecisionMasking();
  }
}

/** Show/hide the "outdated" badge when brush size changes while precision is active. */
function checkPrecisionOutdated() {
  if (!precisionMaskingEnabled || !precisionEdgeLength) return;
  const neededEdge = computePrecisionEdgeLength(parseFloat(exclBrushRadiusSlider.value));
  // Show outdated if the needed edge is significantly smaller than current
  // (brush shrank → mesh too coarse for the new brush size)
  if (neededEdge < precisionEdgeLength * 0.8) {
    precisionOutdated.classList.remove('hidden');
    precisionRefreshBtn.classList.remove('hidden');
  } else {
    precisionOutdated.classList.add('hidden');
    precisionRefreshBtn.classList.add('hidden');
  }
}

/**
 * Toggle displacement preview on/off.
 * When enabled: subdivides the current geometry to a moderate resolution,
 * computes smooth normals, and switches the viewer to the subdivided
 * geometry with vertex-shader displacement.
 * When disabled: reverts to the original geometry with bump-only preview.
 */
async function toggleDisplacementPreview(enable) {
  settings.useDisplacement = enable;

  // Exit surface masking mode when the 3D preview is activated
  if (enable && exclusionTool) {
    setExclusionTool(null);
  }

  // Deactivate precision masking when displacement preview is activated
  if (enable && precisionMaskingEnabled) {
    deactivatePrecisionMasking();
  }

  if (!enable) {
    // Revert to original geometry with bump-only shading.
    if (currentGeometry && previewMaterial) {
      updateMaterial(previewMaterial, getEffectiveMapEntry()?.texture, { ...settings, bounds: currentBounds });
      updateFaceMask(currentGeometry);
      setMeshGeometry(currentGeometry);
    }
    // Dispose the subdivided preview geometry (no longer on the mesh)
    if (dispPreviewGeometry) {
      dispPreviewGeometry.dispose();
      dispPreviewGeometry = null;
    }
    dispPreviewParentMap = null;
    return;
  }

  // Need a model and texture to subdivide
  if (!currentGeometry || !currentBounds || !activeMapEntry) {
    dispPreviewToggle.checked = false;
    settings.useDisplacement = false;
    return;
  }

  if (dispPreviewBusy) return;
  const myToken = ++dispPreviewToken;
  dispPreviewBusy = true;

  try {
    // Choose a preview edge length: coarser than export for performance.
    // Target ~maxDim/80 so a 50 mm cube gets ~0.6 mm edges → ~100 k triangles.
    const maxDim = Math.max(currentBounds.size.x, currentBounds.size.y, currentBounds.size.z);
    const previewEdge = Math.max(0.1, maxDim / 80);

    await yieldFrame();
    if (dispPreviewToken !== myToken) return;

    const { geometry: subdivided, faceParentId } = await subdivide(
      currentGeometry, previewEdge, null, null, { fast: true }
    );
    if (dispPreviewToken !== myToken) { subdivided.dispose(); return; }

    addSmoothNormals(subdivided);
    addFaceNormals(subdivided);

    // Dispose previous preview geometry if any
    if (dispPreviewGeometry) dispPreviewGeometry.dispose();
    dispPreviewGeometry = subdivided;

    // Use the face parent IDs tracked through subdivision (O(n) instead of spatial search)
    dispPreviewParentMap = faceParentId;
    updateFaceMask(subdivided);

    // Force material recreation so it binds the new geometry with smoothNormal
    if (previewMaterial) {
      previewMaterial.dispose();
      previewMaterial = null;
    }
    const fullSettings = { ...settings, bounds: currentBounds };
    previewMaterial = createPreviewMaterial(getEffectiveMapEntry().texture, fullSettings);
    setMeshGeometry(dispPreviewGeometry);
    setMeshMaterial(previewMaterial);


  } catch (err) {
    console.error('Displacement preview failed:', err);
    dispPreviewToggle.checked = false;
    settings.useDisplacement = false;
  } finally {
    dispPreviewBusy = false;
  }
}

// ── Export pipeline ───────────────────────────────────────────────────────────

/**
 * Builds per-non-indexed-vertex weights (1.0 = excluded from subdivision/displacement)
 * that combine the user-painted exclusion set AND the top/bottom angle mask.
 */
function buildCombinedFaceWeights(geometry, excludedFaces, invert, settings) {
  const weights = buildFaceWeights(geometry, excludedFaces, invert);

  const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
  if (!hasAngleMask) return weights;

  const posAttr = geometry.attributes.position;
  const triCount = posAttr.count / 3;
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNrm = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    if (weights[t * 3] > 0.99) continue; // already excluded
    vA.fromBufferAttribute(posAttr, t * 3);
    vB.fromBufferAttribute(posAttr, t * 3 + 1);
    vC.fromBufferAttribute(posAttr, t * 3 + 2);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    faceNrm.crossVectors(edge1, edge2);
    const faceArea  = faceNrm.length();
    const faceNzNorm = faceArea > 1e-12 ? faceNrm.z / faceArea : 0;
    const faceAngle  = Math.acos(Math.abs(faceNzNorm)) * (180 / Math.PI);
    const angleMasked = faceNzNorm < 0
      ? (settings.bottomAngleLimit > 0 && faceAngle <= settings.bottomAngleLimit)
      : (settings.topAngleLimit    > 0 && faceAngle <= settings.topAngleLimit);
    if (angleMasked) {
      weights[t * 3]     = 1.0;
      weights[t * 3 + 1] = 1.0;
      weights[t * 3 + 2] = 1.0;
    }
  }
  return weights;
}

async function handleExport(format = 'stl') {
  if (!currentGeometry || !activeMapEntry || isExporting) return;
  const myToken = ++exportToken;
  isExporting = true;
  exportBtn.classList.add('busy');
  export3mfBtn.classList.add('busy');
  exportProgress.classList.remove('hidden');

  // If precision masking is active, bake the refined mesh before exporting
  if (precisionMaskingEnabled) {
    deactivatePrecisionMasking();
  }

  // Hoist intermediate geometries so the finally block can always dispose them
  let subdivided      = null;
  let displaced       = null;
  let finalGeometry   = null;
  let exportSucceeded = false; // set true only after exportSTL so finally can clean up on abort/error
  const stageStats = { maxObservedMB: 0 };

  try {
    setProgress(0.02, t('progress.subdividing'));
    await yieldFrame();
    if (exportToken !== myToken) return;

    // Build per-vertex exclusion weights combining user-painted exclusion + angle masking.
    // Faces masked by top/bottom angle limits are treated the same as user-excluded faces
    // so subdivision skips their interior edges too, saving triangles where no
    // displacement will be applied.
    const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
    const faceWeights = (excludedFaces.size > 0 || selectionMode || hasAngleMask)
      ? buildCombinedFaceWeights(currentGeometry, excludedFaces, selectionMode, settings)
      : null;

    const exportEntry = getEffectiveMapEntry();
    let safetyCapHit = false;
    let workerDecimationFailed = false;
    let workerStageTriCounts = null;
    try {
      ({ geometry: displaced, safetyCapHit, decimationFailed: workerDecimationFailed, stageTriCounts: workerStageTriCounts } =
        await runSubdivideDisplaceWorker(faceWeights, exportEntry, myToken));
      if (EXPORT_STAGE_DEBUG) {
        await runExportParityTriangleCheck(faceWeights, exportEntry, myToken, workerStageTriCounts);
        if (exportToken !== myToken) return;
      }
    } catch (workerErr) {
      const permanentFallback = exportWorkerState === 'permanent-fallback';
      const workerTelemetryState = permanentFallback ? 'permanent-fallback' : 'fallback-this-run';
      const reason = workerErr?.message || String(workerErr);
      console.warn(
        `[export][worker-path:${workerTelemetryState}] ` +
        (permanentFallback
          ? 'Worker path is disabled; main-thread fallback is now permanent.'
          : 'Worker path failed this export; using main-thread fallback for this run.'),
        { reason, workerState: exportWorkerState }
      );
      ({ geometry: subdivided, safetyCapHit } = await subdivide(
        currentGeometry, settings.refineLength,
        (p, triCount, longestEdge) => {
          const label = triCount != null
            ? t('progress.refining', { cur: triCount.toLocaleString(), edge: longestEdge.toFixed(2) })
            : t('progress.subdividing');
          setProgress(0.02 + p * 0.35, label);
        },
        faceWeights
      ));
      if (exportToken !== myToken) return;

      const subTriCount = subdivided.attributes.position.count / 3;
      setProgress(0.38, t('progress.applyingDisplacement', { n: subTriCount.toLocaleString() }));

      displaced = await runAsync(() =>
        applyDisplacement(
          subdivided,
          exportEntry.imageData,
          exportEntry.width,
          exportEntry.height,
          settings,
          currentBounds,
          (p) => setProgress(0.38 + p * 0.32, t('progress.displacingVertices'))
        )
      );
      if (exportToken !== myToken) return;

      // Free subdivided geometry immediately after handoff to displacement stage.
      releaseGeometryBuffers(subdivided, 'subdivision->displacement');
      subdivided = null;
      observeExportStage('displacement', displaced, stageStats);
    }
    if (exportToken !== myToken) return;

    const dispTriCount = displaced.attributes.position.count / 3;
    lastVaseMetrics = displaced.userData?.vaseMetrics || null;
    const needsDecimation = dispTriCount > settings.maxTriangles;
    triLimitWarning.classList.toggle('hidden', !safetyCapHit);
    triLimitWarning.textContent = t('warnings.safetyCapHit');

    finalGeometry = displaced;
    if (needsDecimation) {
      if (workerDecimationFailed) {
        console.warn('Worker decimation failed, running main-thread decimation fallback.');
      }
      setProgress(0.71, t('progress.decimatingTo', { from: dispTriCount.toLocaleString(), to: settings.maxTriangles.toLocaleString() }));
      finalGeometry = await runAsync(() =>
        decimate(
          displaced,
          settings.maxTriangles,
          (p) => {
            const cur = Math.round(dispTriCount - (dispTriCount - settings.maxTriangles) * p);
            setProgress(
              0.71 + p * 0.25,
              t('progress.decimating', { cur: cur.toLocaleString(), to: settings.maxTriangles.toLocaleString() })
            );
          }
        )
      );
      observeExportStage('decimation', finalGeometry, stageStats);
      // Free pre-decimation geometry immediately after handoff to decimation output.
      releaseGeometryBuffers(displaced, 'displacement->decimation');
      displaced = null;
	  if (exportToken !== myToken) return;
    } else {
      observeExportStage('decimation-skipped', finalGeometry, stageStats);
    }

    // Flat-bottom clamp: when bottom faces are masked (bottomAngleLimit > 0),
    // any vertex that ended up below the original model's bottom layer gets
    // snapped back up to that Z. Single pass with selective normal recomputation.
    if (settings.bottomAngleLimit > 0) {
      const bottomZ = currentBounds.min.z;
      const pa = finalGeometry.attributes.position.array;
      const na = finalGeometry.attributes.normal ? finalGeometry.attributes.normal.array : new Float32Array(pa.length);

      for (let i = 0; i < pa.length; i += 9) {
        let dirty = false;
        if (pa[i+2] < bottomZ) { pa[i+2] = bottomZ; dirty = true; }
        if (pa[i+5] < bottomZ) { pa[i+5] = bottomZ; dirty = true; }
        if (pa[i+8] < bottomZ) { pa[i+8] = bottomZ; dirty = true; }

        if (dirty) {
          const ux = pa[i+3]-pa[i],   uy = pa[i+4]-pa[i+1], uz = pa[i+5]-pa[i+2];
          const vx = pa[i+6]-pa[i],   vy = pa[i+7]-pa[i+1], vz = pa[i+8]-pa[i+2];
          const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
          const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
          na[i]   = na[i+3] = na[i+6] = nx/len;
          na[i+1] = na[i+4] = na[i+7] = ny/len;
          na[i+2] = na[i+5] = na[i+8] = nz/len;
        }
      }

      finalGeometry.attributes.position.needsUpdate = true;
      if (!finalGeometry.attributes.normal) finalGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(na, 3));
      else finalGeometry.attributes.normal.needsUpdate = true;
    }

    const texLabel = activeMapEntry.isCustom ? 'custom' : activeMapEntry.name.replace(/\s+/g, '-');
    const ampLabel = settings.amplitude.toFixed(2).replace('.', 'p');
    const baseName = `${currentStlName}_${texLabel}_amp${ampLabel}`;

    if (format === '3mf') {
      setProgress(0.97, t('progress.writing3mf'));
      await yieldFrame();
      if (exportToken !== myToken) return;
      observeExportStage('write-3mf', finalGeometry, stageStats);
      export3MF(finalGeometry, `${baseName}.3mf`);
    } else {
      setProgress(0.97, t('progress.writingStl'));
      await yieldFrame();
      if (exportToken !== myToken) return;
      observeExportStage('write-stl', finalGeometry, stageStats);
      exportSTL(finalGeometry, `${baseName}.stl`);
    }
    releaseGeometryBuffers(finalGeometry, 'write-complete');
    finalGeometry = null;
    exportSucceeded = true;

    const doneLabel = EXPORT_STAGE_DEBUG && stageStats.maxObservedMB > 0
      ? `${t('progress.done')} · max ~${stageStats.maxObservedMB.toFixed(1)} MB`
      : t('progress.done');
    setProgress(1.0, doneLabel);
    if (EXPORT_STAGE_DEBUG && stageStats.maxObservedMB > 0) {
      console.info(
        `[export][summary] max-observed-buffer-estimate=${stageStats.maxObservedMB.toFixed(2)} MB`
      );
      if (stageStats.maxObservedMB > 512) {
        console.warn(
          `[export][warning] high peak stage estimate (${stageStats.maxObservedMB.toFixed(2)} MB)`
        );
      }
    }
    setTimeout(() => {
      exportProgress.classList.add('hidden');
      setProgress(0, '');
    }, 1500);
  } catch (err) {
    console.error('Export failed:', err);
    if (/maximum size|out of memory|alloc/i.test(err.message)) {
      alert(t('alerts.exportOOM'));
    } else {
      alert(t('alerts.exportFailed', { msg: err.message }));
    }
  } finally {
    // Dispose all intermediate geometries regardless of success, failure, or abort.
    // finalGeometry may alias displaced (no decimation) — avoid double-dispose.
    if (subdivided) releaseGeometryBuffers(subdivided, 'finally-subdivided');
    if (displaced && displaced !== subdivided) releaseGeometryBuffers(displaced, 'finally-displaced');
    if (finalGeometry && finalGeometry !== displaced && finalGeometry !== subdivided) {
      releaseGeometryBuffers(finalGeometry, 'finally-final');
    }
    // Hide progress immediately on error or stale abort; success hides it after 1500 ms.
    if (!exportSucceeded) exportProgress.classList.add('hidden');
    isExporting = false;
    exportBtn.classList.remove('busy');
    export3mfBtn.classList.remove('busy');
  }
}

function setProgress(fraction, label) {
  const pct = Math.round(fraction * 100);
  exportProgBar.style.width = `${pct}%`;
  exportProgPct.textContent = `${pct}%`;
  exportProgLbl.textContent = label;
}

function estimateGeometryBufferMB(geo) {
  if (!geo?.attributes) return 0;
  let bytes = 0;
  for (const attr of Object.values(geo.attributes)) {
    if (attr?.array?.byteLength) bytes += attr.array.byteLength;
  }
  if (geo.index?.array?.byteLength) bytes += geo.index.array.byteLength;
  return bytes / (1024 * 1024);
}

function observeExportStage(stageName, geo, stageStats) {
  if (!geo?.attributes?.position) return;
  const triCount = geo.attributes.position.count / 3;
  const estimateMB = estimateGeometryBufferMB(geo);
  if (stageStats && estimateMB > stageStats.maxObservedMB) stageStats.maxObservedMB = estimateMB;
  if (EXPORT_STAGE_DEBUG) {
    console.info(
      `[export][stage] ${stageName} | tris=${triCount.toLocaleString()} | buffers~${estimateMB.toFixed(2)} MB`
    );
  }
}

function releaseGeometryBuffers(geo, label = '') {
  if (!geo) return;
  if (EXPORT_STAGE_DEBUG) {
    const mb = estimateGeometryBufferMB(geo);
    console.info(`[export][release] ${label || 'geometry'} | buffers~${mb.toFixed(2)} MB`);
  }
  if (geo.attributes) {
    for (const name of Object.keys(geo.attributes)) geo.deleteAttribute(name);
  }
  geo.setIndex(null);
  geo.dispose();
}

/**
 * Yield to the browser event loop, then run fn.
 * Uses setTimeout instead of rAF so it fires even in background tabs.
 */
function runAsync(fn) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(fn()); }
      catch (e) { reject(e); }
    }, 0);
  });
}

/** Yield to the browser event loop (for progress bar paints etc.). */
function yieldFrame() {
  return new Promise(r => setTimeout(r, 0));
}

function _ensureExportWorker() {
  if (exportWorkerState === 'permanent-fallback') {
    throw new Error(exportWorkerReason || 'Export worker disabled: permanent fallback mode.');
  }
  if (exportWorker) return exportWorker;
  try {
    exportWorker = new Worker('./js/workers/subdivideDisplaceWorker.js', { type: 'module' });
  } catch (err) {
    exportWorkerState = 'permanent-fallback';
    exportWorkerReason = err?.message || String(err);
    throw new Error(`Export worker init failed (permanent fallback): ${exportWorkerReason}`);
  }
  return exportWorker;
}

async function runSubdivideDisplaceWorker(faceWeights, exportEntry, myToken) {
  if (typeof Worker === 'undefined') {
    throw new Error('Web Workers are not available in this browser.');
  }

  const worker = _ensureExportWorker();
  const pos = currentGeometry.attributes.position.array;
  const nrm = currentGeometry.attributes.normal.array;
  const posCopy = new Float32Array(pos);
  const nrmCopy = new Float32Array(nrm);
  const texCopy = new Uint8ClampedArray(exportEntry.imageData.data);
  const exwCopy = faceWeights ? new Float32Array(faceWeights) : null;

  const payload = {
    type: 'run',
    geometry: {
      position: posCopy,
      normal: nrmCopy,
      excludeWeight: exwCopy,
    },
    texture: {
      data: texCopy,
      width: exportEntry.width,
      height: exportEntry.height,
    },
    refineLength: settings.refineLength,
    maxTriangles: settings.maxTriangles,
    decimationOptions: {},
    settings: { ...settings },
    debugStageStats: EXPORT_STAGE_DEBUG,
    bounds: {
      min: { x: currentBounds.min.x, y: currentBounds.min.y, z: currentBounds.min.z },
      max: { x: currentBounds.max.x, y: currentBounds.max.y, z: currentBounds.max.z },
      size: { x: currentBounds.size.x, y: currentBounds.size.y, z: currentBounds.size.z },
      center: { x: currentBounds.center.x, y: currentBounds.center.y, z: currentBounds.center.z },
    },
  };

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
    };

    const onMessage = (evt) => {
      if (exportToken !== myToken) {
        cleanup();
        reject(new Error('Stale export worker result'));
        return;
      }
      const data = evt.data;
      if (!data) return;
      if (data.type === 'progress') {
        if (data.phase === 'subdivide') {
          const label = data.triCount != null
            ? t('progress.refining', { cur: data.triCount.toLocaleString(), edge: data.longestEdge.toFixed(2) })
            : t('progress.subdividing');
          setProgress(0.02 + (data.fraction ?? 0) * 0.35, label);
        } else if (data.phase === 'displace') {
          setProgress(0.38 + (data.fraction ?? 0) * 0.32, t('progress.displacingVertices'));
        } else if (data.phase === 'decimate') {
          const triCount = data.triCount ?? 0;
          const target = data.targetTriangles ?? settings.maxTriangles;
          if (data.failed) {
            setProgress(0.96, t('progress.decimatingTo', {
              from: triCount.toLocaleString(),
              to: target.toLocaleString(),
            }));
          } else {
            setProgress(
              0.71 + (data.fraction ?? 0) * 0.25,
              t('progress.decimating', {
                cur: triCount.toLocaleString(),
                to: target.toLocaleString(),
              })
            );
          }
        }
        return;
      }
      if (data.type === 'result') {
        cleanup();
        exportWorkerState = 'operational';
        exportWorkerReason = '';
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
        resolve({
          geometry: geo,
          safetyCapHit: !!data.safetyCapHit,
          decimationFailed: !!data.decimationFailed,
          stageTriCounts: data.stageTriCounts || null,
        });
        return;
      }
      if (data.type === 'error') {
        cleanup();
        reject(new Error(data.message || 'Worker processing failed'));
      }
    };
    const onError = (evt) => {
      cleanup();
      if (exportWorker) {
        exportWorker.terminate();
        exportWorker = null;
      }
      exportWorkerState = 'permanent-fallback';
      exportWorkerReason = evt?.message || 'Worker runtime error';
      reject(new Error(`Export worker runtime error (permanent fallback): ${exportWorkerReason}`));
    };
    const onMessageError = () => {
      cleanup();
      reject(new Error('Export worker message transport error'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    worker.postMessage(payload, [
      payload.geometry.position.buffer,
      payload.geometry.normal.buffer,
      payload.texture.data.buffer,
      ...(payload.geometry.excludeWeight ? [payload.geometry.excludeWeight.buffer] : []),
    ]);
  });
}

async function runExportParityTriangleCheck(faceWeights, exportEntry, myToken, workerStageTriCounts) {
  if (!workerStageTriCounts) return;

  let fallbackSubdivided = null;
  let fallbackDisplaced = null;
  let fallbackFinal = null;
  try {
    ({ geometry: fallbackSubdivided } = await subdivide(
      currentGeometry,
      settings.refineLength,
      null,
      faceWeights
    ));
    if (exportToken !== myToken) return;

    fallbackDisplaced = await runAsync(() =>
      applyDisplacement(
        fallbackSubdivided,
        exportEntry.imageData,
        exportEntry.width,
        exportEntry.height,
        settings,
        currentBounds
      )
    );
    if (exportToken !== myToken) return;

    fallbackFinal = fallbackDisplaced;
    const fallbackDispTriCount = fallbackDisplaced.attributes.position.count / 3;
    if (fallbackDispTriCount > settings.maxTriangles) {
      fallbackFinal = await runAsync(() =>
        decimate(
          fallbackDisplaced,
          settings.maxTriangles
        )
      );
      if (exportToken !== myToken) return;
    }

    const fallbackStageTriCounts = {
      subdivision: fallbackSubdivided.attributes.position.count / 3,
      displacement: fallbackDisplaced.attributes.position.count / 3,
      final: fallbackFinal.attributes.position.count / 3,
    };

    if (
      fallbackStageTriCounts.subdivision !== workerStageTriCounts.subdivision ||
      fallbackStageTriCounts.displacement !== workerStageTriCounts.displacement ||
      fallbackStageTriCounts.final !== workerStageTriCounts.final
    ) {
      console.error('[export][debug-parity] Worker/fallback triangle-count mismatch.', {
        worker: workerStageTriCounts,
        fallback: fallbackStageTriCounts,
      });
    } else {
      console.info('[export][debug-parity] Worker/fallback triangle counts match.', workerStageTriCounts);
    }
  } finally {
    if (fallbackSubdivided) releaseGeometryBuffers(fallbackSubdivided, 'debug-parity-subdivided');
    if (fallbackDisplaced && fallbackDisplaced !== fallbackSubdivided) {
      releaseGeometryBuffers(fallbackDisplaced, 'debug-parity-displaced');
    }
    if (fallbackFinal && fallbackFinal !== fallbackDisplaced && fallbackFinal !== fallbackSubdivided) {
      releaseGeometryBuffers(fallbackFinal, 'debug-parity-final');
    }
  }
}
