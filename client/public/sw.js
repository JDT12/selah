// Selah's service worker exists only to show notifications: Android (and some desktop browsers) can only show them
// through one. It doesn't cache or intercept anything; every request still goes straight to the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Clicking a reminder brings Selah forward (or opens it) on the reminder's page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const section = event.notification.data?.section;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows[0];
    if (client) {
      await client.focus();
      if (section) client.postMessage({ type: 'show-section', section });
      return;
    }
    await self.clients.openWindow(section ? `/#${section}` : '/');
  })());
});
