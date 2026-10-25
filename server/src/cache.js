const store = new Map()

export async function cached(key, ttlMs, producer) {
  const now = Date.now()
  const hit = store.get(key)
  if (hit && hit.expires > now) return hit.value
  const value = await producer()
  store.set(key, { value, expires: Date.now() + ttlMs })
  if (store.size > 400) {
    for (const [entryKey, entry] of store) {
      if (entry.expires <= Date.now()) store.delete(entryKey)
    }
    while (store.size > 400) store.delete(store.keys().next().value)
  }
  return value
}

export function invalidate(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key)
  }
}

export function clearCache() {
  store.clear()
}
