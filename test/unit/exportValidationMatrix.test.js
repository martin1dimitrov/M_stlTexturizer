import { describe, it, expect } from 'vitest';
import { collectExportValidationCore } from '../../js/exportValidationCore.js';

const t = (key, vars = {}) => `${key}:${JSON.stringify(vars)}`;
const baseSettings = {
  maxTriangles: 10,
  vaseModeSafe: false,
  mappingMode: 5,
  vaseRadialGuardMm: 0.05,
};

describe('collectExportValidationCore matrix', () => {
  it('returns mesh diagnostics and capacity warnings when not in vase mode', () => {
    const out = collectExportValidationCore({
      hasGeometry: true,
      triCount: 15,
      settings: baseSettings,
      lastFastDiag: { nonManifoldEdges: 2, openEdges: 4, shellCount: 3 },
      lastAdvancedDiag: { intersectingPairs: 1, overlappingPairs: 7 },
      vaseMetrics: null,
      t,
    });

    expect(out.errors.join(' ')).toContain('diag.nonManifoldEdges');
    expect(out.errors.join(' ')).toContain('diag.intersectingTris');
    expect(out.warnings.join(' ')).toContain('diag.openEdges');
    expect(out.warnings.join(' ')).toContain('diag.multipleShells');
    expect(out.warnings.join(' ')).toContain('diag.overlappingTris');
    expect(out.warnings.join(' ')).toContain('warnings.safetyCapHit');
  });

  it('enforces vase-mode rule matrix (mapping + seam + hf + radial)', () => {
    const out = collectExportValidationCore({
      hasGeometry: true,
      triCount: 2,
      settings: { ...baseSettings, vaseModeSafe: true, mappingMode: 5 },
      lastFastDiag: null,
      lastAdvancedDiag: null,
      vaseMetrics: {
        seamZoneRatio: 0.6,
        attenuatedHFMean: 0.09,
        radialReversalRiskCount: 3,
        maxInwardRiskMm: 0.12,
      },
      t,
    });

    expect(out.errors.some((e) => e.includes('require Cylindrical mapping'))).toBe(true);
    expect(out.errors.some((e) => e.includes('seam continuity is unsafe'))).toBe(true);
    expect(out.errors.some((e) => e.includes('too high-frequency'))).toBe(true);
    expect(out.errors.some((e) => e.includes('Radial reversal risk detected'))).toBe(true);
  });
});
