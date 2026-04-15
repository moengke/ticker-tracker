// fetch-tickers.js
// Fetches RSS feeds for each account in accounts.json,
// stores every raw mention in tickers.json history,
// then ranks symbols by mention count over the last 5 trailing days.

const fs    = require("fs");
const https = require("https");
const { DOMParser } = require("@xmldom/xmldom");

const ACCOUNTS     = JSON.parse(fs.readFileSync("accounts.json", "utf8"));
const RSS_BASE     = "https://rsshub.app/twitter/user/";
const OUT_FILE     = "tickers.json";
const TOP_N        = 10;
const HISTORY_DAYS = 5;

const IGNORE = new Set([
  "A","I","AM","AN","AS","AT","BE","BY","DO","GO","HE","IF","IN","IS","IT",
  "ME","MY","NO","OF","OH","OK","ON","OR","SO","TO","UP","US","WE",
  "AND","ARE","BUT","FOR","HAS","HER","HIM","HIS","HOW","ITS","MAY","NOT",
  "OUR","OUT","OWN","SAY","SHE","THE","TOO","TWO","WAS","WHO","WHY","YET",
  "YOU","CEO","CFO","COO","IPO","ETF","CPI","GDP","PMI","FED","WSJ","NYT",
  "USA","SEC","DOJ","FBI","CIA","IMF","WTO","EST","PST","GMT","USD","EUR",
  "GBP","JPY","BREAKING","RT","DM","PM","AM"
]);

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function extractTickers(text) {
  const upper = text.toUpperCase();
  const re = /\$([A-Z]{1,5})(?=[^A-Z]|$)/g;
  const found = [];
  let m;
  while ((m = re.exec(upper)) !== null) {
    if (!IGNORE.has(m[1])) found.push(m[1]);
  }
  return [...new Set(found)];
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Deduplicate raw mentions: one entry per (symbol, account, tweetId)
// so re-running the same feed doesn't double-count.
function dedupeRaw(existing, incoming) {
  const key = (m) => `${m.symbol}|${m.account}|${m.tweetId}`;
  const seen = new Set(existing.map(key));
  const added = [];
  for (const m of incoming) {
    const k = key(m);
    if (!seen.has(k)) {
      seen.add(k);
      added.push(m);
    }
  }
  return added;
}

// Build ranked summary from raw mentions within the 5-day window.
function buildRanked(rawMentions) {
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const window = rawMentions.filter(m => new Date(m.time).getTime() >= cutoff);

  const agg = new Map();
  for (const m of window) {
    if (!agg.has(m.symbol)) {
      agg.set(m.symbol, {
        symbol: m.symbol,
        mentionCount: 0,
        accounts: new Set(),
        lastTime: m.time,
        recentSnippet: m.snippet,
        recentAccount: m.account,
      });
    }
    const entry = agg.get(m.symbol);
    entry.mentionCount++;
    entry.accounts.add(m.account);
    if (new Date(m.time) > new Date(entry.lastTime)) {
      entry.lastTime      = m.time;
      entry.recentSnippet = m.snippet;
      entry.recentAccount = m.account;
    }
  }

  // Sort: primary = mentionCount desc, secondary = uniqueAccounts desc
  return [...agg.values()]
    .sort((a, b) =>
      b.mentionCount - a.mentionCount ||
      b.accounts.size - a.accounts.size
    )
    .slice(0, TOP_N)
    .map(e => ({
      symbol:         e.symbol,
      mentionCount:   e.mentionCount,
      uniqueAccounts: e.accounts.size,
      accounts:       [...e.accounts],
      lastTime:       e.lastTime,
      recentSnippet:  e.recentSnippet,
      recentAccount:  e.recentAccount,
    }));
}

async function fetchAccount(handle) {
  const xml = await fetchUrl(`${RSS_BASE}${handle}`);
  const doc  = new DOMParser().parseFromString(xml, "text/xml");
  const items = Array.from(doc.getElementsByTagName("item"));

  const raw = [];
  for (const item of items) {
    const title   = item.getElementsByTagName("title")[0]?.textContent   || "";
    const desc    = item.getElementsByTagName("description")[0]?.textContent || "";
    const pubDate = item.getElementsByTagName("pubDate")[0]?.textContent  || "";
    const link    = item.getElementsByTagName("link")[0]?.textContent     || "";
    const text    = stripHtml(title + " " + desc);
    const tickers = extractTickers(text);
    const time    = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString();
    const tweetId = link.split("/").pop() || `${handle}-${time}`;

    for (const symbol of tickers) {
      raw.push({ symbol, account: handle, snippet: text.slice(0, 200), time, tweetId });
    }
  }
  return raw;
}

async function main() {
  console.log(`Fetching ${ACCOUNTS.length} account(s)...`);

  const existing    = fs.existsSync(OUT_FILE)
    ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8"))
    : { raw: [] };
  let existingRaw   = existing.raw || [];

  let newRaw = [];
  for (const handle of ACCOUNTS) {
    try {
      const mentions = await fetchAccount(handle);
      console.log(`  @${handle}: ${mentions.length} raw ticker mentions fetched`);
      newRaw.push(...mentions);
    } catch (err) {
      console.error(`  @${handle}: ERROR - ${err.message}`);
    }
  }

  const added  = dedupeRaw(existingRaw, newRaw);
  const allRaw = [...existingRaw, ...added];
  console.log(`  +${added.length} new unique mentions added`);

  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const pruned = allRaw.filter(m => new Date(m.time).getTime() >= cutoff);
  console.log(`  History: ${pruned.length} mentions within ${HISTORY_DAYS}-day window`);

  const ranked = buildRanked(pruned);
  console.log(`  Top: ${ranked.map(t => `$${t.symbol}(${t.mentionCount})`).join(", ")}`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    updated:    new Date().toISOString(),
    windowDays: HISTORY_DAYS,
    ranked,
    raw:        pruned,
  }, null, 2));

  console.log(`Done. Wrote ${ranked.length} ranked tickers to ${OUT_FILE}`);
}

main().catch(err => { console.error(err); process.exit(1); });
