import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.kaynai.kaytv',
  appName: 'KayTV',
  webDir: 'www',
  plugins: {
    CapacitorHttp: {
      enabled: true
    },
    SystemBars: {
      // 安全区由 MainActivity 自己接管，播放器全屏时才能铺进挖孔区
      insetsHandling: 'disable',
      style: 'DARK'
    }
  },
  android: {
    allowMixedContent: true,
    backgroundColor: '#08090c',
    webContentsDebuggingEnabled: false
  },
  server: {
    androidScheme: 'http'
  }
}

export default config
