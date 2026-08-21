const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const cheerio = require("cheerio");

const PORT = Number(process.env.PORT || 7000);
const BASE = (process.env.ANIMESUB_BASE || "https://animesub.info").replace(/\/$/, "");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "Chrome/151 Safari/537.36";

const manifest = {
  id: "pl.animesub.info.stremio",
  version: "1.1.0",
  name: "AnimeSub.info PL",
  description: "Polskie napisy anime z AnimeSub.info",
  resources: ["subtitles"],
  types: ["series", "movie"],
  catalogs: [],
  idPrefixes: ["tt", "kitsu:", "tmdb:"],
  logo: "https://www.google.com/s2/favicons?domain=animesub.info&sz=256"
};

const builder = new addonBuilder(manifest);

const cache = new Map();

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.text();
}

function getEpisodeInfo(id) {
  const parts = String(id).split(":");

  if (
    parts.length >= 3 &&
    /^\d+$/.test(parts.at(-1)) &&
    /^\d+$/.test(parts.at(-2))
  ) {
    return {
      baseId: parts.slice(0, -2).join(":"),
      season: Number(parts.at(-2)),
      episode: Number(parts.at(-1))
    };
  }

  return {
    baseId: id,
    season: null,
    episode: null
  };
}

async function getCinemetaMeta(type, id) {
  if (!id.startsWith("tt")) {
    return {};
  }

  try {
    const url =
      `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`;

    const response = await fetch(url, {
      headers: { "User-Agent": UA }
    });

    if (!response.ok) {
      return {};
    }

    const json = await response.json();
    return json.meta || {};
  } catch {
    return {};
  }
}

function makeQueries(meta, episodeInfo) {
  const title =
    meta.name ||
    meta.originalName ||
    meta.englishName ||
    "";

  const queries = [];

  if (title && episodeInfo.episode !== null) {
    queries.push(
      `${title} S${String(episodeInfo.season).padStart(2, "0")}E${String(
        episodeInfo.episode
      ).padStart(2, "0")}`
    );

    queries.push(
      `${title} ${episodeInfo.season} ${episodeInfo.episode}`
    );

    queries.push(`${title} ${episodeInfo.episode}`);
  }

  if (title) {
    queries.push(title);
  }

  queries.push(episodeInfo.baseId);

  return [...new Set(queries.filter(Boolean))];
}

function extractLinks(html) {
  const $ = cheerio.load(html);
  const links = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const text = $(element).text().trim();

    if (!href) {
      return;
    }

    try {
      const url = new URL(href, BASE).href;

      links.push({
        url,
        text
      });
    } catch {}
  });

  return links;
}

async function searchAnimeSub(query) {
  const cacheKey = `search:${query.toLowerCase()}`;

  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.time < 10 * 60 * 1000) {
    return cached.value;
  }

  const endpoints = [
    `${BASE}/search.php?query=${encodeURIComponent(query)}`,
    `${BASE}/?search=${encodeURIComponent(query)}`,
    `${BASE}/szukaj?query=${encodeURIComponent(query)}`
  ];

  for (const endpoint of endpoints) {
    try {
      const html = await fetchPage(endpoint);

      const links = extractLinks(html);

      const relevant = links.filter((item) => {
        const value = `${item.url} ${item.text}`.toLowerCase();

        return (
          value.includes("napis") ||
          value.includes("subtitle") ||
          value.includes("download") ||
          value.includes("pobierz")
        );
      });

      if (relevant.length) {
        cache.set(cacheKey, {
          time: Date.now(),
          value: relevant
        });

        return relevant;
      }
    } catch (error) {
      console.log(
        `Search failed: ${endpoint}`,
        error.message
      );
    }
  }

  return [];
}

function findSubtitleLinks(links) {
  return links.filter((item) => {
    const value = item.url.toLowerCase();

    return (
      /\.(srt|ass|ssa|vtt)(\?|$)/i.test(value) ||
      /\.(zip)(\?|$)/i.test(value)
    );
  });
}

builder.defineSubtitlesHandler(async ({ type, id }) => {
  try {
    const episodeInfo = getEpisodeInfo(id);

    const meta = await getCinemetaMeta(
      type,
      episodeInfo.baseId
    );

    const queries = makeQueries(
      meta,
      episodeInfo
    );

    let links = [];

    for (const query of queries) {
      links = await searchAnimeSub(query);

      if (links.length) {
        break;
      }
    }

    const subtitleLinks = findSubtitleLinks(links);

    const subtitles = [];

    for (const item of subtitleLinks.slice(0, 20)) {
      const label =
        `AnimeSub.info PL` +
        (
          episodeInfo.episode !== null
            ? ` • S${String(episodeInfo.season).padStart(2, "0")}E${String(
                episodeInfo.episode
              ).padStart(2, "0")}`
            : ""
        );

      subtitles.push({
        id: item.url,
        url: item.url,
        lang: "pol",
        label
      });
    }

    return {
      subtitles
    };
  } catch (error) {
    console.error(
      "AnimeSub subtitle error:",
      error
    );

    return {
      subtitles: []
    };
  }
});

serveHTTP(
  builder.getInterface(),
  {
    port: PORT
  }
);

console.log(
  `AnimeSub.info PL addon running on port ${PORT}`
);
