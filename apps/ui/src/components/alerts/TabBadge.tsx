// Background-tab signal (feedback #7): while alerts need you, the title reads "(2) Colony" and the
// favicon gains a coral dot. Renders nothing.
import { useEffect } from 'react'
import { useStore, needsYou } from '@/store/store'

const BASE_TITLE = 'Colony'

export function TabBadge() {
  const { state } = useStore()
  const n = needsYou(state).length
  useEffect(() => {
    document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
    if (icon) icon.href = `${import.meta.env.BASE_URL}${n ? 'favicon-alert.svg' : 'favicon.svg'}`
  }, [n])
  useEffect(() => () => {
    document.title = BASE_TITLE
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
    if (icon) icon.href = `${import.meta.env.BASE_URL}favicon.svg`
  }, [])
  return null
}
