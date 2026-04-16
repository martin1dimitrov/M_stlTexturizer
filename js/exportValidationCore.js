export const EXPORT_PRESETS = {
  fast:     { refineLength: 1.5, maxTriangles: 300_000 },
  balanced: { refineLength: 1.0, maxTriangles: 750_000 },
  high:     { refineLength: 0.35, maxTriangles: 2_000_000 },
  vase:     { refineLength: 0.45, maxTriangles: 1_200_000 },
  large:    { refineLength: 1.6, maxTriangles: 500_000 },
};

export function quantileFromHist(hist, q, total) {
  const target = Math.max(0, Math.min(total - 1, Math.floor(q * (total - 1))));
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc > target) return i / 255;
  }
  return 1;
}

export function analyzeTextureQuality(entry) {
  const { imageData, width, height } = entry;
  const data = imageData.data;
  const pxCount = width * height;
  const hist = new Uint32Array(256);
  let sumL = 0;
  let sumL2 = 0;
  let colorDiffSum = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const l = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    hist[l]++;
    sumL += l;
    sumL2 += l * l;
    colorDiffSum += (Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r)) / (3 * 255);
  }

  const mean = sumL / pxCount;
  const variance = Math.max(0, sumL2 / pxCount - mean * mean);
  const stdNorm = Math.sqrt(variance) / 255;
  const p01 = quantileFromHist(hist, 0.01, pxCount);
  const p99 = quantileFromHist(hist, 0.99, pxCount);
  const dynamicRange = Math.max(0, p99 - p01);
  const clipLow = hist[0] / pxCount;
  const clipHigh = hist[255] / pxCount;

  let seamAcc = 0;
  for (let y = 0; y < height; y++) {
    const lOff = (y * width) * 4;
    const rOff = (y * width + (width - 1)) * 4;
    seamAcc += Math.abs(data[lOff] - data[rOff]);
  }
  for (let x = 0; x < width; x++) {
    const tOff = x * 4;
    const bOff = ((height - 1) * width + x) * 4;
    seamAcc += Math.abs(data[tOff] - data[bOff]);
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

export function classifyTextureQuality(metrics) {
  const issues = [];

  if (metrics.grayscaleDeviation > 0.12) {
    issues.push({ level: 'error', message: 'Texture appears to be strongly colored; use a grayscale displacement map.' });
  } else if (metrics.grayscaleDeviation > 0.03) {
    issues.push({ level: 'warn', message: 'Texture is not purely grayscale. Converting to grayscale is recommended.' });
  }

  if (metrics.dynamicRange < 0.10 || metrics.histogramStd < 0.10) {
    issues.push({ level: 'warn', message: 'Low contrast histogram; displacement may look flat.' });
  }

  if (metrics.clipLow + metrics.clipHigh > 0.20) {
    issues.push({ level: 'warn', message: 'Histogram clipping detected; details may crush at min/max height.' });
  }

  if (metrics.seamScore > 0.12) {
    issues.push({ level: 'warn', message: 'High seam mismatch score; tiling seams may be visible.' });
  }

  const severity = issues.some(i => i.level === 'error')
    ? 'error'
    : issues.some(i => i.level === 'warn')
      ? 'warn'
      : 'ok';

  return { issues, severity };
}

export function derivePresetSettings(settings, presetKey) {
  const preset = EXPORT_PRESETS[presetKey];
  if (!preset) return null;
  return {
    ...settings,
    vaseModeSafe: presetKey === 'vase',
    refineLength: preset.refineLength,
    maxTriangles: preset.maxTriangles,
  };
}

export function collectExportValidationCore({
  hasGeometry,
  triCount,
  settings,
  lastFastDiag,
  lastAdvancedDiag,
  vaseMetrics,
  t,
}) {
  const warnings = [];
  const errors = [];

  if (!hasGeometry) return { warnings, errors };

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
      errors.push('Vase Workflow Safeguards require Cylindrical mapping. Set Projection → Cylindrical for Spiral Vase exports.');
    }
    if (!vaseMetrics) {
      errors.push('Vase validation could not run. Load a displacement map and keep Cylindrical mapping enabled for Spiral Vase compatibility checks.');
    } else {
      const seamRisk = (vaseMetrics.seamBlendSamples > 0)
        ? Math.abs(0.5 - vaseMetrics.seamBlendMixMean)
        : vaseMetrics.seamZoneRatio;
      const hfMetric = vaseMetrics.attenuatedHFMean ?? vaseMetrics.circumferentialHFMean;
      const radialRiskCount = vaseMetrics.radialReversalRiskCount ?? vaseMetrics.radialReversalCorrections ?? 0;
      const radialRiskMm = vaseMetrics.maxInwardRiskMm ?? vaseMetrics.maxRadialInwardMm ?? 0;

      if (seamRisk > 0.22) {
        errors.push('Spiral Vase seam continuity is unsafe. Reduce Transition Smoothing or lower texture Scale U to keep the seam band continuous.');
      }
      if (hfMetric > 0.055) {
        errors.push('Circumferential detail is too high-frequency for reliable Spiral Vase walls. Increase texture smoothing or use a softer map.');
      }
      if (radialRiskCount > 0 || radialRiskMm > settings.vaseRadialGuardMm + 1e-4) {
        errors.push(`Radial reversal risk detected (${radialRiskCount} bands, max ${radialRiskMm.toFixed(3)} mm inward). Reduce amplitude or enable symmetric displacement for Spiral Vase.`);
      }
    }
  }

  return { warnings, errors };
}
