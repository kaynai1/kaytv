import { spawnSync } from 'node:child_process'
import path from 'node:path'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const build = spawnSync(npm, ['run', 'build', '-w', 'web'], {
  cwd: path.resolve('..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_SINGLE_FILE: '1',
    VITE_OUT_DIR: '../desktop/web'
  },
  shell: true
})

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

console.log('[kaytv] 单文件前端已生成到 desktop/web')
