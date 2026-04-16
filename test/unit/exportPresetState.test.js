import { describe, it, expect } from 'vitest';
import { derivePresetSettings } from '../../js/exportValidationCore.js';

describe('applyExportPreset state transitions', () => {
  const base = {
    vaseModeSafe: false,
    refineLength: 1,
    maxTriangles: 750000,
  };

  it('switches to vase safety settings for vase preset', () => {
    const out = derivePresetSettings(base, 'vase');
    expect(out.vaseModeSafe).toBe(true);
    expect(out.refineLength).toBe(0.45);
    expect(out.maxTriangles).toBe(1_200_000);
  });

  it('disables vase mode for non-vase presets', () => {
    const out = derivePresetSettings({ ...base, vaseModeSafe: true }, 'fast');
    expect(out.vaseModeSafe).toBe(false);
    expect(out.refineLength).toBe(1.5);
    expect(out.maxTriangles).toBe(300_000);
  });
});
