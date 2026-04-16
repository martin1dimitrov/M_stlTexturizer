import { describe, it, expect } from 'vitest';
import { runWorkerStylePipeline, runFallbackPipeline } from '../../js/exportPipelineCore.js';
import { makeNonIndexedCubeFixture, makeBoundsForCube } from '../test-assets/meshFixtures.js';
import { displacementTextureFixture } from '../test-assets/textureFixtures.js';

const settings = {
  mappingMode: 5,
  scaleU: 0.5,
  scaleV: 0.5,
  amplitude: 0.2,
  offsetU: 0,
  offsetV: 0,
  rotation: 0,
  mappingBlend: 1,
  seamBandWidth: 0.5,
  textureSmoothing: 0,
  capAngle: 20,
  boundaryFalloff: 0,
  symmetricDisplacement: false,
  topAngleLimit: 0,
  bottomAngleLimit: 5,
  vaseModeSafe: false,
  vaseSeamContinuityBias: 0.35,
  vaseCircumferentialAttenuation: 0.65,
  vaseRadialGuardMm: 0.05,
};

describe('worker vs fallback parity', () => {
  it('returns comparable outputs and triangle counts for identical inputs', async () => {
    const geometry = makeNonIndexedCubeFixture(18);
    const texture = displacementTextureFixture();
    const bounds = makeBoundsForCube(18);
    const payload = { geometry, texture, settings, bounds, refineLength: 8.5, maxTriangles: 1_000_000 };

    const workerOut = await runWorkerStylePipeline(payload);
    const fallbackOut = await runFallbackPipeline(payload);

    expect(workerOut.triangleCount).toBe(fallbackOut.triangleCount);
    expect(workerOut.position.length).toBe(fallbackOut.position.length);

    const delta = Math.abs(workerOut.position[0] - fallbackOut.position[0]);
    expect(delta).toBeLessThan(1e-6);
  }, 20000);
});
