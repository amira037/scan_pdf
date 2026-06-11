/* ============================================================
   correction-worker.js
   Runs the heavy scan-correction pixel pipeline OFF the main
   thread so the UI never freezes. Ported from v3's in-page
   functions; operates on ImageData via OffscreenCanvas.

   Protocol
   --------
   main → worker:
     { type:'process', id, bitmap:ImageBitmap,
       opts:{ deskew:bool, colorMode:'auto'|'bw'|'gray'|'color',
              enhance:bool, quality:0..1 } }
   worker → main:
     { type:'done', id, format:'png'|'jpeg', mode, angle, bytes:Uint8Array }
     { type:'error', id, message }
   ============================================================ */

importScripts('https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js');

self.onmessage = async (e) => {
  const m = e.data;
  if (!m || m.type !== 'process') return;
  try {
    const r = await processPage(m.bitmap, m.opts || {});
    if (m.bitmap.close) m.bitmap.close();
    self.postMessage(
      { type: 'done', id: m.id, format: r.format, mode: r.mode, angle: r.angle, bytes: r.bytes },
      [r.bytes.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};

/* ---------- OffscreenCanvas helpers ---------- */
function off(w, h) {
  const c = new OffscreenCanvas(w, h);
  return { c, ctx: c.getContext('2d', { willReadFrequently: true }) };
}
function bitmapToImageData(bitmap) {
  const { c, ctx } = off(bitmap.width, bitmap.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}
function scaleImageData(img, targetW) {
  if (img.width <= targetW) return img;
  const s = targetW / img.width;
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const src = off(img.width, img.height); src.ctx.putImageData(img, 0, 0);
  const dst = off(w, h); dst.ctx.drawImage(src.c, 0, 0, w, h);
  return dst.ctx.getImageData(0, 0, w, h);
}
function rotateImageData(img, deg) {
  const src = off(img.width, img.height); src.ctx.putImageData(img, 0, 0);
  const dst = off(img.width, img.height);
  dst.ctx.fillStyle = '#fff';
  dst.ctx.fillRect(0, 0, img.width, img.height);
  dst.ctx.translate(img.width / 2, img.height / 2);
  dst.ctx.rotate(deg * Math.PI / 180);
  dst.ctx.drawImage(src.c, -img.width / 2, -img.height / 2);
  return dst.ctx.getImageData(0, 0, img.width, img.height);
}

/* ---------- skew: detect → rotate → re-check (v3 logic) ---------- */
function detectSkewAngle(img) {
  const W = img.width, H = img.height, data = img.data;
  const gray = new Uint8Array(W * H);
  const hist = new Int32Array(256);
  for (let i = 0; i < W * H; i++) {
    const g = Math.round(.299 * data[i*4] + .587 * data[i*4+1] + .114 * data[i*4+2]);
    gray[i] = g; hist[g]++;
  }
  const total = W * H;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, wF = 0, maxV = 0, thresh = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > maxV) { maxV = v; thresh = t; }
  }
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = gray[i] < thresh ? 1 : 0;
  const x0 = Math.round(W*.2), x1 = Math.round(W*.8), y0 = Math.round(H*.1), y1 = Math.round(H*.9);
  const cX = W / 2, cY = H / 2;
  let bestA = 0, bestV = -1;
  for (let deg = -5; deg <= 5; deg += .25) {
    const rad = deg * Math.PI / 180, cosA = Math.cos(rad), sinA = Math.sin(rad);
    const rc = new Int32Array(H);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!bin[y*W+x]) continue;
      const ry = Math.round((y - cY) * cosA - (x - cX) * sinA + cY);
      if (ry >= 0 && ry < H) rc[ry]++;
    }
    let s = 0, s2 = 0, n = y1 - y0;
    for (let y = y0; y < y1; y++) { s += rc[y]; s2 += rc[y] ** 2; }
    const v = s2 / n - (s / n) ** 2;
    if (v > bestV) { bestV = v; bestA = deg; }
  }
  return Math.round(bestA * 10) / 10;
}
function deskew(img) {
  const angle = detectSkewAngle(scaleImageData(img, 500));
  if (Math.abs(angle) < 1.0 || Math.abs(angle) >= 4.9) return { img, angle: 0 };
  const rotated = rotateImageData(img, -angle);
  const residual = detectSkewAngle(scaleImageData(rotated, 500));
  if (Math.abs(residual) > Math.abs(angle) * 0.5) return { img, angle: 0 }; // not improved → revert
  return { img: rotated, angle: -angle };
}

/* ---------- colour analysis & tone ops (v3 logic, on ImageData) ---------- */
function detectColorful(img) {
  const s = scaleImageData(img, 200), d = s.data, tot = s.width * s.height;
  let colored = 0;
  for (let i = 0; i < tot; i++) {
    const r = d[i*4], g = d[i*4+1], b = d[i*4+2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn > 40 && mx > 40) colored++;
  }
  return colored / tot > 0.02;
}
function desaturate(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]) | 0;
    d[i] = d[i+1] = d[i+2] = l;
  }
}
function contrastStretch(img) {
  const d = img.data, n = img.width * img.height, hist = new Int32Array(256);
  for (let i = 0; i < n; i++) hist[(0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2]) | 0]++;
  const loC = n * 0.005, hiC = n * 0.005;
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= loC) { lo = i; break; } }
  acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= hiC) { hi = i; break; } }
  if (hi - lo < 8) return;
  const scale = 255 / (hi - lo);
  for (let i = 0; i < d.length; i += 4)
    for (let k = 0; k < 3; k++) d[i+k] = Math.max(0, Math.min(255, (d[i+k] - lo) * scale));
}
function adaptiveThreshold(img) {
  const W = img.width, H = img.height, d = img.data;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = 0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2];
  const SW = W + 1;
  const ii = new Float64Array(SW * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0;
    for (let x = 0; x < W; x++) { rs += gray[y*W+x]; ii[(y+1)*SW + (x+1)] = ii[y*SW + (x+1)] + rs; }
  }
  const r = Math.max(8, Math.round(Math.min(W, H) * 0.02)), C = 10;
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = ii[(y1+1)*SW + (x1+1)] - ii[y0*SW + (x1+1)] - ii[(y1+1)*SW + x0] + ii[y0*SW + x0];
      const v = gray[y*W+x] < (sum / area - C) ? 0 : 255;
      const o = (y*W+x) * 4; d[o] = d[o+1] = d[o+2] = v; d[o+3] = 255;
    }
  }
}

/* ---------- encoders ---------- */
async function encodeJpeg(img, quality) {
  const { c, ctx } = off(img.width, img.height);
  ctx.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: quality });
  return new Uint8Array(await blob.arrayBuffer());
}

// --- 1-bit grayscale PNG encoder (verified against Pillow) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + len, crc32(out.subarray(4, 8 + len)));
  return out;
}
function buildPNG(W, H, idat) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H);
  ihdr[8] = 1; ihdr[9] = 0; // 1-bit, grayscale
  const chunks = [pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
  let total = sig.length; chunks.forEach(c => total += c.length);
  const out = new Uint8Array(total);
  let o = 0; out.set(sig, o); o += sig.length;
  chunks.forEach(c => { out.set(c, o); o += c.length; });
  return out;
}
function encodeGray1PNG(img) {
  const W = img.width, H = img.height, d = img.data;
  const rowBytes = (W + 7) >> 3, stride = rowBytes + 1;
  const raw = new Uint8Array(stride * H);
  for (let y = 0; y < H; y++) {
    const rs = y * stride, base = y * W;
    for (let x = 0; x < W; x++) {
      if (d[(base + x) * 4] >= 128) raw[rs + 1 + (x >> 3)] |= (0x80 >> (x & 7));
    }
  }
  const idat = pako.deflate(raw, { level: 9 });
  return buildPNG(W, H, idat);
}

/* ---------- pipeline ---------- */
async function processPage(bitmap, opts) {
  let img = bitmapToImageData(bitmap);
  let angle = 0;

  if (opts.deskew) {
    const r = deskew(img);
    img = r.img; angle = r.angle;
  }

  let mode = opts.colorMode || 'auto';
  // Auto picks colour vs GRAYSCALE (not 1-bit bw) so charts/shading on
  // non-colour pages survive. True 1-bit bw is opt-in via the 'bw' choice.
  if (mode === 'auto') mode = detectColorful(img) ? 'color' : 'gray';

  if (mode === 'bw') {
    adaptiveThreshold(img);
    return { format: 'png', mode, angle, bytes: encodeGray1PNG(img) };
  }
  if (mode === 'gray') {
    desaturate(img);
    if (opts.enhance) contrastStretch(img);
    return { format: 'jpeg', mode, angle, bytes: await encodeJpeg(img, opts.quality) };
  }
  // color
  if (opts.enhance) contrastStretch(img);
  return { format: 'jpeg', mode, angle, bytes: await encodeJpeg(img, opts.quality) };
}
