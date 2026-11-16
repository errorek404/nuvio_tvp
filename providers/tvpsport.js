// providers/tvpsport.js
// Provider Nuvio dla TVP Sport — harmonogram transmisji na żywo i nadchodzących

const SPORT_BASE = 'https://sport.tvp.pl';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://sport.tvp.pl/';

function sportFetch(url, options) {
  const opts = options || {};
  opts.headers = Object.assign({
    'User-Agent': UA,
    'Referer': REFERER,
    'Origin': 'https://sport.tvp.pl',
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

function fetchSchedule() {
  return sportFetch(`${SPORT_BASE}/transmisje`).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status} dla harmonogramu TVP Sport.`);
    return res.text();
  }).then(html => {
    const marker = 'window.__directoryData';
    const idx = html.indexOf(marker);
    if (idx === -1) throw new Error('Nie znaleziono danych harmonogramu TVP Sport.');

    const eqIdx = html.indexOf('=', idx + marker.length);
    const scriptEndIdx = html.indexOf('</script>', eqIdx);
    if (eqIdx === -1 || scriptEndIdx === -1) {
      throw new Error('Nie znaleziono granic obiektu harmonogramu.');
    }

    let jsonText = html.substring(eqIdx + 1, scriptEndIdx).trim();
    if (jsonText.endsWith(';')) {
      jsonText = jsonText.slice(0, -1).trim();
    }

    let payload;
    try {
      payload = JSON.parse(jsonText);
    } catch (e) {
      throw new Error('Błąd parsowania JSON-a harmonogramu TVP Sport.');
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
      if (end <= now) continue;

      const isLive = Boolean(item.is_live) || (start <= now && now < end);
      if (!isLive && (start - now) > 900) continue;

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

  results.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return a.start - b.start;
  });

  return results;
}

function fetchPlaylist(id) {
  return sportJson(`https://api.tvp.pl/tokenizer/token/${id}`).then(payload => {
    if (payload.isGeoBlocked || payload.geoBlocked) {
      throw new Error('GEOIP block');
    }

    const formats = payload.formats || [];
    const hls = formats.filter(f => /mpegurl|m3u8/i.test(f.mimeType || ''));
    const dash = formats.filter(f => /dash\+xml/i.test(f.mimeType || ''));

    let choices = payload.drm ? (dash.length ? dash : hls) : (hls.length ? hls : dash);
    if (!choices.length) {
      throw new Error('Brak aktywnego strumienia');
    }

    const best = choices.reduce((a, b) => ((b.totalBitrate || 0) > (a.totalBitrate || 0) ? b : a));
    const url = best.url;
    if (!url || !/^https:\/\//.test(url)) {
      throw new Error('Niepoprawny URL strumienia');
    }

    let drm = null;
    if (payload.drm && payload.licenseServers) {
      const ls = payload.licenseServers;
      const wv = ls['com.widevine.alpha'];
      const licenseUrl = typeof wv === 'string' ? wv : (wv && (wv.src || wv.url));
      if (licenseUrl) {
        drm = {
          type: 'widevine',
          licenseUrl: licenseUrl,
          headers: {
            'User-Agent': UA,
            'Referer': REFERER,
          },
        };
      }
    }

    const protocol = (dash.length && payload.drm) ? 'DASH' : 'HLS';
    return { url, drm, protocol };
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log('[TVP Sport] Pobieram aktywne transmisje...');

  return fetchSchedule()
    .then(events => {
      if (!events.length) return [];

      const limited = events.slice(0, 10);
      const promises = limited.map(event => {
        return fetchPlaylist(event.id)
          .then(play => {
            const badge = event.isLive ? ' [NA ŻYWO]' : ' [ZARAZ]';
            const stream = {
              name: 'TVP Sport',
              title: `${event.discipline}: ${event.title}${badge}`,
              url: play.url,
              quality: play.protocol === 'DASH' ? '1080p (DASH)' : 'Auto (HLS)',
              headers: {
                'User-Agent': UA,
                'Referer': REFERER,
              },
            };
            if (play.drm) {
              stream.drm = play.drm;
            }
            return stream;
          })
          .catch(() => null);
      });

      return Promise.all(promises).then(streams => streams.filter(Boolean));
    })
    .catch(err => {
      console.error(`[TVP Sport] Błąd: ${err.message}`);
      return [];
    });
}

module.exports = { getStreams };
