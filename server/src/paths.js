import path from 'node:path'
import fs from 'node:fs'

export const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), 'data')

fs.mkdirSync(dataDir, { recursive: true })

export const dataFile = (name) => path.join(dataDir, name)
