let sharp;
try {
  sharp = require('sharp');
} catch (_) {
  sharp = null;
}

const VARIANT_SPECS = [
  { name: 'original', maxWidth: null, quality: 88 },
  { name: '512', maxWidth: 512, quality: 82 },
  { name: '256', maxWidth: 256, quality: 80 },
  { name: 'thumbnail', maxWidth: 128, quality: 72 },
];

async function generateImageVariants(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid image buffer.');
  }
  if (!sharp) {
    return {
      original: { buffer, width: null, height: null },
      '512': { buffer, width: null, height: null },
      '256': { buffer, width: null, height: null },
      thumbnail: { buffer, width: null, height: null },
    };
  }

  const out = {};
  for (const spec of VARIANT_SPECS) {
    let pipeline = sharp(buffer).rotate();
    if (spec.maxWidth) {
      pipeline = pipeline.resize(spec.maxWidth, spec.maxWidth, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const { data, info } = await pipeline
      .webp({ quality: spec.quality })
      .toBuffer({ resolveWithObject: true });
    out[spec.name] = {
      buffer: data,
      width: info.width || null,
      height: info.height || null,
      bytes: data.length,
    };
  }
  return out;
}

module.exports = {
  VARIANT_SPECS,
  generateImageVariants,
  isSharpAvailable: () => Boolean(sharp),
};
