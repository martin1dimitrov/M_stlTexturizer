import { describe, it, expect } from 'vitest';
import { analyzeTextureQuality, classifyTextureQuality } from '../../js/exportValidationCore.js';
import { seamlessGrayFixture, seamMismatchFixture, colorfulFixture } from '../test-assets/textureFixtures.js';

describe('analyzeTextureQuality', () => {
  it('scores seamless texture edges lower than obvious seam mismatch', () => {
    const seamless = analyzeTextureQuality(seamlessGrayFixture());
    const mismatched = analyzeTextureQuality(seamMismatchFixture());

    expect(seamless.seamScore).toBeLessThan(0.12);
    expect(mismatched.seamScore).toBeGreaterThan(0.12);
    expect(mismatched.seamScore).toBeGreaterThan(seamless.seamScore);
  });

  it('applies threshold classification (error/warn/ok) from metrics', () => {
    const colorful = classifyTextureQuality(analyzeTextureQuality(colorfulFixture()));
    const seamless = classifyTextureQuality(analyzeTextureQuality(seamlessGrayFixture()));

    expect(colorful.severity).toBe('error');
    expect(colorful.issues.some((i) => i.level === 'error')).toBe(true);
    expect(seamless.severity).toBe('ok');
  });
});
