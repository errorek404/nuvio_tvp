// providers/tvpvod.js
const TMDB_API_KEY = 'cd5cd2b85b5aca5cdf2208bcbdfb2dbf'; // <-- Wklej swój klucz API v3 z TMDB

const TVP_API_BASE = 'https://tvp.pl';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://tvp.pl';

const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  'Referer': REFERER,
  'Origin': 'https://tvp.pl',
  'Accept': 'application/json',
};

function fetchTitleFromTMDB(tmdbId, mediaType) {
  const url = `https://themoviedb.org{mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=pl-PL`;
  return fetch(url)
    .then(res => res.json())
    .then(data => {
      if (data.success === false) {
        throw new Error(`TMDB error: ${data.status_message}`);
      }
      const title = mediaType === 'movie' ? data.title : data.name;
      if (!title) throw new Error('Brak tytułu w odpowiedzi TMDB');
      return title;
    });
}

function searchTVP(keyword, kind) {
  const url = `${TVP_API_BASE}/vods/search/${kind}?lang=pl&platform=BROWSER&keyword=${encodeURIComponent(keyword)}`;
  return fetch(url, { headers: DEFAULT_HEADERS })
    .then(res => {
      if (!res.ok) throw new Error(`TVP search HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      return Array.isArray(data) ? data : (data.items || data.results || []);
    });
}

function findEpisodeProductId(serialId, seasonNum, episodeNum) {
  const seasonsUrl = `${TVP_API_BASE}/${serialId}/seasons?lang=pl&platform=BROWSER`;
  return fetch(seasonsUrl, { headers: DEFAULT_HEADERS })
    .then(res => res.json())
    .then(seasonsData => {
      const seasons = Array.isArray(seasonsData) ? seasonsData : (seasonsData.items || []);
      if (!seasons.length) throw new Error('Brak sezonów w API TVP');

      const targetSeason = seasons.find(s => Number(s.seasonNumber || s.number) === Number(seasonNum)) || seasons[0];
      const seasonId = targetSeason.id || targetSeason._id;

      const episodesUrl = `${TVP_API_BASE}/${serialId}/seasons/${seasonId}/episodes?lang=pl&platform=BROWSER`;
      return fetch(episodesUrl, { headers: DEFAULT_HEADERS });
    })
    .then(res => res.json())
    .then(episodesData => {
      const episodes = Array.isArray(episodesData) ? episodesData : (episodesData.items || []);
      const targetEpisode = episodes.find(e => Number(e.episodeNumber || e.number) === Number(episodeNum));
      if (!targetEpisode) throw new Error(`Nie znaleziono odcinka S${seasonNum}E${episodeNum}`);
      return targetEpisode.id || targetEpisode._id;
    });
}

function fetchStreamData(productId) {
  const url = `${TVP_API_BASE}/${productId}/videos/playlist?lang=pl&platform=BROWSER`;
  return fetch(url, { headers: DEFAULT_HEADERS })
    .then(res => {
      if (!res.ok) throw new Error(`TVP playlist HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      const hasWidevine = data.drm && data.drm.WIDEVINE && data.drm.WIDEVINE.src;
      const dashSources = data.sources && data.sources.DASH;
      const hlsSources = data.sources && data.sources.HLS;

      // 1. Strumień chroniony DRM (DASH + Widevine)
      if (hasWidevine && Array.isArray(dashSources) && dashSources.length > 0 && dashSources[0].src) {
        return {
          url: dashSources[0].src,
          quality: '1080p (DRM)',
          drm: {
            type: 'widevine',
            licenseUrl: data.drm.WIDEVINE.src,
            headers: {
              'User-Agent': USER_AGENT,
              'Referer': REFERER,
            },
          },
        };
      }

      // 2. Strumień otwarty bez DRM (HLS)
      if (Array.isArray(hlsSources) && hlsSources.length > 0 && hlsSources[0].src) {
        return {
          url: hlsSources[0].src,
          quality: 'Auto (HLS)',
          drm: null,
        };
      }

      // 3. Zapasowo DASH bez DRM, jeśli HLS jest pusty
      if (Array.isArray(dashSources) && dashSources.length > 0 && dashSources[0].src) {
        return {
          url: dashSources[0].src,
          quality: 'Auto (DASH)',
          drm: null,
        };
      }

      throw new Error('Brak dostępnego źródła wideo w odpowiedzi playlisty');
    });
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    console.log(`[TVP VOD] Szukam: TMDB=${tmdbId}, typ=${mediaType}, S=${season}, E=${episode}`);
    const title = await fetchTitleFromTMDB(tmdbId, mediaType);
    console.log(`[TVP VOD] Tytuł z TMDB: ${title}`);

    const kind = mediaType === 'movie' ? 'VOD' : 'SERIAL';
    const items = await searchTVP(title, kind);

    if (!items.length) {
      throw new Error(`Nie znaleziono "${title}" w TVP VOD`);
    }

    // Szukamy dokładnego dopasowania tytułu lub bierzemy pierwszy wynik z tablicy [0]
    const exactMatch = items.find(i => (i.title || '').toLowerCase().trim() === title.toLowerCase().trim()) || items[0];
    let productId = exactMatch.id || exactMatch._id;

    if (mediaType === 'tv' && season && episode) {
      productId = await findEpisodeProductId(productId, season, episode);
    }

    if (!productId) {
      throw new Error('Nie udało się ustalić ID produktu');
    }

    console.log(`[TVP VOD] Pobieram strumień dla ID: ${productId}`);
    const streamData = await fetchStreamData(productId);

    const streamObj = {
      name: 'TVP VOD',
      title: `TVP VOD – ${title} [${streamData.quality}]`,
      url: streamData.url,
      quality: streamData.quality,
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': REFERER,
      },
    };

    if (streamData.drm) {
      streamObj.drm = streamData.drm;
    }

    return [streamObj];
  } catch (err) {
    console.error(`[TVP VOD] Błąd: ${err.message}`);
    return [];
  }
}

module.exports = { getStreams };
