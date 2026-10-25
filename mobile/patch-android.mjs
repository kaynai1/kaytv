import fs from 'node:fs'
import path from 'node:path'

/*
 * 同一份工程按设备形态出两个包：
 *   phone -> 跟随重力感应，触屏必需
 *   tv    -> 锁定横屏，允许无触屏机顶盒安装，补齐 Leanback 入口与横幅
 * 打包前执行，产物文件名由 CI 负责重命名。
 */

const device = (() => {
  const arg = process.argv.find((item) => item.startsWith('--device='))
  return arg ? arg.slice('--device='.length) : 'phone'
})()

if (device !== 'phone' && device !== 'tv') {
  console.error(`[kaytv] 未知设备形态 ${device}，只支持 phone 或 tv`)
  process.exit(1)
}

const manifestPath = path.resolve('android', 'app', 'src', 'main', 'AndroidManifest.xml')
if (!fs.existsSync(manifestPath)) {
  console.error(`[kaytv] 找不到 AndroidManifest.xml: ${manifestPath}`)
  process.exit(1)
}

const original = fs.readFileSync(manifestPath, 'utf8')
let xml = original

function require_(pattern, label) {
  if (!pattern.test(xml)) {
    console.error(`[kaytv] AndroidManifest.xml 缺少${label}，请先执行 npm run sync`)
    process.exit(1)
  }
}

require_(/<application[\s>]/, ' <application>')
require_(/android:name="\.MainActivity"/, ' MainActivity')

const orientation = device === 'tv' ? 'sensorLandscape' : 'fullSensor'
if (/android:screenOrientation="[^"]*"/.test(xml)) {
  xml = xml.replace(/android:screenOrientation="[^"]*"/g, `android:screenOrientation="${orientation}"`)
} else {
  xml = xml.replace(
    'android:name=".MainActivity"',
    `android:name=".MainActivity"\n            android:screenOrientation="${orientation}"`
  )
}

if (device === 'tv') {
  if (!xml.includes('android.software.leanback')) {
    xml = xml.replace(
      /^([ \t]*)<application\b/m,
      '$1<uses-feature android:name="android.software.leanback" android:required="false" />\n' +
        '$1<uses-feature android:name="android.hardware.gamepad" android:required="false" />\n\n' +
        '$1<application'
    )
  }
  xml = xml.replace(
    /(<uses-feature android:name="android\.hardware\.touchscreen"[^>]*android:required=")true/,
    '$1false'
  )
  if (!xml.includes('android:banner=')) {
    xml = xml.replace(/<application\b([^>]*)>/, '<application$1 android:banner="@drawable/tv_banner">')
  }
  if (!xml.includes('LEANBACK_LAUNCHER')) {
    xml = xml.replace(
      /<category android:name="android\.intent\.category\.LAUNCHER" \/>/,
      '<category android:name="android.intent.category.LAUNCHER" />\n                ' +
        '<category android:name="android.intent.category.LEANBACK_LAUNCHER" />'
    )
  }
} else {
  xml = xml.replace(
    /(<uses-feature android:name="android\.hardware\.touchscreen"[^>]*android:required=")false/,
    '$1true'
  )
  xml = xml.replace(/\s*<uses-feature android:name="android\.software\.leanback"[^>]*\/>/g, '')
  xml = xml.replace(/\s*<uses-feature android:name="android\.hardware\.gamepad"[^>]*\/>/g, '')
  xml = xml.replace(/ android:banner="[^"]*"/g, '')
  xml = xml.replace(
    /\s*<category android:name="android\.intent\.category\.LEANBACK_LAUNCHER" \/>/g,
    ''
  )
}

if (xml.includes('android:banner="@drawable/tv_banner"')) {
  const banner = path.resolve('android', 'app', 'src', 'main', 'res', 'drawable', 'tv_banner.png')
  if (!fs.existsSync(banner)) {
    console.error('[kaytv] 缺少 res/drawable/tv_banner.png，请执行 node make-assets.mjs')
    process.exit(1)
  }
}

fs.writeFileSync(manifestPath, xml)
console.log(`[kaytv] AndroidManifest.xml 已切换为 ${device} 形态（${orientation}）`)
