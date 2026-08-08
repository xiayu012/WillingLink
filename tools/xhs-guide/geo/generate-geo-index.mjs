import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const CITIES_URL = "https://download.geonames.org/export/dump/cities15000.zip";
const US_POSTAL_URL = "https://download.geonames.org/export/zip/US.zip";
const CORE_BAY_COUNTY_CODES = new Set(["001", "013", "075", "081", "085"]);
const CORE_BAY_COUNTY_NAMES = new Set([
  "Alameda",
  "Contra Costa",
  "San Francisco",
  "San Mateo",
  "Santa Clara",
]);
const OUTSIDE_AMBIGUOUS_NAMES = new Set([
  "college",
  "commerce",
  "enterprise",
  "home",
  "industry",
  "mobile",
  "normal",
  "orange",
  "park",
  "reading",
  "university",
  "union",
]);
const START_MARKER = "  // <geo-index-generated>";
const END_MARKER = "  // </geo-index-generated>";
const PUNCTUATION_OR_SYMBOL_PATTERN = /[\p{P}\p{S}]+/gu;
const WHITESPACE_RUN_PATTERN = /\s+/g;
const WHITESPACE_PATTERN = /\s/g;
const DIGITS_ONLY_PATTERN = /^\d+$/u;
const HAN_PATTERN = /[\p{Script=Han}]/u;
const LATIN_PATTERN = /[\p{Script=Latin}]/u;
const ZIP_PATTERN = /^\d{5}$/u;
const SCRIPT_PATH = fileURLToPath(
  new URL("../userscript/xhs-guide.user.js", import.meta.url)
);

const normalizeGeoName = (value) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(PUNCTUATION_OR_SYMBOL_PATTERN, " ")
    .replace(WHITESPACE_RUN_PATTERN, " ")
    .trim();

const isUsefulName = (name) => {
  if (!name || DIGITS_ONLY_PATTERN.test(name)) {
    return false;
  }
  if (HAN_PATTERN.test(name)) {
    return name.length >= 2 && name.length <= 24;
  }
  if (!LATIN_PATTERN.test(name)) {
    return false;
  }
  const compactLength = name.replace(WHITESPACE_PATTERN, "").length;
  return compactLength >= 4 && name.split(" ").length <= 5;
};

const addName = (target, rawName) => {
  const name = normalizeGeoName(rawName);
  if (isUsefulName(name)) {
    target.add(name);
  }
};

const fetchBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败 ${response.status}: ${url}`);
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    lastModified: response.headers.get("last-modified") ?? "",
  };
};

const readUint32 = (bytes, offset) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true
  );

const readUint16 = (bytes, offset) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
    offset,
    true
  );

const unzipTextFile = (bytes, expectedName) => {
  let endOffset = -1;
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32(bytes, offset) === 0x06_05_4b_50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("ZIP 缺少中央目录");
  }

  const entryCount = readUint16(bytes, endOffset + 10);
  let centralOffset = readUint32(bytes, endOffset + 16);
  const decoder = new TextDecoder();

  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(bytes, centralOffset) !== 0x02_01_4b_50) {
      throw new Error("ZIP 中央目录损坏");
    }
    const method = readUint16(bytes, centralOffset + 10);
    const compressedSize = readUint32(bytes, centralOffset + 20);
    const fileNameLength = readUint16(bytes, centralOffset + 28);
    const extraLength = readUint16(bytes, centralOffset + 30);
    const commentLength = readUint16(bytes, centralOffset + 32);
    const localOffset = readUint32(bytes, centralOffset + 42);
    const fileName = decoder.decode(
      bytes.subarray(centralOffset + 46, centralOffset + 46 + fileNameLength)
    );

    if (fileName === expectedName) {
      if (readUint32(bytes, localOffset) !== 0x04_03_4b_50) {
        throw new Error("ZIP 本地文件头损坏");
      }
      const localNameLength = readUint16(bytes, localOffset + 26);
      const localExtraLength = readUint16(bytes, localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(
        dataOffset,
        dataOffset + compressedSize
      );
      if (method === 0) {
        return decoder.decode(compressed);
      }
      if (method === 8) {
        return inflateRawSync(compressed).toString("utf8");
      }
      throw new Error(`不支持的 ZIP 压缩方法: ${method}`);
    }

    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP 中找不到 ${expectedName}`);
};

const commonPrefixLength = (left, right) => {
  const maxLength = Math.min(left.length, right.length);
  let length = 0;
  while (length < maxLength && left[length] === right[length]) {
    length += 1;
  }
  return length;
};

const encodeFrontCoded = (values) => {
  let previous = "";
  const rows = [];
  for (const value of [...values].sort()) {
    const prefixLength = commonPrefixLength(previous, value);
    rows.push(`${prefixLength.toString(36)}:${value.slice(prefixLength)}`);
    previous = value;
  }
  return rows.join("\n");
};

const formatStringChunks = (value, indentation = "      ") => {
  const lines = value.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 8000 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks
    .map((chunk, index) => {
      const suffix = index === chunks.length - 1 ? "" : " +";
      return `${indentation}${JSON.stringify(chunk)}${suffix}`;
    })
    .join("\n");
};

const buildGeneratedBlock = ({
  bayNames,
  outsideNames,
  bayZips,
  usZips,
  sourceUpdatedAt,
}) => {
  return `${START_MARKER}
  // GeoNames cities15000 + US postal codes，CC BY 4.0；由 geo/generate-geo-index.mjs 生成。
  const GENERATED_GEO_INDEX_META = Object.freeze({
    sourceUpdatedAt: ${JSON.stringify(sourceUpdatedAt)},
    boundary: "core-five-counties",
    bayNameCount: ${bayNames.size},
    outsideNameCount: ${outsideNames.size},
    bayZipCount: ${bayZips.size},
    usZipCount: ${usZips.size},
  });
  const GENERATED_BAY_NAMES_ENCODED =
${formatStringChunks(encodeFrontCoded(bayNames))};
  const GENERATED_OUTSIDE_NAMES_ENCODED =
${formatStringChunks(encodeFrontCoded(outsideNames))};
  const GENERATED_BAY_ZIPS = ${JSON.stringify([...bayZips].sort().join(","))};
  const GENERATED_US_ZIPS = ${JSON.stringify([...usZips].sort().join(","))};
${END_MARKER}`;
};

const main = async () => {
  const [citiesArchive, postalArchive] = await Promise.all([
    fetchBytes(CITIES_URL),
    fetchBytes(US_POSTAL_URL),
  ]);
  const citiesText = unzipTextFile(citiesArchive.bytes, "cities15000.txt");
  const postalText = unzipTextFile(postalArchive.bytes, "US.txt");

  const bayNames = new Set();
  const outsideNames = new Set();
  for (const line of citiesText.split("\n")) {
    if (!line) {
      continue;
    }
    const fields = line.split("\t");
    const countryCode = fields[8] ?? "";
    const admin1Code = fields[10] ?? "";
    const admin2Code = fields[11] ?? "";
    const isCoreBay =
      countryCode === "US" &&
      admin1Code === "CA" &&
      CORE_BAY_COUNTY_CODES.has(admin2Code);
    const primaryNames = [fields[1] ?? "", fields[2] ?? ""];
    if (isCoreBay) {
      for (const name of [...primaryNames, ...(fields[3] ?? "").split(",")]) {
        addName(bayNames, name);
      }
      continue;
    }
    for (const name of primaryNames) {
      addName(outsideNames, name);
    }
    for (const alias of (fields[3] ?? "").split(",")) {
      if (HAN_PATTERN.test(alias)) {
        addName(outsideNames, alias);
      }
    }
  }

  const bayZips = new Set();
  const usZips = new Set();
  for (const line of postalText.split("\n")) {
    if (!line) {
      continue;
    }
    const fields = line.split("\t");
    const zip = fields[1] ?? "";
    if (ZIP_PATTERN.test(zip)) {
      usZips.add(zip);
    }
    if (fields[4] === "CA" && CORE_BAY_COUNTY_NAMES.has(fields[5] ?? "")) {
      bayZips.add(zip);
      addName(bayNames, fields[2] ?? "");
    }
  }

  for (const name of bayNames) {
    outsideNames.delete(name);
  }
  for (const name of OUTSIDE_AMBIGUOUS_NAMES) {
    outsideNames.delete(name);
  }

  const source = await readFile(SCRIPT_PATH, "utf8");
  const startIndex = source.indexOf(START_MARKER);
  const endIndex = source.indexOf(END_MARKER);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new Error("userscript 缺少 geo-index-generated 标记");
  }
  const afterEnd = endIndex + END_MARKER.length;
  const block = buildGeneratedBlock({
    bayNames,
    outsideNames,
    bayZips,
    usZips,
    sourceUpdatedAt: [citiesArchive.lastModified, postalArchive.lastModified]
      .filter(Boolean)
      .join(" / "),
  });
  await writeFile(
    SCRIPT_PATH,
    `${source.slice(0, startIndex)}${block}${source.slice(afterEnd)}`,
    "utf8"
  );

  process.stdout.write(
    `${JSON.stringify({
      bayNames: bayNames.size,
      outsideNames: outsideNames.size,
      bayZips: bayZips.size,
      usZips: usZips.size,
    })}\n`
  );
};

await main();
