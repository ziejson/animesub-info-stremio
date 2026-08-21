const express = require("express");
const cheerio = require("cheerio");
const unzipper = require("unzipper");

const {
  addonBuilder,
  getRouter
} = require("stremio-addon-sdk");

const PORT = Number(process.env.PORT || 7000);

const ANIMESUB_BASE = (
  process.env.ANIMESUB_BASE ||
  "https://animesub.info"
).replace(/\/$/, "");

const PUBLIC_URL = (
  process.env.BASE_URL ||
  "https://animesub-info-stremio.onrender.com"
).replace(/\/$/, "");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 Chrome/151 Safari/537.36";

const manifest = {
  id: "pl.animesub.info.stremio",
  version: "1.2.0",
  name: "AnimeSub.info PL",
  description: "Polskie napisy anime z AnimeSub.info",
  resources: ["subtitles"],
  types: ["series", "movie"],
  catalogs: [],
  idPrefixes: ["tt", "kitsu:", "tmdb:"],
  logo:
    "https://www.google.com/s2/favicons" +
    "?domain=animesub.info&sz=256"
};

const builder = new addonBuilder(manifest);

const searchCache = new Map();
const subtitleCache = new Map();

/* -----------------------------
   HTTP
------------------------------ */

async function request(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "*/*",
      "Accept-Language": "pl,en;q=0.8"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${url}`
    );
  }

  return response;
}

async function getText(url) {
  const response = await request(url);
  return response.text();
}

async function getBuffer(url) {
  const response = await request(url);

  return Buffer.from(
    await response.arrayBuffer()
  );
}

/* -----------------------------
   STREMIO ID
------------------------------ */

function parseEpisode(id) {
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
    baseId: String(id),
    season: null,
    episode: null
  };
}

/* -----------------------------
   CINEMETA
------------------------------ */

async function getMeta(type, id) {
  if (!String(id).startsWith("tt")) {
    return {};
  }

  try {
    const url =
      `https://v3-cinemeta.strem.io/meta/` +
      `${type}/${id}.json`;

    const response = await request(url);
    const json = await response.json();

    return json.meta || {};
  } catch (error) {
    console.log(
      "Cinemeta error:",
      error.message
    );

    return {};
  }
}

/* -----------------------------
   SEARCH QUERIES
------------------------------ */

function makeQueries(
  meta,
  episodeInfo,
  filename
) {
  const title =
    meta.name ||
    meta.originalName ||
    meta.englishName ||
    "";

  const queries = [];

  if (filename) {
    const cleaned =
      filename
        .replace(
          /\.(mkv|mp4|avi|webm)$/i,
          ""
        )
        .replace(/[._]/g, " ")
        .trim();

    queries.push(cleaned);
  }

  if (
    title &&
    episodeInfo.episode !== null
  ) {
    const s = String(
      episodeInfo.season
    ).padStart(2, "0");

    const e = String(
      episodeInfo.episode
    ).padStart(2, "0");

    queries.push(`${title} S${s}E${e}`);

    queries.push(
      `${title} ${episodeInfo.episode}`
    );
  }

  if (title) {
    queries.push(title);
  }

  return [
    ...new Set(
      queries.filter(Boolean)
    )
  ];
}

/* -----------------------------
   HTML
------------------------------ */

function extractLinks(html) {
  const $ = cheerio.load(html);

  const links = [];

  $("a[href]").each(
    (_, element) => {

      const href =
        $(element).attr("href");

      const text =
        $(element)
          .text()
          .replace(/\s+/g, " ")
          .trim();

      if (!href) {
        return;
      }

      try {
        links.push({
          url: new URL(
            href,
            ANIMESUB_BASE
          ).href,

          text
        });
      } catch {}
    }
  );

  return links;
}

/* -----------------------------
   ANIMESUB SEARCH
------------------------------ */

async function searchAnimeSub(query) {
  const cacheKey =
    query.toLowerCase();

  const cached =
    searchCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time <
      10 * 60 * 1000
  ) {
    return cached.data;
  }

  const endpoints = [
    `${ANIMESUB_BASE}/search.php?query=${
      encodeURIComponent(query)
    }`,

    `${ANIMESUB_BASE}/?search=${
      encodeURIComponent(query)
    }`,

    `${ANIMESUB_BASE}/szukaj?query=${
      encodeURIComponent(query)
    }`
  ];

  for (const endpoint of endpoints) {

    try {
      console.log(
        "SEARCH:",
        endpoint
      );

      const html =
        await getText(endpoint);

      const links =
        extractLinks(html);

      const relevant =
        links.filter(item => {

          const value =
            `${item.text} ${item.url}`
              .toLowerCase();

          return (
            value.includes("napis") ||
            value.includes("subtitle") ||
            value.includes("download") ||
            value.includes("pobierz") ||
            /\.(zip|srt|ass|ssa|vtt)(\?|$)/i
              .test(item.url)
          );
        });

      if (relevant.length) {

        searchCache.set(
          cacheKey,
          {
            time: Date.now(),
            data: relevant
          }
        );

        return relevant;
      }

    } catch (error) {

      console.log(
        "Search endpoint error:",
        error.message
      );
    }
  }

  return [];
}

/* -----------------------------
   DOWNLOAD LINKS
------------------------------ */

async function findDownloadLinks(url) {

  if (
    /\.(zip|srt|ass|ssa|vtt)(\?|$)/i
      .test(url)
  ) {
    return [url];
  }

  try {
    const html =
      await getText(url);

    return extractLinks(html)
      .map(item => item.url)
      .filter(url =>
        /\.(zip|srt|ass|ssa|vtt)(\?|$)/i
          .test(url)
      );

  } catch (error) {

    console.log(
      "Page read error:",
      url,
      error.message
    );

    return [];
  }
}

/* -----------------------------
   ASS -> SRT
------------------------------ */

function assTimeToSrt(value) {

  const match =
    String(value)
      .trim()
      .match(
        /(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/
      );

  if (!match) {
    return "00:00:00,000";
  }

  const hour =
    Number(match[1]);

  const minute =
    Number(match[2]);

  const second =
    Number(match[3]);

  let fraction =
    match[4];

  if (fraction.length === 1) {
    fraction += "00";
  }

  if (fraction.length === 2) {
    fraction += "0";
  }

  fraction =
    fraction.slice(0, 3);

  return (
    `${String(hour).padStart(2, "0")}:` +
    `${String(minute).padStart(2, "0")}:` +
    `${String(second).padStart(2, "0")},` +
    fraction
  );
}

function assToSrt(buffer) {

  const input =
    buffer.toString("utf8");

  const output = [];

  let index = 1;

  for (
    const line
    of input.split(/\r?\n/)
  ) {

    if (
      !line.startsWith("Dialogue:")
    ) {
      continue;
    }

    const parts =
      line.split(",", 10);

    if (
      parts.length < 10
    ) {
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
      String(index),
      `${start} --> ${end}`,
      text,
      ""
    );

    index++;
  }

  return Buffer.from(
    output.join("\n"),
    "utf8"
  );
}

/* -----------------------------
   ZIP / SUBTITLE
------------------------------ */

async function prepareSubtitle(url) {

  console.log(
    "DOWNLOAD:",
    url
  );

  const buffer =
    await getBuffer(url);

  const cleanUrl =
    url.split("?")[0]
      .toLowerCase();

  if (
    cleanUrl.endsWith(".srt")
  ) {
    return {
      content: buffer,
      extension: "srt",
      mime:
        "application/x-subrip; charset=utf-8"
    };
  }

  if (
    cleanUrl.endsWith(".vtt")
  ) {
    return {
      content: buffer,
      extension: "vtt",
      mime:
        "text/vtt; charset=utf-8"
    };
  }

  if (
    cleanUrl.endsWith(".ass") ||
    cleanUrl.endsWith(".ssa")
  ) {
    return {
      content:
        assToSrt(buffer),

      extension: "srt",

      mime:
        "application/x-subrip; charset=utf-8"
    };
  }

  if (
    cleanUrl.endsWith(".zip")
  ) {

    const archive =
      await unzipper.Open.buffer(
        buffer
      );

    const files =
      archive.files.filter(file =>
        !file.type.includes(
          "Directory"
        ) &&
        /\.(srt|ass|ssa|vtt)$/i
          .test(file.path)
      );

    if (!files.length) {

      throw new Error(
        "ZIP nie zawiera napisów"
      );
    }

    let selected =
      files.find(file =>
        /\.srt$/i.test(
          file.path
        )
      );

    if (!selected) {
      selected =
        files.find(file =>
          /\.vtt$/i.test(
            file.path
          )
        );
    }

    if (!selected) {
      selected =
        files.find(file =>
          /\.(ass|ssa)$/i.test(
            file.path
          )
        );
    }

    const content =
      await selected.buffer();

    if (
      /\.srt$/i.test(
        selected.path
      )
    ) {
      return {
        content,
        extension: "srt",
        mime:
          "application/x-subrip; charset=utf-8"
      };
    }

    if (
      /\.vtt$/i.test(
        selected.path
      )
    ) {
      return {
        content,
        extension: "vtt",
        mime:
          "text/vtt; charset=utf-8"
      };
    }

    return {
      content:
        assToSrt(content),

      extension: "srt",

      mime:
        "application/x-subrip; charset=utf-8"
    };
  }

  throw new Error(
    "Nieobsługiwany format"
  );
}

/* -----------------------------
   CACHE
------------------------------ */

function storeSubtitle(data) {

  const id =
    `${Date.now()}-` +
    Math.random()
      .toString(36)
      .slice(2);

  subtitleCache.set(
    id,
    {
      ...data,
      created: Date.now()
    }
  );

  return id;
}

/* -----------------------------
   STREMIO SUBTITLES
------------------------------ */

builder.defineSubtitlesHandler(
  async ({
    type,
    id,
    extra
  }) => {

    console.log(
      "STREMIO REQUEST:",
      JSON.stringify({
        type,
        id,
        extra
      })
    );

    try {

      const info =
        parseEpisode(id);

      const meta =
        await getMeta(
          type,
          info.baseId
        );

      console.log(
        "META:",
        meta.name || "unknown"
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

      let results = [];

      for (
        const query
        of queries
      ) {

        results =
          await searchAnimeSub(
            query
          );

        if (
          results.length
        ) {
          break;
        }
      }

      console.log(
        "SEARCH RESULTS:",
        results.length
      );

      const downloadLinks = [];

      for (
        const result
        of results.slice(0, 10)
      ) {

        const links =
          await findDownloadLinks(
            result.url
          );

        for (
          const link
          of links
        ) {

          if (
            !downloadLinks.includes(
              link
            )
          ) {
            downloadLinks.push(
              link
            );
          }
        }
      }

      console.log(
        "DOWNLOAD LINKS:",
        downloadLinks.length
      );

      const subtitles = [];

      for (
        const url
        of downloadLinks.slice(0, 8)
      ) {

        try {

          const prepared =
            await prepareSubtitle(
              url
            );

          const cacheId =
            storeSubtitle(
              prepared
            );

          subtitles.push({
            id: cacheId,

            lang: "pol",

            url:
              `${PUBLIC_URL}` +
              `/subtitle-file/` +
              `${cacheId}.` +
              `${prepared.extension}`
          });

        } catch (error) {

          console.log(
            "Subtitle preparation error:",
            error.message
          );
        }
      }

      console.log(
        "RETURNING:",
        subtitles.length
      );

      return {
        subtitles,
        cacheMaxAge: 300
      };

    } catch (error) {

      console.error(
        "HANDLER ERROR:",
        error
      );

      return {
        subtitles: []
      };
    }
  }
);

/* -----------------------------
   EXPRESS — JEDEN PORT
------------------------------ */

const app =
  express();

/* CORS */

app.use(
  (req, res, next) => {

    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, OPTIONS"
    );

    if (
      req.method === "OPTIONS"
    ) {
      return res
        .status(204)
        .end();
    }

    next();
  }
);

/* Nasze pliki napisów */

app.get(
  "/subtitle-file/:file",
  (req, res) => {

    const match =
      req.params.file.match(
        /^(.+)\.(srt|vtt)$/
      );

    if (!match) {

      return res
        .status(404)
        .send(
          "Invalid subtitle"
        );
    }

    const id =
      match[1];

    const subtitle =
      subtitleCache.get(id);

    if (!subtitle) {

      return res
        .status(404)
        .send(
          "Subtitle expired"
        );
    }

    const age =
      Date.now() -
      subtitle.created;

    if (
      age >
      60 * 60 * 1000
    ) {

      subtitleCache.delete(id);

      return res
        .status(404)
        .send(
          "Subtitle expired"
        );
    }

    res.setHeader(
      "Content-Type",
      subtitle.mime
    );

    res.setHeader(
      "Cache-Control",
      "public, max-age=3600"
    );

    res.send(
      subtitle.content
    );
  }
);

/* Stremio SDK */

app.use(
  "/",
  getRouter(
    builder.getInterface()
  )
);

/* START */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "--------------------------------"
    );

    console.log(
      `AnimeSub.info PL v1.2`
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Manifest: ${PUBLIC_URL}/manifest.json`
    );

    console.log(
      "--------------------------------"
    );
  }
);
