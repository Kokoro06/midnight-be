#!/usr/bin/env node
// 一次性遷移：本機 SQLite -> prod Directus REST API
//
// 用法：
//   DIRECTUS_URL=https://mmoodvie.live \
//   PROD_ADMIN_EMAIL=... PROD_ADMIN_PASSWORD=... \
//   node midnight-be/scripts/migrate-local-to-prod.mjs
//
// 保留所有 uuid PK 不變，以維持 FK 一致性。

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "database", "data.db");

const BASE = process.env.DIRECTUS_URL ?? "https://mmoodvie.live";
const EMAIL = process.env.PROD_ADMIN_EMAIL;
const PASSWORD = process.env.PROD_ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("Missing PROD_ADMIN_EMAIL / PROD_ADMIN_PASSWORD");
  process.exit(1);
}

const BATCH = 100;

function sql(query) {
  const out = execFileSync("sqlite3", ["-json", DB_PATH, query], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : [];
}

let token;

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const json = await res.json();
  if (!json.data?.access_token) throw new Error(`login failed: ${JSON.stringify(json)}`);
  token = json.data.access_token;
  console.log(`logged in as ${EMAIL}`);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    await login();
    return api(method, path, body);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`bad response ${res.status} for ${method} ${path}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${method} ${path}: ${JSON.stringify(json.errors ?? json).slice(0, 500)}`);
  }
  return json;
}

async function batchPost(collection, rows, transform = (r) => r) {
  const total = rows.length;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map(transform);
    await api("POST", `/items/${collection}`, chunk);
    done += chunk.length;
    process.stdout.write(`\r  ${collection}: ${done}/${total}`);
  }
  process.stdout.write("\n");
}

async function existingIds(collection) {
  const json = await api("GET", `/items/${collection}?fields=id&limit=-1`);
  return new Set((json.data ?? []).map((r) => r.id));
}

async function main() {
  console.log(`target: ${BASE}`);
  await login();

  // 1. tags
  console.log("\n[1/4] tags");
  const tags = sql("SELECT id, name, category FROM tags;");
  const existingTagIds = await existingIds("tags");
  const newTags = tags.filter((t) => !existingTagIds.has(t.id));
  console.log(`  local=${tags.length}, prod existing=${existingTagIds.size}, to insert=${newTags.length}`);
  if (newTags.length) await batchPost("tags", newTags);

  // 2. movies
  console.log("\n[2/4] movies");
  const movies = sql(
    "SELECT id, title, original_title, year, poster_url FROM movies;"
  );
  const existingMovieIds = await existingIds("movies");
  const newMovies = movies.filter((m) => !existingMovieIds.has(m.id));
  console.log(`  local=${movies.length}, prod existing=${existingMovieIds.size}, to insert=${newMovies.length}`);
  if (newMovies.length) {
    // poster (uuid → directus_files) 全部本機都是 null，保持不傳；poster_url 是 TMDB CDN 連結
    await batchPost("movies", newMovies, (m) => ({
      id: m.id,
      title: m.title,
      original_title: m.original_title,
      year: m.year,
      poster_url: m.poster_url,
    }));
  }

  // 3. festival_awards（跳過 movie FK 找不到的 orphan rows）
  console.log("\n[3/4] festival_awards");
  const awards = sql(
    `SELECT fa.id, fa.festival, fa.year, fa.edition, fa.award_category, fa.result, fa.movie
     FROM festival_awards fa
     INNER JOIN movies m ON fa.movie = m.id;`
  );
  const allAwardsCount = sql("SELECT COUNT(*) AS c FROM festival_awards;")[0].c;
  const existingAwardIds = await existingIds("festival_awards");
  const newAwards = awards.filter((a) => !existingAwardIds.has(a.id));
  console.log(`  local total=${allAwardsCount}, valid (FK ok)=${awards.length}, prod existing=${existingAwardIds.size}, to insert=${newAwards.length}`);
  if (newAwards.length) await batchPost("festival_awards", newAwards);

  // 4. movies_tags (M2M with weight). INNER JOIN 過濾掉 movies_id/tags_id orphan。
  console.log("\n[4/4] movies_tags");
  const mt = sql(
    `SELECT mt.id, mt.movies_id, mt.tags_id, mt.weight
     FROM movies_tags mt
     INNER JOIN movies m ON mt.movies_id = m.id
     INNER JOIN tags t ON mt.tags_id = t.id;`
  );
  const allMtCount = sql("SELECT COUNT(*) AS c FROM movies_tags;")[0].c;
  const existingMtIds = await existingIds("movies_tags");
  const newMt = mt.filter((r) => !existingMtIds.has(r.id));
  console.log(`  local total=${allMtCount}, valid (FK ok)=${mt.length}, prod existing=${existingMtIds.size}, to insert=${newMt.length}`);
  if (newMt.length) await batchPost("movies_tags", newMt);

  console.log("\ndone.");
  console.log(`verify: curl '${BASE}/items/movies?aggregate[count]=*'`);
}

main().catch((err) => {
  console.error("\nFAIL:", err.message);
  process.exit(1);
});
