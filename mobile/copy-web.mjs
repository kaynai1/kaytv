import fs from 'node:fs/promises'
import path from 'node:path'

const source = path.resolve('..', 'web', 'dist')
const target = path.resolve('www')

await fs.rm(target, { recursive: true, force: true })
await fs.cp(source, target, { recursive: true })
console.log('[kaytv] 前端已复制到 mobile/www')
