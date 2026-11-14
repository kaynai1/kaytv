const { app, BrowserWindow, Menu, shell, session, ipcMain, net } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const UPDATE_DIR = () => path.join(app.getPath('temp'), 'kaytv-update')
let updateTask = null
let updateFilePath = ''

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    title: 'KayTV',
    backgroundColor: '#08090c',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  })

  win.loadFile(path.join(__dirname, 'web', 'index.html'))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen())
      event.preventDefault()
    }
  })
}

// GitHub 直连在国内经常超时，失败后自动换公共加速线路
const UPDATE_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/']
let downloadSeq = 0

function isAllowedUpdateUrl(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return (
      host === 'github.com' ||
      host.endsWith('.githubusercontent.com') ||
      host === 'gh-proxy.com' ||
      host === 'ghproxy.net'
    )
  } catch {
    return false
  }
}

function updateCandidates(raw) {
  const list = [raw]
  if (/^https:\/\/github\.com\//i.test(raw)) {
    for (const prefix of UPDATE_MIRRORS) list.push(prefix + raw)
  }
  return list.filter(isAllowedUpdateUrl)
}

function safeFileName(raw) {
  const name = String(raw || '').replace(/[^\w.-]/g, '')
  return /\.exe$/i.test(name) ? name : ''
}

function sendProgress(sender, data) {
  if (!sender.isDestroyed()) sender.send('updater:progress', data)
}

function downloadFrom(url, filePath, sender, hint, seq) {
  return new Promise((resolve, reject) => {
    let received = 0
    let total = hint
    let lastBytes = 0
    let lastAt = Date.now()
    let speed = 0
    let settled = false
    let idleTimer = 0

    const out = fs.createWriteStream(filePath)
    const task = net.request({ method: 'GET', url, redirect: 'follow' })
    updateTask = task

    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      updateTask = null
      try {
        task.abort()
      } catch {
        /* ignore */
      }
      out.destroy()
      try {
        fs.rmSync(filePath, { force: true })
      } catch {
        /* ignore */
      }
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    // 连接阶段 6 秒没响应就换下一条线路；传输中 30 秒没有新数据同样放弃
    const armIdle = (ms) => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => fail(new Error('连接超时')), ms)
    }
    armIdle(6000)

    task.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        fail(new Error(`镜像返回 HTTP ${response.statusCode}`))
        return
      }
      if (!total) total = Number(response.headers['content-length']) || 0
      armIdle(30000)
      response.on('data', (chunk) => {
        received += chunk.length
        out.write(chunk)
        armIdle(30000)
        const now = Date.now()
        const span = (now - lastAt) / 1000
        if (span >= 0.4) {
          speed = Math.max(0, (received - lastBytes) / span)
          lastBytes = received
          lastAt = now
          sendProgress(sender, { received, total, speed })
        }
      })
      response.on('end', () => {
        out.end(() => {
          if (settled) return
          settled = true
          clearTimeout(idleTimer)
          updateTask = null
          if (seq !== downloadSeq) {
            try {
              fs.rmSync(filePath, { force: true })
            } catch {
              /* ignore */
            }
            reject(new Error('下载已被新的任务替代'))
            return
          }
          updateFilePath = filePath
          sendProgress(sender, { received, total: total || received, speed: 0 })
          resolve(received)
        })
      })
      response.on('error', fail)
    })
    out.on('error', fail)
    task.on('error', fail)
    task.end()
  })
}

ipcMain.handle('updater:download', (event, payload) => {
  const url = String(payload?.url || '')
  const fileName = safeFileName(payload?.fileName)
  if (!isAllowedUpdateUrl(url)) return Promise.reject(new Error('更新地址不合法'))
  if (!fileName) return Promise.reject(new Error('更新包不是 Windows 安装程序'))
  if (updateTask) {
    try {
      updateTask.abort()
    } catch {
      /* 上一次已经结束 */
    }
    updateTask = null
  }

  fs.mkdirSync(UPDATE_DIR(), { recursive: true })
  const filePath = path.join(UPDATE_DIR(), fileName)
  try {
    fs.rmSync(filePath, { force: true })
  } catch {
    /* 被占用的旧包会在写入时报错 */
  }

  const sender = event.sender
  const hint = Number(payload?.total) || 0
  const candidates = updateCandidates(url)
  const seq = ++downloadSeq

  const attempt = (index) =>
    downloadFrom(candidates[index], filePath, sender, hint, seq).then(
      (size) => ({ filePath, size }),
      (error) => {
        if (seq !== downloadSeq) throw error
        if (index + 1 < candidates.length) {
          sendProgress(sender, { received: 0, total: hint, speed: 0, reset: true })
          return attempt(index + 1)
        }
        const detail = error?.message ? `（${error.message}）` : ''
        throw new Error(`下载失败，GitHub 和加速线路都连不上${detail}，请检查网络后重试`)
      }
    )
  return attempt(0)
})

ipcMain.handle('updater:install', () => {
  const dir = UPDATE_DIR()
  const target = updateFilePath || ''
  const inside = target.startsWith(dir + path.sep)
  if (!inside || !/\.exe$/i.test(target) || !fs.existsSync(target)) {
    throw new Error('安装包还没下载完成')
  }
  // 先退出应用、延迟 2 秒再拉起安装器，否则 NSIS 会弹“KayTV 正在运行”的确认框
  // 这里用 ping 而不是 timeout：timeout 在无控制台句柄时会立即报错，延时失效
  const command = `ping -n 3 127.0.0.1 >nul & start "" "${target}"`
  const child = spawn('cmd.exe', ['/c', command], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  setTimeout(() => app.quit(), 150)
  return true
})

app.setAppUserModelId('com.kaynai.kaytv')
// 打开片子就要有声，不能被 Chromium 的自动播放策略拖成静音
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  // file:// 页面的 origin 是 null，内置源接口需要放开跨域
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!/^https?:/i.test(details.url)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    const headers = { ...(details.responseHeaders || {}) }
    headers['Access-Control-Allow-Origin'] = ['*']
    headers['Access-Control-Allow-Methods'] = ['GET,HEAD,OPTIONS']
    headers['Access-Control-Allow-Headers'] = ['*']
    callback({ responseHeaders: headers })
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
