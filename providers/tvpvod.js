// ─── Playlista – poprawny endpoint z videoType ──────────────────────

function getPlaylist(productId) {
  // UWAGA: videoType=MOVIE jest obowiązkowe dla VOD!
  const url = `${TVP_BASE}/products/${productId}/videos/playlist`
            + `?lang=pl&platform=BROWSER&videoType=MOVIE`;

  return tvpJson(url).then(payload => {
    // 1. Obsługa błędów z API
    if (payload && payload.code) {
      if (payload.code === 'ITEM_NOT_PAID') {
        throw new Error('Materiał wymaga wykupionego dostępu do TVP VOD.');
      }
      throw new Error(`TVP nie udostępniło materiału: ${payload.code}`);
    }

    // 2. Wykrywanie DRM
    let drm = null;
    if (payload && payload.drm) {
      const servers = {};
      const ls = payload.licenseServers || {};
      ['com.widevine.alpha', 'com.microsoft.playready'].forEach(key => {
        const v = ls[key];
        if (v) servers[key] = typeof v === 'string' ? v : (v.src || v.url);
      });
      if (Object.keys(servers).length) {
        drm = { servers };
      } else {
        // DRM bez serwerów licencji – Nuvio nie odtworzy, ale zgłoś to jasno
        drm = { required: true };
      }
    }

    // 3. Wyciągnięcie URL ze źródeł (najpierw HLS, potem DASH)
    const sources = (payload && payload.sources) || {};
    const protocols = ['HLS', 'DASH'];
    for (const protocol of protocols) {
      const list = sources[protocol] || [];
      for (const item of list) {
        const src = item && item.src;
        if (typeof src === 'string' && /^https:\/\/[^/]+\//.test(src)) {
          return { url: src, drm, protocol };
        }
      }
    }
    throw new Error('TVP nie zwróciło obsługiwanego strumienia.');
  });
}
