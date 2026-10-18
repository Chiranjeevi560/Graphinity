// Web push for this device: on, off, and whether it's possible at all.
import { ApiError, type Api } from './api.ts';

export type PushSupport = 'ok' | 'unsupported' | 'install-first';

export function pushSupport(): PushSupport {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // iPhone and iPad offer push only to sites added to the Home Screen.
    const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return apple && !matchMedia('(display-mode: standalone)').matches ? 'install-first' : 'unsupported';
  }
  return 'ok';
}

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/** Exactly what the API accepts (it refuses unknown fields, like expirationTime). */
function forApi(subscription: PushSubscription) {
  const { endpoint, keys } = subscription.toJSON();
  return { endpoint, keys: { p256dh: keys?.p256dh, auth: keys?.auth } };
}

async function existing(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  return registration ? registration.pushManager.getSubscription() : null;
}

/** On only if this browser gets the signed-in person's notifications, not just anyone's. */
export async function isPushOn(api: Api): Promise<boolean> {
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return false;
  const subscription = await existing();
  if (!subscription) return false;
  const res = await api<{ push: { on: boolean } }>('/me/push/status', { method: 'POST', signedIn: true, body: { endpoint: subscription.endpoint } });
  return res.push.on;
}

export async function turnPushOn(api: Api, publicKey: string): Promise<'on' | 'denied'> {
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const subscribe = () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(publicKey) });
  let subscription = await subscribe();
  try {
    try {
      await api('/me/push', { method: 'PUT', signedIn: true, body: forApi(subscription) });
    } catch (err) {
      // This browser was registered to another account: start a fresh
      // subscription so the other person's notifications can't land here.
      if (!(err instanceof ApiError) || err.code !== 'device_in_use') throw err;
      await subscription.unsubscribe();
      subscription = await subscribe();
      await api('/me/push', { method: 'PUT', signedIn: true, body: forApi(subscription) });
    }
  } catch (err) {
    // Not saved: don't leave a browser subscription the server knows nothing
    // about, which would read as "on" and never deliver.
    await subscription.unsubscribe().catch(() => {});
    throw err;
  }
  return 'on';
}

/** Off for this device: on the server, and in the browser. Safe to call when already off. */
export async function turnPushOff(api: Api): Promise<void> {
  if (pushSupport() !== 'ok') return;
  const subscription = await existing();
  if (!subscription) return;
  await api('/me/push', { method: 'DELETE', signedIn: true, body: { endpoint: subscription.endpoint } }).catch(() => { /* the browser side still goes */ });
  await subscription.unsubscribe();
}
