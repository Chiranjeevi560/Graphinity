// Graphinity's merchant tag (docs/adr/0030-browser-signals-and-pixel.md). Only people who tapped a Graphinity ad
// and allow partner sites arrive with a gr_eid. Without one, or with Global Privacy Control, it does nothing.
// Use: <script src="https://…/ads/tag.js" data-pixel="YOUR-PIXEL-ID" data-api="https://…" defer></script>
// then graphinity('PRODUCT_VIEW', { sku: 'kettle-2l', category: 'home' }).
(() => {
  const script = document.currentScript;
  const pixel = script?.dataset.pixel;
  const api = script?.dataset.api;
  const KEY = 'graphinity:eid';
  const read = () => {
    try {
      const fresh = new URLSearchParams(location.search).get('gr_eid');
      if (fresh) sessionStorage.setItem(KEY, fresh);
      return fresh ?? sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const eid = navigator.globalPrivacyControl ? null : read();
  globalThis.graphinity = (event, details = {}) => {
    if (!eid || !pixel || !api) return;
    const body = JSON.stringify({
      pixel,
      eidToken: eid,
      event,
      eventId: details.id ?? crypto.randomUUID(),
      ...(details.sku ? { productSku: details.sku } : {}),
      ...(details.category ? { category: details.category } : {}),
    });
    // text/plain: a simple request, so a merchant's page needs no permission from our server to send it.
    navigator.sendBeacon(`${api}/ads/pixel`, new Blob([body], { type: 'text/plain' }));
  };
})();
