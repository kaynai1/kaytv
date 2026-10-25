export const BUILTIN_LIVE = [
  {
    id: 'live-guovin',
    name: 'Guovin 自动测速',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u',
    type: 'm3u',
    enabled: true,
    note: '央卫视频道全，每日自动测速更新'
  },
  {
    id: 'live-vbskycn',
    name: 'vbskycn IPv4',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv4.m3u',
    type: 'm3u',
    enabled: true,
    note: 'IPv4 线路，频道精简'
  },
  {
    id: 'live-iptvorg',
    name: 'iptv-org 中国',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/iptv-org/iptv/master/streams/cn.m3u',
    type: 'm3u',
    enabled: true,
    note: '含 CCTV-4K、深圳/河北/湖南 2160p 超高清频道'
  },
  {
    id: 'live-bingo-tvs',
    name: 'BINGO TVS',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/leexuben/BINGO-TV/main/tv/TVS.txt',
    type: 'txt',
    enabled: true,
    note: 'BINGO-TV 港台/央卫/影视，约 850 频道'
  },
  {
    id: 'live-bingo-zbtv',
    name: 'BINGO 地方台',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/leexuben/BINGO-TV/main/tv/ZBTV.txt',
    type: 'txt',
    enabled: true,
    note: '地方台与咪咕线路，约 1000 频道'
  },
  {
    id: 'live-bingo',
    name: 'BINGO 直播',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/leexuben/BINGO-TV/main/js/live.txt',
    type: 'txt',
    enabled: true,
    note: '央视/卫视/地方/影视综合'
  },
  {
    id: 'live-huya-yqk',
    name: '饭太硬 · 虎牙直播',
    url: 'https://sub.ottiptv.cc/huyayqk.m3u',
    type: 'm3u',
    enabled: true,
    note: '饭太硬影视仓同款虎牙直播源，约 1000 频道'
  },
  {
    id: 'live-douyu-yqk',
    name: '饭太硬 · 斗鱼直播',
    url: 'https://sub.ottiptv.cc/douyuyqk.m3u',
    type: 'm3u',
    enabled: true,
    note: '饭太硬影视仓同款斗鱼直播源，约 900 频道'
  },
  {
    id: 'live-yy-yqk',
    name: '饭太硬 · YY 直播',
    url: 'https://sub.ottiptv.cc/yylunbo.m3u',
    type: 'm3u',
    enabled: true,
    note: '饭太硬影视仓同款 YY 轮播源，约 500 频道'
  },
  {
    id: 'live-bili-yqk',
    name: '饭太硬 · B站直播',
    url: 'https://sub.ottiptv.cc/bililive.m3u',
    type: 'm3u',
    enabled: true,
    note: 'B站一起看直播源，约 300 频道'
  },
  {
    id: 'live-migu',
    name: '咪咕直播',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/develop202/migu_video/refs/heads/main/interface.txt',
    type: 'txt',
    enabled: true,
    note: '咪咕体育/影视频道，约 1000 频道'
  },
  {
    id: 'live-nanfeng',
    name: '南风直播源',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/yoursmile66/TVBox/main/live.txt',
    type: 'txt',
    enabled: true,
    note: 'TVBox 南风接口同款直播，约 1100 频道'
  },
  {
    id: 'live-qixia',
    name: '七夏直播',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/xzwei528/qixia/main/live.txt',
    type: 'txt',
    enabled: true,
    note: 'TVBox 七夏接口同款直播，约 4600 频道'
  },
  {
    id: 'live-fenxiangzhe',
    name: '分享者直播',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/maoystv/6/main/TV/live20220813.txt',
    type: 'txt',
    enabled: true,
    note: 'TVBox 分享者接口同款直播，约 4600 频道'
  },
  {
    id: 'live-cainisi',
    name: '菜妮丝直播',
    url: 'https://play.iptv365.org/%E8%8F%9C%E5%A6%AE%E4%B8%9D/lives/LIVE.txt',
    type: 'txt',
    enabled: true,
    note: 'TVBox 菜妮丝接口同款直播，约 3800 频道'
  },
  {
    id: 'live-xiaoma',
    name: '小马直播',
    url: 'https://szyyds.cn/tv/live/x.txt',
    type: 'txt',
    enabled: true,
    note: 'TVBox 小马接口同款直播，约 6500 频道'
  },
  {
    id: 'live-xiaohezi',
    name: '小盒子直播',
    url: 'http://xhztv.top/xhz/live.txt',
    type: 'txt',
    enabled: true,
    note: 'TVBox 小盒子接口同款直播，约 2400 频道'
  },
  {
    id: 'live-feimao',
    name: '肥猫直播',
    url: 'https://tv.tmxk.kdns.fr/yplrnuc7',
    type: 'auto',
    enabled: true,
    note: 'TVBox 肥猫接口同款直播，约 7000 频道'
  },
  {
    id: 'live-shenxian',
    name: '神仙直播',
    url: 'http://xhztv.top/dc/%E7%A5%9E%E4%BB%99/lib/tv.txt',
    type: 'txt',
    enabled: true,
    note: 'TVBox 神仙接口同款直播，约 700 频道'
  },
  {
    id: 'live-liubei',
    name: '刘备直播',
    url: 'https://raw.liucn.cc/box/libs/tv/tvlive.txt',
    type: 'txt',
    enabled: true,
    note: 'TVBox 刘备接口同款直播，约 500 频道'
  },
  {
    id: 'live-vma',
    name: 'VMA 电影直播',
    url: 'https://pan.vma.cc/down.php/f83b92a24d61858666f13c5db938a292.txt',
    type: 'txt',
    enabled: false,
    note: '片库型直播，频道多、更新快，按需启用'
  },
  {
    id: 'live-fanmingming',
    name: '范明明 IPv6',
    url: 'https://gh-proxy.com/https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/ipv6.m3u',
    type: 'm3u',
    enabled: false,
    note: '仅 IPv6 网络可用，需路由器开启 IPv6'
  }
]

export const BUILTIN_VOD = [
  {
    id: 'vod-kanju',
    name: '看剧AI',
    api: 'https://kanju78.com',
    type: 'kanju',
    enabled: true,
    note: '官方 1080P/4K 直连 · 电影/剧集/短剧/综艺/动漫/纪录片'
  },
  {
    id: 'vod-iqiyi',
    name: '爱奇艺资源',
    api: 'https://iqiyizyapi.com/api.php/provide/vod',
    enabled: true,
    note: '动漫/剧集/综艺齐全，含短剧'
  },
  {
    id: 'vod-maotai',
    name: '茅台资源',
    api: 'https://caiji.maotaizy.cc/api.php/provide/vod',
    enabled: true,
    note: '分类最全，短剧/综艺丰富'
  },
  {
    id: 'vod-dytt',
    name: '电影天堂',
    api: 'http://caiji.dyttzyapi.com/api.php/provide/vod',
    enabled: true,
    note: '电影/剧集更新快'
  },
  {
    id: 'vod-360',
    name: '360资源',
    api: 'https://360zyzz.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧/综艺'
  },
  {
    id: 'vod-jszy',
    name: '极速资源',
    api: 'https://jszyapi.com/api.php/provide/vod',
    enabled: true,
    note: '欧美/日韩剧分区清晰'
  },
  {
    id: 'vod-modu',
    name: '魔都资源',
    api: 'https://www.mdzyapi.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧'
  },
  {
    id: 'vod-ffzy',
    name: '非凡资源',
    api: 'https://api.ffzyapi.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，线路稳定'
  },
  {
    id: 'vod-bfzy',
    name: '暴风资源',
    api: 'https://bfzyapi.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧大全'
  },
  {
    id: 'vod-zuida',
    name: '最大资源',
    api: 'https://api.zuidapi.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含爽文短剧'
  },
  {
    id: 'vod-wujin',
    name: '无尽资源',
    api: 'https://api.wujinapi.me/api.php/provide/vod',
    enabled: true,
    note: '分类细致，短剧/综艺齐全'
  },
  {
    id: 'vod-xinlang',
    name: '新浪资源',
    api: 'https://api.xinlangapi.com/xinlangapi.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧'
  },
  {
    id: 'vod-subo',
    name: '速播资源',
    api: 'https://subocaiji.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧'
  },
  {
    id: 'vod-jinying',
    name: '金鹰点播',
    api: 'https://jyzyapi.com/provide/vod/from/jinyingyun/at/json',
    enabled: true,
    note: '欧美/日韩剧专线'
  },
  {
    id: 'vod-piaoling',
    name: '飘零资源',
    api: 'https://p2100.net/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧'
  },
  {
    id: 'vod-uku',
    name: 'U酷影视',
    api: 'https://api.ukuapi88.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧'
  },
  {
    id: 'vod-guangsu',
    name: '光速资源',
    api: 'https://api.guangsuapi.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧'
  },
  {
    id: 'vod-haohua',
    name: '豪华资源',
    api: 'https://hhzyapi.com/api.php/provide/vod',
    enabled: true,
    note: '欧美/日韩剧专线，含短剧'
  },
  {
    id: 'vod-bdzy',
    name: '百度云资源',
    api: 'https://api.apibdzy.com/api.php/provide/vod',
    enabled: true,
    note: '直连采集接口 · 约 4.9 万条资源'
  },
  {
    id: 'vod-huya',
    name: '虎牙资源',
    api: 'https://www.huyaapi.com/api.php/provide/vod',
    enabled: true,
    note: 'BINGO-TV 采集，欧美/日韩剧'
  },
  {
    id: 'vod-sony',
    name: '索尼资源',
    api: 'https://suoniapi.com/api.php/provide/vod',
    enabled: true,
    note: 'BINGO-TV 采集，短剧/综艺丰富'
  },
  {
    id: 'vod-maoyan',
    name: '猫眼资源',
    api: 'https://api.maoyanapi.top/api.php/provide/vod',
    enabled: true,
    note: '电影/剧集/综艺/动漫，分类 50+'
  },
  {
    id: 'vod-ikun',
    name: 'iKun 资源',
    api: 'https://ikunzyapi.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧/综艺；部分网络需代理'
  },
  {
    id: 'vod-liangzi',
    name: '量子资源',
    api: 'https://cj.lzcaiji.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，更新快；部分网络需代理'
  },
  {
    id: 'vod-hongniu',
    name: '红牛资源',
    api: 'https://www.hongniuzy2.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧；部分网络需代理'
  },
  {
    id: 'vod-modu-anime',
    name: '魔都动漫',
    api: 'https://caiji.moduapi.cc/api.php/provide/vod',
    enabled: true,
    note: '动漫/番剧为主，含短剧；部分网络需代理'
  },
  {
    id: 'vod-ruyi',
    name: '如意资源',
    api: 'https://cj.rycjapi.com/api.php/provide/vod',
    enabled: true,
    note: '综合资源，含短剧/综艺；部分网络需代理'
  },
  {
    id: 'vod-aidan',
    name: '艾旦影视',
    api: 'https://lovedan.net/api.php/provide/vod',
    enabled: true,
    note: '综合资源；部分网络需代理'
  },
  {
    id: 'vod-tianya',
    name: '天涯影视（旺旺）',
    api: 'https://tyyszy.com/api.php/provide/vod',
    enabled: true,
    note: '原旺旺资源跳转域名，资源量大'
  },
  {
    id: 'vod-wolong',
    name: '卧龙资源',
    api: 'https://wolongzyw.com/api.php/provide/vod',
    enabled: false,
    note: '上游启用 Cloudflare 人机验证，恢复后可在后台启用'
  },
  {
    id: 'vod-yaya',
    name: '丫丫资源',
    api: 'https://cj.yayazy.net/api.php/provide/vod',
    enabled: true,
    searchable: false,
    note: 'LibreTV 推荐 · 12 万条目，只出现在影视页片库（接口关闭关键词搜索）'
  },
  {
    id: 'vod-niuniu',
    name: '牛牛资源',
    api: 'https://api.niuniuzy.me/api.php/provide/vod',
    enabled: true,
    searchable: false,
    note: 'LibreTV 推荐 · 12 万条目，只出现在影视页片库（接口关闭关键词搜索）'
  },
  {
    id: 'vod-sdzy',
    name: '闪电资源',
    api: 'http://sdzyapi.com/api.php/provide/vod/from/sdm3u8',
    enabled: true,
    searchable: false,
    note: 'LibreTV 推荐 · m3u8 线路，只出现在影视页片库（接口关闭关键词搜索）'
  },
  {
    id: 'vod-yhzy',
    name: '樱花资源',
    api: 'http://m3u8.apiyhzy.com/api.php/provide/vod',
    enabled: true,
    searchable: false,
    note: 'LibreTV 推荐 · 10 万条目老片储备，只出现在影视页片库（搜索接口 403）'
  },
  {
    id: 'vod-360-alt',
    name: '360资源2',
    api: 'https://360zy.com/api.php/provide/vod',
    enabled: true,
    note: 'LibreTV 推荐 · 360 备用域名，支持搜索，含体育/短剧'
  }
]

export const BUILTIN_SUBSCRIPTIONS = [
  {
    id: 'sub-zhuiju',
    name: '追剧资源 · TVBox 精选',
    url: 'https://raw.githubusercontent.com/laoma528/awesome-zhuiju-free/main/resources/resources.json',
    enabled: true,
    note: '每日从精选 TVBox 配置抽取可用苹果CMS源'
  },
  {
    id: 'sub-wzh',
    name: 'wzh TVBox 合集',
    url: 'https://raw.githubusercontent.com/wzh15802/tvbox/main/tv.json',
    enabled: true,
    note: '每日同步 60+ TVBox 配置中的直连采集源'
  },
  {
    id: 'sub-bingo',
    name: 'BINGO-TV 采集',
    url: 'https://raw.githubusercontent.com/leexuben/BINGO-TV/main/json/%E9%87%87%E9%9B%86.json',
    enabled: true,
    note: '每日同步 BINGO 采集接口'
  }
]

const SKIP_GROUP = /更新时间|公告|说明|失效|测试|备用/i
const ATTR_RE = /([\w-]+)="([^"]*)"/g

function parseAttrs(line) {
  const out = {}
  const head = line.lastIndexOf(',') > 0 ? line.slice(0, line.lastIndexOf(',')) : line
  const re = new RegExp(ATTR_RE.source, 'g')
  let match
  while ((match = re.exec(head))) out[match[1].toLowerCase()] = match[2]
  return out
}

function parseM3U(text) {
  const out = []
  let pending = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf(',')
      const display = comma >= 0 ? line.slice(comma + 1).trim() : ''
      const attrs = parseAttrs(line)
      pending = {
        name: display || attrs['tvg-name'] || '',
        logo: attrs['tvg-logo'] || '',
        group: (attrs['group-title'] || '其他').trim() || '其他'
      }
    } else if (line.startsWith('#')) {
      continue
    } else if (pending) {
      if (/^https?:\/\//i.test(line)) out.push({ ...pending, url: line })
      pending = null
    }
  }
  return out
}

function parseTXT(text) {
  const out = []
  let group = '其他'
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.includes('#genre#')) {
      group = line.split(',')[0].trim() || '其他'
      continue
    }
    const comma = line.indexOf(',')
    if (comma <= 0) continue
    const name = line.slice(0, comma).trim()
    const url = line.slice(comma + 1).trim()
    if (name && /^https?:\/\//i.test(url)) out.push({ name, url, group, logo: '' })
  }
  return out
}

export function parsePlaylist(text, type = 'auto') {
  if (!text) return []
  const body = text.replace(/^\uFEFF/, '')
  const isM3U = type === 'm3u' || (type === 'auto' && /^\s*#EXTM3U/.test(body))
  return isM3U ? parseM3U(body) : parseTXT(body)
}

export function sanitizeChannels(list) {
  const map = new Map()
  for (const item of list) {
    if (!item || !item.name || !item.url) continue
    if (!/^https?:\/\//i.test(item.url)) continue
    if (SKIP_GROUP.test(item.group || '')) continue
    const name = item.name.trim()
    const group = (item.group || '其他').trim() || '其他'
    const url = item.url.trim()
    const logo = (item.logo || '').trim()
    const key = `${name}|${group}`
    const existing = map.get(key)
    if (existing) {
      if (existing.urls.length < 5 && !existing.urls.includes(url)) existing.urls.push(url)
      if (!existing.logo && logo) existing.logo = logo
      continue
    }
    map.set(key, { name, url, urls: [url], group, logo })
  }
  return [...map.values()]
}

export function groupChannels(channels) {
  const map = new Map()
  for (const channel of channels) {
    if (!map.has(channel.group)) map.set(channel.group, [])
    map.get(channel.group).push(channel)
  }
  return [...map.entries()].map(([name, list]) => ({ name, count: list.length }))
}

/** 采集接口常忽略 wd 参数直接返回全量列表，用它把不相关条目挡在搜索页外。 */
export function searchRelevance(name, query) {
  const hay = normalizeSearchText(name)
  const needle = normalizeSearchText(query)
  if (!hay || !needle) return 0
  if (hay.includes(needle)) return 3
  const tokens = String(query)
    .split(/[\s/|,，、·]+/)
    .map(normalizeSearchText)
    .filter((token) => token.length >= 2)
  if (!tokens.length) return 0
  const matched = tokens.filter((token) => hay.includes(token)).length
  if (matched === tokens.length) return 2
  return matched ? 1 : 0
}

export const CONTENT_TYPE_NAMES = {
  movie: '电影',
  tv: '电视剧',
  short: '短剧',
  variety: '综艺',
  anime: '动漫',
  documentary: '纪录片',
  sports: '体育'
}

/** 预告 / 资讯 / 伦理等不是影视正片，不参与类型划分。 */
const CONTENT_TYPE_EXCLUDE = /预告|资讯|新闻|公告|头条|解说|写真|课堂|伦理|三级|里番|未分类|福利|科普|科教/

const CONTENT_TYPE_RULES = [
  [
    'short',
    /短剧|爽剧|爽文|微短剧|竖屏|漫剧|现代都市|年代穿越|穿越年代|穿越现代|古装仙侠|言情总裁|重生民国|脑洞悬疑|女频恋爱|现代言情|女恋总裁|闪婚离婚|都市脑洞|成长逆袭|悬疑烧脑/
  ],
  ['variety', /综艺|真人秀|脱口秀|选秀|访谈/],
  ['documentary', /纪录|记录/],
  ['anime', /动漫|动画|番剧|卡通|少儿|儿童/],
  ['sports', /体育|赛事|篮球|足球|网球|斯诺克|台球|NBA|CBA|LPL|赛车|搏击|拳击/],
  ['movie', /电影|片$|影片|影院|家庭/],
  ['tv', /剧|连续剧|电视/]
]

/** 源站分类名五花八门（爽文短剧/剧情片/综艺片/日韩动漫…），统一归一到内容大类。 */
export function contentTypeOf(typeName) {
  const clean = String(typeName || '').replace(/\s+/g, '')
  if (!clean) return ''
  if (CONTENT_TYPE_EXCLUDE.test(clean)) return ''
  for (const [id, pattern] of CONTENT_TYPE_RULES) {
    if (pattern.test(clean)) return id
  }
  return ''
}

export function contentTypeName(type) {
  return CONTENT_TYPE_NAMES[type] || ''
}

/** 成人内容关键词：只挑强信号，避免误伤「家庭伦理」这类主流剧集分类 */
const ADULT_SOFT = /家庭伦理|伦理剧|婚姻伦理|都市伦理|农村伦理|情感伦理/g
const ADULT_PATTERN =
  /情色|色情|成人片|成人情色|成人AV|18禁|限制级|三级|三級|四级|R级|AV|黄片|黄文|黄色|伦理片|禁片|无码|有码|乱伦|强奸|轮奸|性爱|做爱|性事|肉戏|啪啪|露点|裸聊|裸身|约炮|招妓|卖淫|妓女|自慰|阴部|阴蒂|巨乳|丰乳|美乳|乳交|偷拍|私拍|情欲|欲火|高潮|调教|制服诱惑|骚货|嫩模|淫|发情|哺乳妻|黑丝|丝袜.*足|萝莉.*裸|未成年.*情色/

/** 判断一段分类名/片名是否属于成人内容。 */
export function isAdultContent(text) {
  const raw = String(text || '').replace(/\s+/g, '')
  if (!raw) return false
  return ADULT_PATTERN.test(raw.replace(ADULT_SOFT, ''))
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

export function defaultConfig() {
  return {
    version: 4,
    siteName: 'KayTV',
    access: { mode: 'public' },
    autoCheck: true,
    liveSources: BUILTIN_LIVE.map((item) => ({ ...item, headers: {} })),
    vodSources: BUILTIN_VOD.map((item) => ({ ...item, headers: {} })),
    subscriptions: BUILTIN_SUBSCRIPTIONS.map((item) => ({ ...item }))
  }
}
