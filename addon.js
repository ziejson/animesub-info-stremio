const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
const unzipper = require("unzipper");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 7000);
const BASE = (process.env.ANIMESUB_BASE || "https://animesub.info").replace(/\/$/, "");
const PUBLIC_URL = (process.env.BASE_URL || "https://animesub-info-stremio.onrender.com").replace(/\/$/, "");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "Chrome/151 Safari/537.36";

const manifest = {
  id: "pl.animesub.info.stremio",
  version: "1.2.0",
  name: "AnimeSub.info PL",
  description: "Polskie napisy anime z AnimeSub.info",
  resources: ["subtitles"],
  types: ["series", "movie"],
  catalogs: [],
  idPrefixes: ["tt", "kitsu:", "tmdb:"],
  logo: "https://www.google.com/s2/favicons?domain=animesub.info&sz=256"
};

const builder = new addonBuilder(manifest);

const searchCache = new Map();
const subtitleCache = new Map();

function episodeInfo(id) {
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

async function fetchResponse(url) {
  return fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "*/*"
    },
    redirect: "follow"
  });
}

async function fetchText(url) {
  const response = await fetchResponse(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }

  return response.text();
}

async function fetchBuffer(url) {
  const response = await fetchResponse(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function getCinemeta(type, id) {
  if (!String(id).startsWith("tt")) {
    return {};
  }

  try {
    const response = await fetch(
      `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`
    );

    if (!response.ok) {
      return {};
    }

    const json = await response.json();
    return json.meta || {};
  } catch {
    return {};
  }
}

function makeQueries(meta, info, filename) {
  const title =
    meta.name ||
    meta.originalName ||
    meta.englishName ||
    "";

  const result = [];

  if (filename) {
    result.push(
      filename
        .replace(/\.(mkv|mp4|avi|webm)$/i, "")
        .replace(/[._]/g, " ")
    );
  }

  if (title && info.episode !== null) {
    const s = String(info.season).padStart(2, "0");
    const e = String(info.episode).padStart(2, "0");

    result.push(`${title} S${s}E${e}`);
    result.push(`${title} ${info.episode}`);
  }

  if (title) {
    result.push(title);
  }

  return [...new Set(result.filter(Boolean))];
}

function extractLinks(html) {
  const $ = cheerio.load(html);
  const links = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const text = $(element).text().trim();

    if (!href) return;

    try {
      links.push({
        url: new URL(href, BASE).href,
        text
      });
    } catch {}
  });

  return links;
}

async function searchAnimeSub(query) {
  const key = query.toLowerCase();

  const cached = searchCache.get(key);

  if (
    cached &&
    Date.now() - cached.time < 10 * 60 * 1000
  ) {
    return cached.data;
  }

  const endpoints = [
    `${BASE}/search.php?query=${encodeURIComponent(query)}`,
    `${BASE}/?search=${encodeURIComponent(query)}`,
    `${BASE}/szukaj?query=${encodeURIComponent(query)}`
  ];

  for (const endpoint of endpoints) {
    try {
      console.log("SEARCH:", endpoint);

      const html = await fetchText(endpoint);

      const links = extractLinks(html);

      const useful = links.filter(item => {
        const value =
          `${item.text} ${item.url}`.toLowerCase();

        return (
          value.includes("napis") ||
          value.includes("subtitle") ||
          value.includes("pobierz") ||
          value.includes("download") ||
          /\.(zip|srt|ass|ssa|vtt)(\?|$)/i.test(item.url)
        );
      });

      if (useful.length) {
        searchCache.set(key, {
          time: Date.now(),
          data: useful
        });

        return useful;
      }
    } catch (error) {
      console.error(
        "SEARCH ERROR:",
        endpoint,
        error.message
      );
    }
  }

  return [];
}

async function findDownloadLinks(pageUrl) {
  if (
    /\.(zip|srt|ass|ssa|vtt)(\?|$)/i.test(pageUrl)
  ) {
    return [pageUrl];
  }

  try {
    const html = await fetchText(pageUrl);

    return extractLinks(html)
      .map(item => item.url)
      .filter(url =>
        /\.(zip|srt|ass|ssa|vtt)(\?|$)/i.test(url)
      );
  } catch {
    return [];
  }
}

function assTimeToSrt(value) {
  const match =
    String(value).trim().match(
      /(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/
    );

  if (!match) {
    return "00:00:00,000";
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);

  let fraction = match[4];

  if (fraction.length === 1) {
    fraction += "00";
  } else if (fraction.length === 2) {
    fraction += "0";
  }

  fraction = fraction.slice(0, 3);

  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")},` +
    fraction
  );
}

function assToSrt(buffer) {
  const input =
    buffer.toString("utf8");

  const output = [];

  let index = 1;

  for (const line of input.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) {
      continue;
    }

    const parts = line.split(",", 10);

    if (parts.length < 10) {
      continue;
    }

    const start =
      assTimeToSrt(parts[1]);

    const end =
      assTimeToSrt(parts[2]);

    let text =
      parts[9] || "";

    text = text
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\N/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\h/g, " ")
      .trim();

    if (!text) {
      continue;
    }

    output.push(
      String(index++),
      `${start} --> ${end}`,
      text,
      ""
    );
  }

  return Buffer.from(
    output.join("\n"),
    "utf8"
  );
}

async function prepareSubtitle(downloadUrl) {
  console.log("DOWNLOAD:", downloadUrl);

  const buffer =
    await fetchBuffer(downloadUrl);

  const cleanUrl =
    downloadUrl.split("?")[0];

  const lower =
    cleanUrl.toLowerCase();

  if (lower.endsWith(".srt")) {
    return {
      content: buffer,
      extension: "srt",
      mime: "application/x-subrip; charset=utf-8"
    };
  }

  if (lower.endsWith(".vtt")) {
    return {
      content: buffer,
      extension: "vtt",
      mime: "text/vtt; charset=utf-8"
    };
  }

  if (
    lower.endsWith(".ass") ||
    lower.endsWith(".ssa")
  ) {
    return {
      content: assToSrt(buffer),
      extension: "srt",
      mime: "application/x-subrip; charset=utf-8"
    };
  }

  if (lower.endsWith(".zip")) {
    const directory =
      await unzipper.Open.buffer(buffer);

    const files =
      directory.files.filter(file =>
        /\.(srt|ass|ssa|vtt)$/i.test(file.path)
      );

    if (!files.length) {
      throw new Error(
        "ZIP nie zawiera obsługiwanych napisów"
      );
    }

    let file =
      files.find(file =>
        /\.srt$/i.test(file.path)
      );

    if (!file) {
      file =
        files.find(file =>
          /\.vtt$/i.test(file.path)
        );
    }

    if (!file) {
      file =
        files.find(file =>
          /\.(ass|ssa)$/i.test(file.path)
        );
    }

    const content =
      await file.buffer();

    if (/\.srt$/i.test(file.path)) {
      return {
        content,
        extension: "srt",
        mime: "application/x-subrip; charset=utf-8"
      };
    }

    if (/\.vtt$/i.test(file.path)) {
      return {
        content,
        extension: "vtt",
        mime: "text/vtt; charset=utf-8"
      };
    }

    return {
      content: assToSrt(content),
      extension: "srt",
      mime: "application/x-subrip; charset=utf-8"
    };
  }

  throw new Error(
    "Nieobsługiwany format napisów"
  );
}

function storeSubtitle(data) {
  const id =
    Math.random()
      .toString(36)
      .slice(2) +
    Date.now().toString(36);

  subtitleCache.set(id, {
    ...data,
    created: Date.now()
  });

  return id;
}

builder.defineSubtitlesHandler(
  async ({ type, id, extra }) => {

    try {
      console.log(
        "SUBTITLE REQUEST:",
        JSON.stringify({
          type,
          id,
          extra
        })
      );

      const info =
        episodeInfo(id);

      const meta =
        await getCinemeta(
          type,
          info.baseId
        );

      const queries =
        makeQueries(
          meta,
          info,
          extra?.filename
        );

      console.log(
        "QUERIES:",
        queries
      );

      let searchResults = [];

      for (const query of queries) {
        searchResults =
          await searchAnimeSub(query);

        if (searchResults.length) {
          break;
        }
      }

      const downloadLinks = [];

      for (
        const result
        of searchResults.slice(0, 10)
      ) {

        const links =
          await findDownloadLinks(
            result.url
          );

        for (const link of links) {
          if (
            !downloadLinks.includes(link)
          ) {
            downloadLinks.push(link);
          }
        }
      }

      console.log(
        "DOWNLOAD LINKS:",
        downloadLinks
      );

      const subtitles = [];

      for (
        const url
        of downloadLinks.slice(0, 8)
      ) {

        try {
          const prepared =
            await prepareSubtitle(url);

          const cacheId =
            storeSubtitle(prepared);

          subtitles.push({
            id: cacheId,
            lang: "pol",
            url:
              `${PUBLIC_URL}/subtitle-file/` +
              `${cacheId}.${prepared.extension}`
          });

        } catch (error) {
          console.error(
            "PREPARE ERROR:",
            url,
            error.message
          );
        }
      }

      console.log(
        "RETURNING:",
        subtitles.length,
        "subtitles"
      );

      return {
        subtitles,
        cacheMaxAge: 300
      };

    } catch (error) {

      console.error(
        "SUBTITLE HANDLER ERROR:",
        error
      );

      return {
        subtitles: []
      };
    }
  }
);

const addonInterface =
  builder.getInterface();

const server =
  http.createServer(
    async (req, res) => {

      if (
        req.url &&
        req.url.startsWith(
          "/subtitle-file/"
        )
      ) {

        const match =
          req.url.match(
            /\/subtitle-file\/([^.]+)\.(srt|vtt)/
          );

        if (!match) {
          res.writeHead(404);
          return res.end();
        }

        const id =
          match[1];

        const item =
          subtitleCache.get(id);

        if (!item) {
          res.writeHead(404);
          return res.end(
            "Subtitle expired"
          );
        }

        res.writeHead(
          200,
          {
            "Content-Type":
              item.mime,
            "Access-Control-Allow-Origin":
              "*",
            "Cache-Control":
              "public, max-age=3600"
          }
        );

        return res.end(
          item.content
        );
      }

      res.writeHead(404);
      res.end();
    }
  );

server.listen(
  PORT + 1,
  "0.0.0.0"
);

serveHTTP(
  addonInterface,
  {
    port: PORT
  }
);

console.log(
  `AnimeSub.info PL 1.2 running on port ${PORT}`
);
