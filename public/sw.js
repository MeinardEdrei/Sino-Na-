const CACHE = 'sino-na-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'show-turn-notif') {
    event.waitUntil(showTurnNotification(data));
  }
});

async function showTurnNotification(data) {
  const title = data.title || 'Ikaw na! 🥃';
  const options = {
    body: data.body || 'Ininom mo na o skip muna?',
    tag: 'sino-na-turn',
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    actions: [
      { action: 'drink', title: 'Ininom ko na 🥃' },
      { action: 'skip', title: 'Skip muna' },
    ],
    data: { url: '/' },
  };
  return self.registration.showNotification(title, options);
}

async function focusClientAndPost(action) {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  if (clients.length > 0) {
    const client = clients[0];
    await client.focus();
    client.postMessage({ type: 'notif-action', action });
    return;
  }
  const url = new URL('/', self.location.origin);
  url.searchParams.set('action', action);
  const client = await self.clients.openWindow(url.href);
  if (client) {
    client.postMessage({ type: 'notif-action', action });
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action || 'open';
  if (action === 'drink' || action === 'skip') {
    event.waitUntil(focusClientAndPost(action));
  } else {
    event.waitUntil(focusClientAndPost('open'));
  }
});

self.addEventListener('notificationclose', () => {});
