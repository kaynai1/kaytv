import { onBeforeUnmount, onMounted } from 'vue'

type Direction = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

function rendered(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const style = window.getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none'
}

function isVisible(element: HTMLElement): boolean {
  if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return false
  if (element.tabIndex < 0) return false
  return rendered(element)
}

export function collectNavItems(scope?: ParentNode): HTMLElement[] {
  const root = scope || activeScope()
  return Array.from(root.querySelectorAll<HTMLElement>('[data-nav]')).filter(isVisible)
}

/** 播放器/弹窗打开时只在这一层里走，别把焦点跑到后面的海报墙上 */
function activeScope(): ParentNode {
  const scopes = Array.from(document.querySelectorAll<HTMLElement>('[data-nav-scope]'))
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (rendered(scopes[index])) return scopes[index]
  }
  return document
}

function centerOf(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function moveFocus(direction: Direction) {
  const items = collectNavItems()
  if (!items.length) return
  const active = document.activeElement as HTMLElement | null
  if (!active || !items.includes(active)) {
    items[0].focus({ preventScroll: true })
    // 电视遥控器连续按方向键时，平滑滚动会越滚越慢，直接瞬时对齐
    items[0].scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return
  }
  const from = centerOf(active)
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight'
  const positive = direction === 'ArrowRight' || direction === 'ArrowDown'
  let best: HTMLElement | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const item of items) {
    if (item === active) continue
    const to = centerOf(item)
    const dx = to.x - from.x
    const dy = to.y - from.y
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy)
    const secondary = horizontal ? Math.abs(dy) : Math.abs(dx)
    if (primary < 4) continue
    if (positive ? (horizontal ? dx : dy) <= 0 : (horizontal ? dx : dy) >= 0) continue
    const score = primary + secondary * 2.6
    if (score < bestScore) {
      bestScore = score
      best = item
    }
  }
  if (best) {
    best.focus({ preventScroll: true })
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}

export function focusFirstNav(scope: ParentNode = document) {
  const items = collectNavItems(scope)
  items[0]?.focus({ preventScroll: true })
}

export function useSpatialNav() {
  let lastMove = 0
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    // 长按遥控器方向键会连发几十次，每次都要量全部卡片位置，限到每秒七次
    if (event.repeat && Date.now() - lastMove < 140) return
    const target = event.target as HTMLElement | null
    if (target) {
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
    }
    if (
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown' ||
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight'
    ) {
      event.preventDefault()
      lastMove = Date.now()
      moveFocus(event.key)
    }
  }
  onMounted(() => window.addEventListener('keydown', onKeyDown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
}
