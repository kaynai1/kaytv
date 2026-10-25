type BackHandler = () => boolean

const stack: BackHandler[] = []

/** 弹层组件登记自己的关闭逻辑，越晚登记越优先消费返回键 */
export function pushBack(handler: BackHandler): () => void {
  stack.push(handler)
  return () => {
    const index = stack.indexOf(handler)
    if (index >= 0) stack.splice(index, 1)
  }
}

export function consumeBack(): boolean {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]()) return true
  }
  return false
}
