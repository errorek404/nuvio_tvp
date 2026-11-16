// providers/tvpvod.js
// Provider Nuvio dla TVP VOD — wersja finalna
// Endpoint playlisty potwierdzony w player.py: /api/products/{id}/videos/playlist?videoType=MOVIE

const TMDB_API_KEY = 'cd5cd2b85b5aca5cdf2208bcbdfb2dbf'; // <-- Wymagane! Wygeneruj na themoviedb.org

// Opcjonalne dane logowania (dla treści premium / profilu).
// Uzyskaj przez lokalny skrypt Python (pairing + odszyfrowanie DPAPI)
// albo DevTools przeglądarki (F12 → Network → żądanie do vod.tvp.pl/api/...).
// NIE umieszczaj tych danych w publicznym repozytorium.
const TVP_AUTH = {
  token: '',
  profile: '',
  device: '',
};

const TVP_BASE = 'https://vod.tvp.pl/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://vod.tvp.pl/';

// ─── Warstwa HTTP z wstrzykiwaniem auth ─────────────────────────────

function buildHeaders(url) {
  const h = {
    'User-Agent': UA,
    'Referer': REFERER,
    'Accept': 'application/json',
  };
  if (/^https:\/\/(?:vod|api)\.tvp\.pl(?::443)?\//.test(url)) {
    if (TVP_AUTH.token) h['API-Authentication'] = TVP_AUTH.token;
    if (TVP_AUTH.profile) h['API-ProfileUid'] = TVP_AUTH.profile;
    if (TVP_AUTH.device) h['API-DeviceUid'] = TVP_AUTH.device;
  }
  return h;
}

function tvpJson(url) {
  return fetch(url, { headers: buildHeaders(url) }).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  });
}

function api(resource, params) {
  const p = Object.assign({ lang: 'pl', platform: 'BROWSER' }, params || {});
  const qs = Object.keys(p)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(p[k]))
    .join('&');
  return tvpJson(`${TVP_BASE}/${resource}?${qs}`);
}

// ─── TMDB ────────────────────────────────────────────────────────────

function tmdbTitle(tmdbId, mediaType) {
  if (!TMDB_API_KEY || TMDB_API_KEY === 'TWOJ_KLUCZ_TMDB') {
    return Promise.reject(new Error('Brak klucza TMDB (ustaw TMDB_API_KEY).'));
  }
  const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=pl-PL`;
  return fetch(url)
    .then(r => r.json())
    .then(d => {
      if (d.success === false) throw new Error(`TMDB: ${d.status_message}`);
      const title = mediaType === 'movie' ? d.title : d.name;
      const original = mediaType === 'movie' ? d.original_title : d.original_name;
      if (!title) throw new Error('TMDB nie zwróciło tytułu.');
      return { title, original: original || title };
    });
}

// ─── Wyszukiwanie z rankingiem ───────────────────────────────────────

function normalizeTitle(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function searchRank(item, keyword) {
  const t = normalizeTitle(item.title);
  const q = normalizeTitle(keyword);
  let rank;
  if (t === q) rank = 0;
  else if (t.indexOf(q + ' ') === 0) rank = 1;
  else if (t.indexOf(q) !== -1) rank = 2;
  else {
    const qWords = q.split(' ').filter(Boolean);
    const tWords = t.split(' ').filter(Boolean);
    rank = qWords.every(w => tWords.indexOf(w) !== -1) ? 3 : 4;
  }
  return [rank, rank === 0 && item.type === 'EPISODE' ? 1 : 0];
}

function searchKind(keyword, kind) {
  return api(`products/vods/search/${kind}`, { keyword })
    .then(data => {
      if (!data || !Array.isArray(data.items)) return [];
      return data.items.filter(it =>
        it && typeof it.id === 'number' && it.title &&
        (!it.webUrl || /^https:\/\/vod\.tvp\.pl/.test(it.webUrl))
      );
    });
}

// ─── Hierarchia serialu ──────────────────────────────────────────────

function getSeasons(serialId) {
  return api(`products/vods/serials/${serialId}/seasons`)
    .then(d => Array.isArray(d) ? d : (d.items || []));
}

function getEpisodes(serialId, seasonId) {
  return api(`products/vods/serials/${serialId}/seasons/${seasonId}/episodes`)
    .then(d => Array.isArray(d) ? d : (d.items || []));
}

function getDetail(productId) {
  return api(`products/vods/${productId}`);
}

// ─── Playlista – poprawny endpoint z videoType ──────────────────────

function getPlaylist(productId) {
  // videoType=MOVIE jest obowiązkowe dla VOD (potwierdzone w player.py)
  const url = `${TVP_BASE}/products/${productId}/videos/playlist`
            + `?lang=pl&platform=BROWSER&videoType=MOVIE`;

  return tvpJson(url).then(payload => normalizePlaylistPayload(payload));
}

function normalizePlaylistPayload(payload) {
  // 1. Kody błędów z API
  if (payload && payload.code) {
    if (payload.code === 'ITEM_NOT_PAID') {
      throw new Error('Materiał wymaga wykupionego dostępu do TVP VOD.');
    }
    throw new Error(`TVP nie udostępniło materiału: ${payload.code}`);
  }

  // 2. DRM
  let drm = null;
  if (payload && payload.drm) {
    const servers = {};
    const ls = payload.licenseServers || {};
    ['com.widevine.alpha', 'com.microsoft.playready'].forEach(key => {
      const v = ls[key];
      if (v) servers[key] = typeof v === 'string' ? v : (v.src || v.url);
    });
    drm = Object.keys(servers).length ? { servers } : { required: true };
  }

  // 3. URL ze źródeł (HLS najpierw, potem DASH)
  const sources = (payload && payload.sources) || {};
  for (const protocol of ['HLS', 'DASH']) {
    const list = sources[protocol] || [];
    for (const item of list) {
      const src = item && item.src;
      if (typeof src === 'string' && /^https:\/\/[^/]+\//.test(src)) {
        return { url: src, drm, protocol };
      }
    }
  }
  throw new Error('TVP nie zwróciło obsługiwanego strumienia.');
}

// ─── Fallback: stary tokenizer (gdyby TVP usunęło endpoint playlisty) ─

function getPlaylistWithFallback(productId) {
  return getPlaylist(productId).catch(err => {
    console.warn(`[TVP VOD] Nowy endpoint zawiódł (${err.message}), próba tokenizera.`);
    return tvpJson(`https://api.tvp.pl/tokenizer/token/${productId}`)
      .then(payload => {
        const formats = (payload && payload.formats) || [];
        const hls = formats.filter(f => /mpegurl|m3u8/i.test(f.mimeType || ''));
        if (!hls.length) throw new Error('Brak HLS w tokenizerze.');
        const best = hls.reduce((a, b) =>
          (b.totalBitrate || 0) > (a.totalBitrate || 0) ? b : a
        );
        return { url: best.url, drm: null, protocol: 'HLS' };
      });
  });
}

// ─── Rozwiązywanie materiału (film lub odcinek) ──────────────────────

function resolveMovie(tmdb) {
  const queries = [tmdb.title];
  if (tmdb.original && tmdb.original !== tmdb.title) queries.push(tmdb.original);

  function tryQuery(qi) {
    if (qi >= queries.length) {
      return Promise.reject(new Error(`Nie znaleziono filmu "${tmdb.title}".`));
    }
    const q = queries[qi];
    return Promise.all(
      ['VOD', 'SERIAL', 'EPISODE'].map(k => searchKind(q, k).catch(() => []))
    ).then(lists => {
      const all = [];
      lists.forEach(list => list.forEach(it => all.push(it)));
      if (!all.length) return tryQuery(qi + 1);
      all.sort((a, b) => {
        const ra = searchRank(a, q);
        const rb = searchRank(b, q);
        if (ra[0] !== rb[0]) return ra[0] - rb[0];
        const typePri = { VOD: 0, SERIAL: 1, EPISODE: 2 };
        return (typePri[a.type] || 3) - (typePri[b.type] || 3);
      });
      return { productId: all[0].id, item: all[0] };
    });
  }
  return tryQuery(0);
}

function resolveEpisode(tmdb, season, episode) {
  return searchKind(tmdb.title, 'SERIAL')
    .then(list => {
      if (!list.length && tmdb.original !== tmdb.title) {
        return searchKind(tmdb.original, 'SERIAL');
      }
      return list;
    })
    .then(list => {
      if (!list.length) throw new Error(`Nie znaleziono serialu "${tmdb.title}".`);
      const serial = list.sort((a, b) => {
        const ra = searchRank(a, tmdb.title);
        const rb = searchRank(b, tmdb.title);
        return ra[0] - rb[0];
      })[0];
      return findEpisodeInSerial(serial.id, season, episode).then(found => ({
        productId: found.id,
        item: found,
      }));
    })
    .catch(err => {
      console.warn(`[TVP VOD] Hierarchia zawiodła: ${err.message}. Fallback: EPISODE search.`);
      return resolveEpisodeBySearch(tmdb, season, episode);
    });
}

function findEpisodeInSerial(serialId, season, episode) {
  return getSeasons(serialId).then(seasons => {
    const s = seasons.find(x => Number(x.number) === Number(season));
    if (!s) throw new Error(`Brak sezonu ${season}.`);
    return getEpisodes(serialId, s.id);
  }).then(eps => {
    const e = eps.find(x => Number(x.number) === Number(episode));
    if (!e) throw new Error(`Brak odcinka ${episode}.`);
    return e;
  });
}

function resolveEpisodeBySearch(tmdb, season, episode) {
  const pad = n => String(n).padStart(2, '0');
  const sq = `S${pad(season)}E${pad(episode)}`;
  const queries = [
    `${tmdb.title} ${sq}`,
    `${tmdb.title} odcinek ${episode}`,
    tmdb.title,
    tmdb.original,
  ];

  function tryQuery(qi) {
    if (qi >= queries.length) {
      return Promise.reject(new Error(`Nie znaleziono odcinka ${season}x${episode}.`));
    }
    return searchKind(queries[qi], 'EPISODE')
      .then(items => verifyCandidates(items.slice(0, 5), season, episode))
      .then(found => {
        if (found) return { productId: found.id, item: found };
        return tryQuery(qi + 1);
      });
  }
  return tryQuery(0);
}

function verifyCandidates(items, season, episode) {
  function checkOne(i) {
    if (i >= items.length) return Promise.resolve(null);
    const item = items[i];
    return getDetail(item.id)
      .then(detail => {
        const dSeason = detail.season || {};
        if (
          Number(dSeason.number) === Number(season) &&
          Number(detail.number) === Number(episode)
        ) {
          return item;
        }
        return checkOne(i + 1);
      })
      .catch(() => checkOne(i + 1));
  }
  return checkOne(0);
}

// ─── Główna funkcja providera ────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[TVP VOD] tmdbId=${tmdbId} mediaType=${mediaType} S=${season} E=${episode} auth=${TVP_AUTH.token ? 'tak' : 'nie'}`);

  return tmdbTitle(tmdbId, mediaType)
    .then(tmdb => mediaType === 'movie' ? resolveMovie(tmdb) : resolveEpisode(tmdb, season, episode))
    .then(found => {
      console.log(`[TVP VOD] Dopasowano: "${found.item.title}" (id=${found.productId}, typ=${found.item.type})`);
      return getPlaylistWithFallback(found.productId).then(p => ({
        url: p.url,
        drm: p.drm,
        protocol: p.protocol,
        item: found.item,
      }));
    })
    .then(({ url, drm, protocol, item }) => {
      const flags = [];
      if (item.payable) flags.push('płatne');
      if (drm) flags.push(drm.required ? 'DRM (brak serwera licencji)' : 'DRM');
      const suffix = flags.length ? ` [${flags.join(', ')}]` : '';
      const stream = {
        name: 'TVP VOD',
        title: `${item.title}${suffix}`,
        url,
        quality: protocol === 'DASH' ? 'DASH' : 'auto',
        headers: buildHeaders(url),
      };
      if (drm && drm.servers) stream.drm = { servers: drm.servers };
      console.log(`[TVP VOD] Strumień: ${url}${suffix}`);
      return [stream];
    })
    .catch(err => {
      console.error(`[TVP VOD] Błąd: ${err.message}`);
      return [];
    });
}

module.exports = { getStreams };
