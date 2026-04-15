import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
import { subdivide } from '../subdivision.js';
import { applyDisplacement } from '../displacement.js';
import { decimate } from '../decimation.js';

function buildGeometry(position, normal, excludeWeight = null) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  if (excludeWeight) geo.setAttribute('excludeWeight', new THREE.BufferAttribute(excludeWeight, 1));
  return geo;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'run') return;

  let subdivided = null;
  let displaced = null;
  let finalGeometry = null;

  try {
    const geometry = buildGeometry(msg.geometry.position, msg.geometry.normal, msg.geometry.excludeWeight);

    const subdivResult = await subdivide(
      geometry,
      msg.refineLength,
      (p, triCount, longestEdge) => {
        self.postMessage({
          type: 'progress',
          phase: 'subdivide',
          fraction: p,
          triCount,
          longestEdge,
        });
      },
      null
    );

    subdivided = subdivResult.geometry;

    self.postMessage({
      type: 'progress',
      phase: 'displace',
      fraction: 0,
      triCount: subdivided.attributes.position.count / 3,
    });

    const imageData = new ImageData(msg.texture.data, msg.texture.width, msg.texture.height);
    displaced = applyDisplacement(
      subdivided,
      imageData,
      msg.texture.width,
      msg.texture.height,
      msg.settings,
      msg.bounds,
      (p) => self.postMessage({ type: 'progress', phase: 'displace', fraction: p })
    );

    const dispTriCount = displaced.attributes.position.count / 3;
    const maxTriangles = Number.isFinite(msg.maxTriangles) ? msg.maxTriangles : Infinity;
    const needsDecimation = dispTriCount > maxTriangles;
    let decimationFailed = false;

    finalGeometry = displaced;
    if (needsDecimation) {
      self.postMessage({
        type: 'progress',
        phase: 'decimate',
        fraction: 0,
        triCount: dispTriCount,
        targetTriangles: maxTriangles,
      });
      try {
        finalGeometry = await decimate(
          displaced,
          maxTriangles,
          (p) => {
            self.postMessage({
              type: 'progress',
              phase: 'decimate',
              fraction: p,
              triCount: Math.round(dispTriCount - (dispTriCount - maxTriangles) * p),
              targetTriangles: maxTriangles,
            });
          },
          msg.decimationOptions
        );
      } catch (decErr) {
        decimationFailed = true;
        finalGeometry = displaced;
        self.postMessage({
          type: 'progress',
          phase: 'decimate',
          fraction: 1,
          triCount: dispTriCount,
          targetTriangles: maxTriangles,
          failed: true,
          message: decErr?.message || String(decErr),
        });
      }
    }

    const outPos = finalGeometry.attributes.position.array;
    const outNrm = finalGeometry.attributes.normal.array;

    self.postMessage(
      {
        type: 'result',
        safetyCapHit: subdivResult.safetyCapHit,
        decimationFailed,
        position: outPos,
        normal: outNrm,
      },
      [outPos.buffer, outNrm.buffer]
    );

    geometry.dispose();
    subdivided.dispose();
    displaced.dispose();
    if (finalGeometry && finalGeometry !== displaced) finalGeometry.dispose();
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  } finally {
    if (subdivided) subdivided.dispose();
    if (displaced) displaced.dispose();
    if (finalGeometry && finalGeometry !== displaced) finalGeometry.dispose();
  }
};
