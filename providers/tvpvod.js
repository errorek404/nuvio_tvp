// providers/tvpvod.js
// Provider Nuvio dla TVP VOD — wersja poprawiona

const TMDB_API_KEY = 'cd5cd2b85b5aca5cdf2208bcbdfb2dbf'; // <-- Wstaw swój klucz TMDB (wymagane!)

const TVP_API_BASE = 'https://vod.tvp.pl/api/products';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://vod.tvp.pl/';

// ---------------------------------------------------------------- TMDB

function fetchTitleFromTMDB(tmdbId, mediaType) {
  if (!TMDB_API_KEY || TMDB_API_KEY === 'TWOJ_KLUCZ_TMDB') {
    return Promise.reject(new Error('Brak klucza TMDB. Ustaw TMDB_API_KEY w providers/tvpvod.js.'));
  }
  const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=pl-PL`;
  return fetch(url)
    .then(res => res.json())
    .then(data => {
      if (data.success === false) {
        throw new Error(`TMDB: ${data.status_message}`);
      }
      const title = mediaType === 'movie' ? data.title : data.name;
      if (!title) throw new Error('TMDB nie zwróciło tytułu.');
      return title;
    });
}

// ---------------------------------------------------------------- TVP: wyszukiwanie

function searchTVP(keyword, kind) {
  const url = `${TVP_API_BASE}/vods/search/${kind}?lang=pl&platform=BROWSER&keyword=${encodeURIComponent(keyword)}`;
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER },
  })
    .then(res => {
      if (!res.ok) throw new Error(`TVP search HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (!data.items || !Array.isArray(data.items)) {
        throw new Error('TVP search: brak pola "items".');
      }
      return data.items;
    });
}

// ---------------------------------------------------------------- TVP: seriale i odcinki

function fetchSeasons(serialId) {
  const url = `${TVP_API_BASE}/vods/serials/${serialId}/seasons?lang=pl&platform=BROWSER`;
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER },
  })
    .then(res => {
      if (!res.ok) throw new Error(`TVP seasons HTTP ${res.status}`);
      return res.json();
    })
    .then(data => data.items || data.seasons || []);
}

function fetchEpisodes(serialId, seasonId) {
  const url = `${TVP_API_BASE}/vods/serials/${serialId}/seasons/${seasonId}/episodes?lang=pl&platform=BROWSER`;
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER },
  })
    .then(res => {
      if (!res.ok) throw new Error(`TVP episodes HTTP ${res.status}`);
      return res.json();
    })
    .then(data => data.items || data.episodes || []);
}

/**
 * Próbuje znaleźć odcinek przez hierarchię serial → sezon → odcinki.
 * Jeśli się nie uda, rzuca błąd (fallback poza tą funkcją).
 */
function findEpisodeHierarchy(serialId, seasonNum, episodeNum) {
  return fetchSeasons(serialId)
    .then(seasons => {
      const season = seasons.find(s => Number(s.number) === Number(seasonNum) || Number(s.season) === Number(seasonNum));
      if (!season) throw new Error(`Nie znaleziono sezonu ${seasonNum}.`);
      return fetchEpisodes(serialId, season.id || season._id);
    })
    .then(episodes => {
      const ep = episodes.find(e => Number(e.number) === Number(episodeNum) || Number(e.episode) === Number(episodeNum));
      if (!ep) throw new Error(`Nie znaleziono odcinka ${episodeNum}.`);
      return ep;
    });
}

// ---------------------------------------------------------------- TVP: playlist HLS + DRM

function fetchHLSPlaylist(productId) {
  const url = `${TVP_API_BASE}/vods/${productId}/videos/playlist?lang=pl&platform=BROWSER`;
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER },
  })
    .then(res => {
      if (!res.ok) throw new Error(`TVP playlist HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      const hlsSources = data.sources && data.sources.HLS;
      if (!hlsSources || !hlsSources.length) {
        throw new Error('Brak źródła HLS w playliście.');
      }
      const src = hlsSources[0].src;
      if (!src) throw new Error('Brak pola "src" w źródle HLS.');

      // Wykrywanie DRM — TVP używa Widevine Modular dla części treści.
      let drm = null;
      if (data.drm && data.drm.licenseUrl) {
        drm = {
          system: data.drm.system || 'widevine',
          licenseUrl: data.drm.licenseUrl,
        };
      } else if (data.sources && data.sources.DRM) {
        // Alternatywna struktura — defensywnie.
        drm = { system: 'widevine', licenseUrl: data.sources.DRM.licenseUrl };
      }

      return { url: src, drm };
    });
}

// ---------------------------------------------------------------- Główna logika

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[TVP VOD] Szukam: TMDB=${tmdbId}, typ=${mediaType}, S=${season}, E=${episode}`);

  return fetchTitleFromTMDB(tmdbId, mediaType)
    .then(title => {
      console.log(`[TVP VOD] Tytuł: ${title}`);

      if (mediaType === 'movie') {
        return searchTVP(title, 'VOD').then(items => {
          if (!items.length) throw new Error(`Nie znaleziono filmu "${title}".`);
          return { productId: items[0].id || items[0]._id };
        });
      }

      // Serial: najpierw szukamy serialu, potem odcinka przez hierarchię.
      return searchTVP(title, 'SERIAL').then(items => {
        if (!items.length) throw new Error(`Nie znaleziono serialu "${title}".`);
        const serial = items[0];
        const serialId = serial.id || serial._id;
        if (!serialId) throw new Error('Serial nie ma pola "id".');

        return findEpisodeHierarchy(serialId, season, episode)
          .then(ep => ({ productId: ep.id || ep._id }))
          .catch(err => {
            console.warn(`[TVP VOD] Hierarchia nie zadziałała (${err.message}), próba wyszukiwania EPISODE.`);
            // Fallback: szukamy bezpośrednio odcinka po frazie „Tytuł SxxExx”.
            const query = `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
            return searchTVP(query, 'EPISODE').then(eps => {
              if (!eps.length) throw new Error(`Nie znaleziono odcinka ${season}x${episode} serialu "${title}".`);
              return { productId: eps[0].id || eps[0]._id };
            });
          });
      });
    })
    .then(({ productId }) => {
      if (!productId) throw new Error('Nie udało się ustalić ID produktu TVP.');
      console.log(`[TVP VOD] Produkt ID: ${productId}`);
      return fetchHLSPlaylist(productId);
    })
    .then(({ url, drm }) => {
      const stream = {
        name: 'TVP VOD',
        title: drm ? 'TVP VOD (DRM)' : 'TVP VOD',
        url: url,
        quality: 'auto',
        headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER },
      };
      if (drm) {
        // Przekazanie informacji o DRM do odtwarzacza Nuvio.
        stream.drm = drm;
      }
      console.log(`[TVP VOD] Strumień: ${url}${drm ? ' [DRM]' : ''}`);
      return [stream];
    })
    .catch(err => {
      console.error(`[TVP VOD] Błąd: ${err.message}`);
      return [];
    });
}

module.exports = { getStreams };
