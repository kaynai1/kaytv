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

function isAllowedUpdateUrl(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    return url.hostname === 'github.com' || /\.githubusercontent\.com$/i.test(url.hostname)
  } catch {
    return false
  }
}

function safeFileName(raw) {
  const name = String(raw || '').replace(/[^\w.-]/g, '')
  return /\.exe$/i.test(name) ? name : ''
}

function sendProgress(sender, data) {
  if (!sender.isDestroyed()) sender.send('updater:progress', data)
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
  return new Promise((resolve, reject) => {
    let received = 0
    let total = hint
    let lastBytes = 0
    let lastAt = Date.now()
    let speed = 0
    let settled = false

    const out = fs.createWriteStream(filePath)
    const task = net.request({ method: 'GET', url, redirect: 'follow' })
    updateTask = task

    const fail = (error) => {
      if (settled) return
      settled = true
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

    task.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        fail(new Error(`GitHub 返回 HTTP ${response.statusCode}`))
        return
      }
      if (!total) total = Number(response.headers['content-length']) || 0
      response.on('data', (chunk) => {
        received += chunk.length
        out.write(chunk)
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
          updateTask = null
          updateFilePath = filePath
          sendProgress(sender, { received, total: total || received, speed: 0 })
          resolve({ filePath, size: received })
        })
      })
      response.on('error', fail)
    })
    out.on('error', fail)
    task.on('error', fail)
    task.end()
  })
})

ipcMain.handle('updater:install', () => {
  const dir = UPDATE_DIR()
  const target = updateFilePath || ''
  const inside = target.startsWith(dir + path.sep)
  if (!inside || !/\.exe$/i.test(target) || !fs.existsSync(target)) {
    throw new Error('安装包还没下载完成')
  }
  const child = spawn(target, [], { detached: true, stdio: 'ignore' })
  child.unref()
  setTimeout(() => app.quit(), 500)
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
