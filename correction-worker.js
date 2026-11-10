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
     (gray → 1-component JPEG, bw → 1-bit gray PNG; both embed as DeviceGray)
     { type:'error', id, message }
   ============================================================ */

importScripts('vendor/pako.min.js');

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

// --- 1-channel baseline JPEG encoder ---
// Canvas convertToBlob always emits 3-component (YCbCr) JPEG, which pdf-lib
// embeds as DeviceRGB even when every pixel is gray. This writes a true
// single-component JPEG so the PDF image is DeviceGray.
const JPG_ZIGZAG = [0,1,5,6,14,15,27,28,2,4,7,13,16,26,29,42,3,8,12,17,25,30,41,43,9,11,18,24,31,40,44,53,
  10,19,23,32,39,45,52,54,20,22,33,38,46,51,55,60,21,34,37,47,50,56,59,61,35,36,48,49,57,58,62,63]; // natural → zigzag pos
const JPG_YQT = [16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,
  18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99];
const JPG_DC_BITS = [0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0];
const JPG_DC_VALS = [0,1,2,3,4,5,6,7,8,9,10,11];
const JPG_AC_BITS = [0,2,1,3,3,2,4,3,5,5,4,4,0,0,1,0x7d];
const JPG_AC_VALS = [
  0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,0x22,0x71,0x14,0x32,0x81,0x91,0xa1,0x08,
  0x23,0x42,0xb1,0xc1,0x15,0x52,0xd1,0xf0,0x24,0x33,0x62,0x72,0x82,0x09,0x0a,0x16,0x17,0x18,0x19,0x1a,0x25,0x26,0x27,0x28,
  0x29,0x2a,0x34,0x35,0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,0x49,0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,
  0x5a,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a,0x83,0x84,0x85,0x86,0x87,0x88,0x89,
  0x8a,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,
  0xb7,0xb8,0xb9,0xba,0xc2,0xc3,0xc4,0xc5,0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,0xe1,0xe2,
  0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9,0xfa];
function jpgHuff(bits, vals) {
  const code = new Uint16Array(256), len = new Uint8Array(256);
  let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]; i++) { code[vals[k]] = c; len[vals[k]] = l; c++; k++; }
    c <<= 1;
  }
  return { code, len };
}
const JPG_DC = jpgHuff(JPG_DC_BITS, JPG_DC_VALS);
const JPG_AC = jpgHuff(JPG_AC_BITS, JPG_AC_VALS);
const JPG_COS = (() => { // COS[u*8+x] = C(u)/2 * cos((2x+1)uπ/16)
  const t = new Float64Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++)
    t[u*8+x] = (u ? 0.5 : Math.SQRT1_2 / 2) * Math.cos((2*x + 1) * u * Math.PI / 16);
  return t;
})();

function encodeGrayJpeg(img, quality) {
  const W = img.width, H = img.height, d = img.data;
  const q = Math.max(1, Math.min(100, Math.round(quality * 100)));
  const sf = q < 50 ? 5000 / q : 200 - q * 2;
  const qt = new Uint8Array(64);
  for (let i = 0; i < 64; i++) qt[i] = Math.max(1, Math.min(255, Math.floor((JPG_YQT[i] * sf + 50) / 100)));

  let buf = new Uint8Array(Math.max(4096, (W * H) >> 2)), pos = 0;
  const put = (b) => {
    if (pos >= buf.length) { const n = new Uint8Array(buf.length * 2); n.set(buf); buf = n; }
    buf[pos++] = b;
  };
  const put16 = (v) => { put(v >> 8); put(v & 0xFF); };
  let bitBuf = 0, bitCnt = 0;
  const putBits = (val, n) => {
    for (let i = n - 1; i >= 0; i--) {
      bitBuf = (bitBuf << 1) | ((val >> i) & 1);
      if (++bitCnt === 8) { put(bitBuf); if (bitBuf === 0xFF) put(0); bitBuf = 0; bitCnt = 0; }
    }
  };
  const putVal = (v) => { // category + magnitude bits
    const a = v < 0 ? -v : v;
    let cat = 0; while ((a >> cat) > 0) cat++;
    return [cat, v < 0 ? v + (1 << cat) - 1 : v];
  };

  // headers: SOI, APP0 JFIF, DQT, SOF0 (1 comp), DHT, SOS
  put16(0xFFD8);
  put16(0xFFE0); put16(16); [0x4A,0x46,0x49,0x46,0,1,1,0].forEach(put); put16(1); put16(1); put(0); put(0);
  put16(0xFFDB); put16(67); put(0);
  const zq = new Uint8Array(64); for (let i = 0; i < 64; i++) zq[JPG_ZIGZAG[i]] = qt[i];
  zq.forEach(put);
  put16(0xFFC0); put16(11); put(8); put16(H); put16(W); put(1); put(1); put(0x11); put(0);
  put16(0xFFC4); put16(2 + 17 + JPG_DC_VALS.length + 17 + JPG_AC_VALS.length);
  put(0x00); JPG_DC_BITS.forEach(put); JPG_DC_VALS.forEach(put);
  put(0x10); JPG_AC_BITS.forEach(put); JPG_AC_VALS.forEach(put);
  put16(0xFFDA); put16(8); put(1); put(1); put(0); put(0); put(63); put(0);

  const blk = new Float64Array(64), tmp = new Float64Array(64), zz = new Int32Array(64);
  let prevDC = 0;
  for (let by = 0; by < H; by += 8) {
    for (let bx = 0; bx < W; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(by + y, H - 1);
        for (let x = 0; x < 8; x++) blk[y*8+x] = d[(sy * W + Math.min(bx + x, W - 1)) * 4] - 128;
      }
      // separable 2-D DCT: rows then columns
      for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
        let s = 0; for (let x = 0; x < 8; x++) s += JPG_COS[u*8+x] * blk[y*8+x];
        tmp[y*8+u] = s;
      }
      for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
        let s = 0; for (let y = 0; y < 8; y++) s += JPG_COS[v*8+y] * tmp[y*8+u];
        const i = v*8+u;
        zz[JPG_ZIGZAG[i]] = Math.round(s / qt[i]);
      }
      // DC
      const [dcCat, dcBits] = putVal(zz[0] - prevDC); prevDC = zz[0];
      putBits(JPG_DC.code[dcCat], JPG_DC.len[dcCat]); if (dcCat) putBits(dcBits, dcCat);
      // AC
      let run = 0;
      for (let k = 1; k < 64; k++) {
        if (zz[k] === 0) { run++; continue; }
        while (run > 15) { putBits(JPG_AC.code[0xF0], JPG_AC.len[0xF0]); run -= 16; }
        const [cat, bits] = putVal(zz[k]);
        const sym = (run << 4) | cat;
        putBits(JPG_AC.code[sym], JPG_AC.len[sym]); putBits(bits, cat);
        run = 0;
      }
      if (run) putBits(JPG_AC.code[0], JPG_AC.len[0]);
    }
  }
  if (bitCnt) putBits(0x7F, 8 - bitCnt); // pad with 1s
  put16(0xFFD9);
  return buf.slice(0, pos);
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
    return { format: 'jpeg', mode, angle, bytes: encodeGrayJpeg(img, opts.quality) };
  }
  // color
  if (opts.enhance) contrastStretch(img);
  return { format: 'jpeg', mode, angle, bytes: await encodeJpeg(img, opts.quality) };
}
