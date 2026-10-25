import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const root = path.resolve('resources')
const resDir = path.resolve('android', 'app', 'src', 'main', 'res')
const masterPath = path.join(root, 'icon.png')
const sourcePath = path.join(root, 'icon-source.png')

if (!fs.existsSync(masterPath)) {
  console.error(`[kaytv] 缺少主图标 ${masterPath}`)
  process.exit(1)
}

if (!fs.existsSync(sourcePath)) {
  fs.copyFileSync(masterPath, sourcePath)
  console.log('[kaytv] 已备份原始素材 resources/icon-source.png')
}

const source = path.join(root, 'icon-source.png')

function roundedMask(size, radius) {
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/>` +
      `</svg>`
  )
}

async function roundedIcon(size) {
  const image = await sharp(source).resize(size, size).png().toBuffer()
  return sharp(image)
    .composite([{ input: roundedMask(size, Math.round(size * 0.225)), blend: 'dest-in' }])
    .png()
    .toBuffer()
}

/* 主图标四角是白底，先抠成透明圆角，避免桌面/TV 启动器上出现白方块 */
const master = await roundedIcon(1024)
await sharp(master).png({ compressionLevel: 9, palette: true }).toFile(masterPath)
console.log('[kaytv] 已重绘 resources/icon.png（圆角透明）')

const raw = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true })
const { width: mw, height: mh, channels: ch } = raw.info
const px = (fx, fy) => {
  const i = (Math.round((mh - 1) * fy) * mw + Math.round((mw - 1) * fx)) * ch
  return [raw.data[i], raw.data[i + 1], raw.data[i + 2]]
}
const top = px(0.5, 0.12)
const bottom = px(0.5, 0.88)
const avg = [0, 1, 2].map((i) => Math.round((top[i] + bottom[i]) / 2))
const luma = avg[0] * 0.299 + avg[1] * 0.587 + avg[2] * 0.114
const [r, g, b] = luma > 96 ? [11, 13, 20] : avg
const hex = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')
const base = `#${hex(r)}${hex(g)}${hex(b)}`
const lift = (amount) => `#${hex(r + amount)}${hex(g + amount)}${hex(b + amount)}`

async function compose(target, width, height, markSize, glow) {
  const mark = await roundedIcon(markSize)
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${lift(26)}"/>
      <stop offset="0.55" stop-color="${base}"/>
      <stop offset="1" stop-color="${base}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#f5a524" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#f5a524" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  ${
    glow
      ? `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${Math.round(markSize * 1.2)}" ry="${
          Math.round(markSize * 0.8)
        }" fill="url(#glow)"/>`
      : ''
  }
</svg>`
  await sharp(Buffer.from(svg))
    .composite([{ input: mark, gravity: 'center' }])
    .png({ compressionLevel: 9, palette: true })
    .toFile(target)
  console.log(`[kaytv] 生成 ${path.relative(process.cwd(), target)} ${width}x${height}`)
}

await compose(path.join(root, 'splash.png'), 2732, 2732, 1080, 0)
await compose(path.join(resDir, 'drawable', 'tv_banner.png'), 1280, 720, 430, 26)
