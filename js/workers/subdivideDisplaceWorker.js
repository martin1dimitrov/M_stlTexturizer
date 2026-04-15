import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
import { subdivide } from '../subdivision.js';
import { applyDisplacement } from '../displacement.js';

function buildGeometry(position, normal, excludeWeight = null) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  if (excludeWeight) geo.setAttribute('excludeWeight', new THREE.BufferAttribute(excludeWeight, 1));
  return geo;
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

function observeStage(debugStageStats, stageName, geo, stageStats) {
  if (!geo?.attributes?.position) return;
  const triCount = geo.attributes.position.count / 3;
  const estimateMB = estimateGeometryBufferMB(geo);
  stageStats.maxObservedMB = Math.max(stageStats.maxObservedMB, estimateMB);
  if (debugStageStats) {
    console.info(
      `[worker-export][stage] ${stageName} | tris=${triCount.toLocaleString()} | buffers~${estimateMB.toFixed(2)} MB`
    );
  }
}

function releaseGeometryBuffers(geo, label = '', debugStageStats = false) {
  if (!geo) return;
  if (debugStageStats) {
    const mb = estimateGeometryBufferMB(geo);
    console.info(`[worker-export][release] ${label || 'geometry'} | buffers~${mb.toFixed(2)} MB`);
  }
  if (geo.attributes) {
    for (const name of Object.keys(geo.attributes)) geo.deleteAttribute(name);
  }
  geo.setIndex(null);
  geo.dispose();
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'run') return;

  let subdivided = null;
  let displaced = null;
  const stageStats = { maxObservedMB: 0 };

  try {
    const geometry = buildGeometry(msg.geometry.position, msg.geometry.normal, msg.geometry.excludeWeight);
    observeStage(msg.debugStageStats, 'input', geometry, stageStats);

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
    observeStage(msg.debugStageStats, 'subdivision', subdivided, stageStats);

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
    observeStage(msg.debugStageStats, 'displacement', displaced, stageStats);

    const outPos = displaced.attributes.position.array;
    const outNrm = displaced.attributes.normal.array;

    self.postMessage(
      {
        type: 'result',
        safetyCapHit: subdivResult.safetyCapHit,
        maxObservedMB: stageStats.maxObservedMB,
        position: outPos,
        normal: outNrm,
      },
      [outPos.buffer, outNrm.buffer]
    );

    releaseGeometryBuffers(geometry, 'input->subdivision', msg.debugStageStats);
    releaseGeometryBuffers(subdivided, 'subdivision->displacement', msg.debugStageStats);
    subdivided = null;
    releaseGeometryBuffers(displaced, 'displacement->result', msg.debugStageStats);
    displaced = null;
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  } finally {
    if (subdivided) releaseGeometryBuffers(subdivided, 'finally-subdivided', msg?.debugStageStats);
    if (displaced) releaseGeometryBuffers(displaced, 'finally-displaced', msg?.debugStageStats);
  }
};
