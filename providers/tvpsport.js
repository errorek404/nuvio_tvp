// providers/tvpsport.js
// Provider Nuvio dla TVP Sport — harmonogram transmisji na żywo i nadchodzących.
// Oparty na logice z sport_api.py (Python) dostarczonego przez użytkownika.

const SPORT_BASE = 'https://sport.tvp.pl';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://sport.tvp.pl/';

// ─── Warstwa HTTP ────────────────────────────────────────────────────

function sportFetch(url, options) {
  const opts = options || {};
  opts.headers = Object.assign({
    'User-Agent': UA,
    'Referer': REFERER,
    'Accept': 'text/html,application/json,*/*',
  }, opts.headers || {});
  return fetch(url, opts);
}

function sportJson(url) {
  return sportFetch(url).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
    return res.json();
  });
}

// ─── Pobieranie i parsowanie harmonogramu ────────────────────────────

function fetchSchedule() {
  return sportFetch(`${SPORT_BASE}/transmisje`).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status} dla harmonogramu TVP Sport.`);
    return res.text();
  }).then(html => {
    const marker = 'window.__directoryData';
    const idx = html.indexOf(marker);
    if (idx === -1) throw new Error('Nie znaleziono danych harmonogramu TVP Sport.');

    // Znajdź początek JSON-a po znaku '='
    const eqIdx = html.indexOf('=', idx + marker.length);
    if (eqIdx === -1) throw new Error('Nie znaleziono przypisania danych harmonogramu.');

    // JSON kończy się średnikiem – wyciągamy fragment
    const start = eqIdx + 1;
    const end = html.indexOf(';', start);
    if (end === -1) throw new Error('Nie znaleziono końca danych harmonogramu.');

    const jsonText = html.substring(start, end).trim();
    let payload;
    try {
      payload = JSON.parse(jsonText);
    } catch (e) {
      throw new Error('Nie udało się sparsować JSON-a harmonogramu TVP Sport.');
    }
    return parseSchedule(payload);
  });
}

function parseSchedule(payload) {
  const now = Date.now() / 1000;
  const results = [];

  const groups = payload.items || [];
  for (const group of groups) {
    const discipline = String(group.title || 'Sport').trim();
    const items = group.items || [];
    for (const item of items) {
      const id = item.video_id;
      const startRaw = item.broadcast_start || item.release_date;
      const endRaw = item.broadcast_end;

      if (typeof id !== 'number' || id <= 0) continue;
      if (typeof startRaw !== 'number' || typeof endRaw !== 'number') continue;

      const start = startRaw / 1000;
      const end = endRaw / 1000;
      if (end <= now) continue; // pomijamy zakończone

      const isLive = Boolean(item.is_live) || (start <= now && now < end);

      // Tytuł: preferuj tytuł transmisji, potem tytuł wideo
      const title = String(item.title || (item.video && item.video.title) || 'Transmisja');

      results.push({
        id,
        title,
        discipline,
        start,
        end,
        isLive,
      });
    }
  }

  // Sortowanie: najpierw aktywne, potem według czasu rozpoczęcia
  results.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return a.start - b.start;
  });

  return results;
}

// ─── Pobieranie playlisty (HLS/DASH) i DRM ───────────────────────────

function fetchPlaylist(id) {
  return sportJson(`https://api.tvp.pl/tokenizer/token/${id}`).then(payload => {
    // GEOIP
    if (payload.isGeoBlocked || payload.geoBlocked) {
      throw new Error('TVP Sport nie udostępnia tej transmisji w Twojej lokalizacji (GEOIP).');
    }

    const formats = payload.formats || [];
    const hls = formats.filter(f => /mpegurl|m3u8/i.test(f.mimeType || ''));
    const dash = formats.filter(f => /dash\+xml/i.test(f.mimeType || ''));

    // Preferuj HLS, chyba że jest DRM i tylko DASH jest dostępny
    let choices;
    if (payload.drm) {
      choices = dash.length ? dash : hls;
    } else {
      choices = hls.length ? hls : dash;
    }

    if (!choices.length) {
      throw new Error('Brak dostępnego strumienia. Transmisja mogła się zakończyć lub wymaga zalogowania.');
    }

    // Wybierz najlepszą jakość
    const best = choices.reduce((a, b) => {
      const aBr = a.totalBitrate || 0;
      const bBr = b.totalBitrate || 0;
      return bBr > aBr ? b : a;
    });

    const url = best.url;
    if (!url || !/^https:\/\//.test(url)) {
      throw new Error('Niepoprawny adres manifestu strumienia.');
    }

    // DRM
    let drm = null;
    if (payload.drm) {
      const servers = {};
      const ls = payload.licenseServers || {};
      ['com.widevine.alpha', 'com.microsoft.playready'].forEach(key => {
        const v = ls[key];
        if (v) servers[key] = typeof v === 'string' ? v : (v.src || v.url);
      });
      if (Object.keys(servers).length) {
        drm = { servers };
      } else {
        drm = { required: true };
      }
    }

    const protocol = dash.length && payload.drm ? 'DASH' : 'HLS';
    return { url, drm, protocol, isLive: Boolean(payload.live) };
  });
}

// ─── Główna funkcja providera ────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  // tmdbId jest ignorowane – provider zawsze zwraca harmonogram TVP Sport.
  // Można opcjonalnie użyć tmdbId jako filtru dyscypliny, np. tmdbId = "tenis".
  const filter = (typeof tmdbId === 'string' && tmdbId !== 'tvp-sport') ? tmdbId.toLowerCase() : null;

  console.log(`[TVP Sport] Pobieram harmonogram... (filtr: ${filter || 'brak'})`);

  return fetchSchedule()
    .then(events => {
      if (!events.length) {
        console.log('[TVP Sport] Brak nadchodzących lub trwających transmisji.');
        return [];
      }

      // Filtrowanie po dyscyplinie, jeśli podano
      let filtered = events;
      if (filter) {
        filtered = events.filter(e => e.discipline.toLowerCase().includes(filter));
        if (!filtered.length) {
          console.log(`[TVP Sport] Brak transmisji dla dyscypliny "${filter}".`);
          return [];
        }
      }

      // Ogranicz do np. 15 transmisji, aby nie przeciążać
      const limited = filtered.slice(0, 15);

      // Dla każdej transmisji pobierz playlistę
      const promises = limited.map(event => {
        return fetchPlaylist(event.id)
          .then(play => {
            const flags = [];
            if (event.isLive) flags.push('NA ŻYWO');
            if (play.drm) flags.push(play.drm.required ? 'DRM' : 'DRM');
            const suffix = flags.length ? ` [${flags.join(', ')}]` : '';

            const stream = {
              name: 'TVP Sport',
              title: `${event.discipline}: ${event.title}${suffix}`,
              url: play.url,
              quality: play.protocol === 'DASH' ? 'DASH' : 'auto',
              headers: {
                'User-Agent': UA,
                'Referer': REFERER,
              },
            };
            if (play.drm && play.drm.servers) {
              stream.drm = { servers: play.drm.servers };
            }
            return stream;
          })
          .catch(err => {
            console.warn(`[TVP Sport] Nie udało się pobrać strumienia dla "${event.title}": ${err.message}`);
            return null;
          });
      });

      return Promise.all(promises).then(streams => streams.filter(s => s !== null));
    })
    .catch(err => {
      console.error(`[TVP Sport] Błąd: ${err.message}`);
      return [];
    });
}

module.exports = { getStreams };