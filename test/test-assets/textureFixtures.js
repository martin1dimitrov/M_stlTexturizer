function toImageData(grayMatrix) {
  const height = grayMatrix.length;
  const width = grayMatrix[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const g = grayMatrix[y][x];
      const idx = (y * width + x) * 4;
      data[idx] = g;
      data[idx + 1] = g;
      data[idx + 2] = g;
      data[idx + 3] = 255;
    }
  }
  return { imageData: { data }, width, height };
}

export function seamlessGrayFixture() {
  return toImageData([
    [80, 120, 160, 80],
    [90, 130, 170, 90],
    [100, 140, 180, 100],
    [80, 120, 160, 80],
  ]);
}

export function seamMismatchFixture() {
  return toImageData([
    [0, 30, 30, 255],
    [0, 30, 30, 255],
    [0, 30, 30, 255],
    [255, 255, 255, 0],
  ]);
}

export function colorfulFixture() {
  const width = 2;
  const height = 2;
  const data = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 0, 255,
  ]);
  return { imageData: { data }, width, height };
}

export function displacementTextureFixture() {
  const tex = toImageData([
    [96, 110, 124, 138],
    [105, 120, 135, 150],
    [114, 130, 146, 162],
    [122, 140, 158, 176],
  ]);
  return {
    data: tex.imageData.data,
    width: tex.width,
    height: tex.height,
  };
}
