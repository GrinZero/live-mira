// Build an alpha-matted foreground plate for the cafe scene.
// Foreground = table + cup + camera + saucer. The wall under the window sill
// (#212f3a family, blue-dominant) must stay OUT of the matte.
// bg and fg are the same pixels, so the matte is only visible where the VRM
// stands (image x ~43-70%); outside that zone we clamp below the table edge.
import sharp from 'sharp';

const SRC = 'assets/bg/cafe_interior.jpg';
const OUT = 'assets/bg/cafe_fg.webp';
const Y0 = 0.75,
  Y1 = 0.985;
const ZONE = [0.425, 0.675]; // precise-detection zone (image x frac)
const SAFE_Y = 0.862; // outside zone: never keep above this

const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
const W = info.width,
  H = info.height,
  C = info.channels;
const px = (x, y) => {
  const i = (y * W + x) * C;
  return [data[i], data[i + 1], data[i + 2]];
};
const lum = (c) => (c[0] * 2 + c[1] * 3 + c[2]) / 6;
const isWall = (c) => c[2] - c[0] > 4 || (lum(c) < 34 && c[2] >= c[0] - 2);

const r0 = Math.round(Y0 * H),
  r1 = Math.round(Y1 * H);
const yTop = new Array(W).fill(H);
for (let x = 0; x < W; x++) {
  // first row where a mostly-foreground run of 10 rows begins
  for (let y = r0; y <= r1 - 10; y++) {
    let fg = 0;
    for (let k = 0; k < 10; k++) if (!isWall(px(x, y + k))) fg++;
    if (fg >= 8) {
      yTop[x] = y;
      break;
    }
  }
}

// median smooth (window 7) to kill speckle
const sm = new Array(W).fill(H);
for (let x = 0; x < W; x++) {
  const v = [];
  for (let k = -3; k <= 3; k++) {
    const xx = x + k;
    if (xx >= 0 && xx < W && yTop[xx] < H) v.push(yTop[xx]);
  }
  if (v.length) sm[x] = v.sort((a, b) => a - b)[(v.length / 2) | 0];
}

// outside the zone, clamp below the table back edge; inside keep detected
const zx0 = Math.round(ZONE[0] * W),
  zx1 = Math.round(ZONE[1] * W);
const safeY = Math.round(SAFE_Y * H);
for (let x = 0; x < W; x++) {
  if (x < zx0 || x > zx1) {
    if (sm[x] === H || sm[x] < safeY) sm[x] = safeY;
  } else if (sm[x] === H) {
    sm[x] = safeY; // detection hole inside zone -> safe
  }
}

// emit mask polygon (sample every 3px), rasterize, feather
let pts = [];
for (let x = 0; x < W; x += 3) pts.push(`${x},${sm[x]}`);
const poly = `M 0 ${H} L ${pts.join(' L ')} L ${W} ${H} Z`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="${poly}" fill="white"/></svg>`;
const mask = await sharp(Buffer.from(svg)).resize(W, H).blur(1.8).png().toBuffer();

await sharp(SRC)
  .ensureAlpha()
  .composite([{ input: mask, blend: 'dest-in' }])
  .webp({ quality: 88, alphaQuality: 95 })
  .toFile(OUT);

for (let p = 40; p <= 72; p += 1) {
  const x = Math.round((p / 100) * W);
  console.log(`${p}%  yTop=${((sm[x] / H) * 100).toFixed(2)}%`);
}
console.log('wrote', OUT);
