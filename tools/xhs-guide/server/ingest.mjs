#!/usr/bin/env node
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3847;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const RENT_PRICE_REGEXES = [
  /\$\s*[\d,]+/,
  /[\d,]{3,5}\s*刀/,
  /￥\s*[\d,]+/,
  /[\d,]+\s*元\s*\/\s*月/,
  /[\d,]+\s*\/\s*mo(?:nth)?/i,
];

const LAYOUT_HINT_REGEX =
  /\b(\d+\s*b\s*\d+\s*b|studio|Studio|主卧|次卧|1b1b|2b2b)\b/i;

const logLine = (message) => {
  process.stdout.write(`${message}\n`);
};

const getEnvPort = () => {
  const raw = process.env.XHS_INGEST_PORT;
  if (!raw) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("XHS_INGEST_PORT must be a valid TCP port (1-65535)");
  }
  return parsed;
};

const getExpectedToken = () => {
  const token = process.env.XHS_INGEST_TOKEN;
  if (!token) {
    return null;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getDbPath = () => {
  const override = process.env.XHS_INGEST_SQLITE_PATH;
  if (override?.trim()) {
    return path.resolve(override.trim());
  }
  const dataDir = path.join(__dirname, "..", "data");
  mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "rent_listings.sqlite");
};

const extractRentHints = (text) => {
  if (!text) {
    return { rentPriceText: null, layoutText: null, cityRegionHint: null };
  }

  let rentPriceText = null;
  for (const pattern of RENT_PRICE_REGEXES) {
    const match = text.match(pattern);
    if (match) {
      rentPriceText = match[0].trim();
      break;
    }
  }

  const layoutMatch = text.match(LAYOUT_HINT_REGEX);
  const layoutText = layoutMatch ? layoutMatch[1].trim() : null;

  const bayHints = [
    "湾区",
    "旧金山",
    "硅谷",
    "San Jose",
    "Palo Alto",
    "Fremont",
    "伯克利",
  ];
  let cityRegionHint = null;
  for (const hint of bayHints) {
    if (text.includes(hint)) {
      cityRegionHint = hint;
      break;
    }
  }

  return { rentPriceText, layoutText, cityRegionHint };
};

const initDb = (sqlitePath) => {
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rent_listings (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL,
      page_url TEXT NOT NULL,
      note_id TEXT,
      page_title TEXT,
      body_text TEXT NOT NULL,
      body_sha256 TEXT NOT NULL,
      rent_price_text TEXT,
      layout_text TEXT,
      city_region_hint TEXT,
      source TEXT NOT NULL DEFAULT 'xhs-guide',
      script_version TEXT,
      user_agent TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rent_listings_created_at
    ON rent_listings (created_at DESC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rent_listings_note_id
    ON rent_listings (note_id);
  `);
  return db;
};

const readJsonBody = (req, maxBytes) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("请求体过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", (error) => {
      reject(error);
    });
  });

const sendJson = (res, statusCode, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const isAuthorized = (req, tokenSecret) => {
  if (!tokenSecret) {
    return true;
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return false;
  }
  const token = header.slice("Bearer ".length).trim();
  return token === tokenSecret;
};

const port = getEnvPort();
const expectedToken = getExpectedToken();
const dbPath = getDbPath();
const db = initDb(dbPath);

const insertStmt = db.prepare(`
  INSERT INTO rent_listings (
    id, created_at, page_url, note_id, page_title, body_text, body_sha256,
    rent_price_text, layout_text, city_region_hint, source, script_version, user_agent
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
`);

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    sendJson(res, 200, { ok: true, service: "xhs-guide-ingest", dbPath });
    return;
  }

  if (req.method !== "POST" || req.url !== "/ingest") {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }

  if (!isAuthorized(req, expectedToken)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req, MAX_BODY_BYTES);
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid_body" });
    return;
  }

  if (!payload || typeof payload !== "object") {
    sendJson(res, 400, { ok: false, error: "invalid_json" });
    return;
  }

  const pageUrl =
    typeof payload.pageUrl === "string" ? payload.pageUrl.trim() : "";
  const bodyText = typeof payload.bodyText === "string" ? payload.bodyText : "";
  if (!pageUrl || !bodyText) {
    sendJson(res, 400, { ok: false, error: "missing_fields" });
    return;
  }

  const pageTitle =
    typeof payload.pageTitle === "string" ? payload.pageTitle.trim() : null;
  const noteIdRaw = payload.noteId;
  const noteId =
    typeof noteIdRaw === "string" && noteIdRaw.trim() ? noteIdRaw.trim() : null;
  const source =
    typeof payload.source === "string" && payload.source.trim()
      ? payload.source.trim()
      : "xhs-guide";
  const scriptVersion =
    typeof payload.scriptVersion === "string"
      ? payload.scriptVersion.trim()
      : null;
  const userAgent =
    typeof payload.userAgent === "string" ? payload.userAgent.trim() : null;
  const createdAt =
    typeof payload.capturedAt === "string" && payload.capturedAt.trim()
      ? payload.capturedAt.trim()
      : new Date().toISOString();

  const bodySha256 = crypto.createHash("sha256").update(bodyText).digest("hex");
  const hints = extractRentHints(bodyText);
  const id = crypto.randomUUID();

  try {
    insertStmt.run(
      id,
      createdAt,
      pageUrl,
      noteId,
      pageTitle,
      bodyText,
      bodySha256,
      hints.rentPriceText,
      hints.layoutText,
      hints.cityRegionHint,
      source,
      scriptVersion,
      userAgent
    );
  } catch (error) {
    logLine(
      `[xhs-guide-ingest] insert_failed ${error instanceof Error ? error.message : String(error)}`
    );
    sendJson(res, 500, { ok: false, error: "db_insert_failed" });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    id,
    createdAt,
    bodySha256,
    hints: {
      rentPriceText: hints.rentPriceText,
      layoutText: hints.layoutText,
      cityRegionHint: hints.cityRegionHint,
    },
  });
});

server.listen(port, "127.0.0.1", () => {
  logLine(
    `[xhs-guide-ingest] listening on http://127.0.0.1:${port} (db: ${dbPath})${
      expectedToken ? " [auth: bearer token]" : " [auth: disabled]"
    }`
  );
});
