import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.kaynai.kaytv',
  appName: 'KayTV',
  webDir: 'www',
  plugins: {
    CapacitorHttp: {
      enabled: true
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
