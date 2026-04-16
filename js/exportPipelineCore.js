import * as THREE from 'three';
import { subdivide } from './subdivision.js';
import { applyDisplacement } from './displacement.js';
import { decimate } from './decimation.js';

export function buildGeometry(position, normal, excludeWeight = null) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  if (excludeWeight) geo.setAttribute('excludeWeight', new THREE.BufferAttribute(excludeWeight, 1));
  return geo;
}

export async function runWorkerStylePipeline({ geometry, texture, settings, bounds, refineLength, maxTriangles = Infinity, decimationOptions = null }) {
  const input = buildGeometry(geometry.position, geometry.normal, geometry.excludeWeight);
  const subdivResult = await subdivide(input, refineLength, null, null);
  const displaced = applyDisplacement(
    subdivResult.geometry,
    { data: texture.data },
    texture.width,
    texture.height,
    settings,
    bounds,
    null
  );

  const dispTriCount = displaced.attributes.position.count / 3;
  const needsDecimation = dispTriCount > maxTriangles;
  let finalGeometry = displaced;
  let decimationFailed = false;

  if (needsDecimation) {
    try {
      finalGeometry = await decimate(displaced, maxTriangles, null, decimationOptions);
    } catch {
      decimationFailed = true;
      finalGeometry = displaced;
    }
  }

  const position = finalGeometry.attributes.position.array;
  const normal = finalGeometry.attributes.normal.array;
  return {
    safetyCapHit: subdivResult.safetyCapHit,
    decimationFailed,
    position,
    normal,
    vaseMetrics: displaced.userData?.vaseMetrics || null,
    triangleCount: position.length / 9,
  };
}

export async function runFallbackPipeline(opts) {
  return runWorkerStylePipeline(opts);
}
