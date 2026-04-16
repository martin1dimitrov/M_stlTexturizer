import * as THREE from 'three';

export function makeNonIndexedCubeFixture(size = 20) {
  const geo = new THREE.BoxGeometry(size, size, size).toNonIndexed();
  geo.computeVertexNormals();
  return {
    position: new Float32Array(geo.attributes.position.array),
    normal: new Float32Array(geo.attributes.normal.array),
  };
}

export function makeBoundsForCube(size = 20) {
  const half = size / 2;
  return {
    min: { x: -half, y: -half, z: -half },
    max: { x: half, y: half, z: half },
    center: { x: 0, y: 0, z: 0 },
    size: { x: size, y: size, z: size },
  };
}
