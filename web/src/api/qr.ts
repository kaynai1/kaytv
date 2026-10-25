import QRCode from 'qrcode'

/** 电视端没有输入法，二维码是把下载地址交给手机的最低成本方式 */
export async function qrDataUrl(text: string): Promise<string> {
  try {
    return await QRCode.toDataURL(text, {
      margin: 1,
      width: 260,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0d12ff', light: '#ffffffff' }
    })
  } catch {
    return ''
  }
}
