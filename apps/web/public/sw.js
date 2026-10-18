// Shows Graphinity's notifications and opens the question when one is
// tapped. Nothing else: no caching, no offline copies of pages.

self.addEventListener('push', event => {
  let message;
  try { message = event.data.json(); } catch { return; }
  if (typeof message !== 'object' || !/^[1-9][0-9]{0,15}$/.test(String(message.questionId))) return;
  event.waitUntil(self.registration.showNotification(String(message.title), {
    body: String(message.body),
    icon: '/icon-192.png',
    // One notification per question and kind: a newer one replaces it.
    tag: `${message.title}:${message.questionId}`,
    data: { path: `/q/${message.questionId}` },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const path = event.notification.data && event.notification.data.path;
  if (typeof path !== 'string' || !/^\/q\/[1-9][0-9]{0,15}$/.test(path)) return;
  const url = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      // A tab this worker doesn't control yet can't be navigated: open a new one.
      if (await open.navigate(url).then(() => true, () => false)) return;
    }
    await self.clients.openWindow(url);
  })());
});
