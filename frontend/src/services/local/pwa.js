import { useToast } from 'vue-toastification'

// Registers the service worker emitted by build/pwaPlugin.js. A new build
// waits until the user accepts the reload, so a running generation is never
// cut off by an update.
export function setupPwa() {
  if (!('serviceWorker' in navigator)) return
  const swUrl = `${import.meta.env.BASE_URL}sw.js`

  window.addEventListener('load', async () => {
    let registration
    try {
      registration = await navigator.serviceWorker.register(swUrl)
    } catch (error) {
      console.error('Service worker registration failed:', error)
      return
    }

    let promptShown = false
    const promptReload = (worker) => {
      if (promptShown) return
      promptShown = true
      useToast().info('A new version is available. Click to reload.', {
        timeout: false,
        closeOnClick: true,
        onClick: () => worker.postMessage('skipWaiting'),
      })
    }

    // Only reload when an update replaces a worker this page was already
    // using, not on the first install.
    const hadController = Boolean(navigator.serviceWorker.controller)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) window.location.reload()
    })

    if (registration.waiting && hadController)
      promptReload(registration.waiting)
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing
      worker?.addEventListener('statechange', () => {
        if (
          worker.state === 'installed' &&
          navigator.serviceWorker.controller
        ) {
          promptReload(worker)
        }
      })
    })

    // Long-lived tabs (an installed app) check for updates now and then.
    setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000)
  })
}
