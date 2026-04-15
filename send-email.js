// send-email.js
// Reads tickers.json (frequency-ranked) and sends a daily digest via Resend.
// Requires env vars: RESEND_API_KEY, TO_EMAIL, FROM_EMAIL

const fs    = require("fs");
const https = require("https");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL       = process.env.TO_EMAIL;
const FROM_EMAIL     = process.env.FROM_EMAIL || "ticker-tracker@yourdomain.com";

if (!RESEND_API_KEY || !TO_EMAIL) {
  console.error("Missing RESEND_API_KEY or TO_EMAIL environment variables.");
  process.exit(1);
}

const data       = JSON.parse(fs.readFileSync("tickers.json", "utf8"));
const ranked     = data.ranked || [];
const windowDays = data.windowDays || 5;
const updated    = new Date(data.updated).toLocaleString("en-US", {
  timeZone: "America/Chicago", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit",
});

// Build a simple bar proportional to mentionCount (max = ranked[0])
function mentionBar(count, max) {
  const pct   = max > 0 ? Math.round((count / max) * 100) : 0;
  const width = Math.max(4, Math.round(pct * 0.8)); // max ~80px
  return `<div style="display:inline-block;height:6px;width:${width}px;` +
         `background:#00e5a0;border-radius:3px;vertical-align:middle;margin-right:6px;"></div>` +
         `<span style="font-family:monospace;font-size:11px;color:#4a5568;">${count}x</span>`;
}

function buildHtml(ranked) {
  const maxCount = ranked[0]?.mentionCount || 1;
  const dateRange = `${windowDays}-day window ending ${updated} CT`;

  const rows = ranked.map((t, i) => {
    const accountPills = t.accounts.map(a =>
      `<span style="display:inline-block;background:#181c22;border:1px solid #2a3341;` +
      `border-radius:3px;padding:1px 6px;font-family:monospace;font-size:10px;` +
      `color:#00b87a;margin:1px;">@${a}</span>`
    ).join(" ");

    return `
    <tr style="border-bottom:1px solid #1e2530;">
      <td style="padding:12px 14px;font-family:monospace;color:#4a5568;font-size:12px;
                 vertical-align:top;">#${i + 1}</td>
      <td style="padding:12px 14px;vertical-align:top;white-space:nowrap;">
        <div style="font-family:monospace;font-size:20px;font-weight:600;color:#00e5a0;
                    letter-spacing:-0.02em;">$${t.symbol}</div>
        <div style="margin-top:5px;">${mentionBar(t.mentionCount, maxCount)}</div>
      </td>
      <td style="padding:12px 14px;vertical-align:top;">
        <div style="margin-bottom:5px;">${accountPills}</div>
        <div style="font-size:11px;color:#4a5568;font-family:monospace;">
          ${t.uniqueAccounts} account${t.uniqueAccounts !== 1 ? "s" : ""}
        </div>
      </td>
      <td style="padding:12px 14px;font-size:12px;color:#8899aa;
                 max-width:280px;vertical-align:top;line-height:1.5;">
        ${t.recentSnippet}
      </td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#0a0c0f;margin:0;padding:24px 16px;font-family:sans-serif;">
<div style="max-width:740px;margin:0 auto;">

  <div style="border-bottom:2px solid #00e5a0;padding-bottom:16px;margin-bottom:20px;">
    <div style="font-family:monospace;color:#00e5a0;font-size:22px;font-weight:600;
                letter-spacing:-0.02em;">ticker-tracker</div>
    <div style="font-family:monospace;color:#4a5568;font-size:11px;margin-top:4px;">
      Top ${ranked.length} tickers by mention frequency &bull; ${dateRange}
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;background:#111418;
                border:1px solid #1e2530;border-radius:8px;overflow:hidden;">
    <thead>
      <tr style="background:#181c22;">
        <th style="padding:8px 14px;text-align:left;font-family:monospace;
                   font-size:10px;color:#4a5568;letter-spacing:0.08em;">#</th>
        <th style="padding:8px 14px;text-align:left;font-family:monospace;
                   font-size:10px;color:#4a5568;letter-spacing:0.08em;">TICKER / MENTIONS</th>
        <th style="padding:8px 14px;text-align:left;font-family:monospace;
                   font-size:10px;color:#4a5568;letter-spacing:0.08em;">SOURCES</th>
        <th style="padding:8px 14px;text-align:left;font-family:monospace;
                   font-size:10px;color:#4a5568;letter-spacing:0.08em;">RECENT SNIPPET</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <p style="font-family:monospace;font-size:10px;color:#2a3341;
            margin-top:20px;text-align:center;">
    ticker-tracker &bull; github actions &bull; rsshub &bull; ${windowDays}-day rolling window
  </p>
</div>
</body>
</html>`;
}

function sendEmail(html) {
  const topSymbols = ranked.slice(0, 5).map(t => `$${t.symbol}(${t.mentionCount}x)`).join(", ");
  const subject    = `📊 Ticker Heat — ${new Date().toLocaleDateString("en-US",
    { month: "short", day: "numeric" })} — ${topSymbols}`;

  const body = JSON.stringify({ from: FROM_EMAIL, to: [TO_EMAIL], subject, html });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.resend.com",
      path:     "/emails",
      method:   "POST",
      headers: {
        "Authorization":  `Bearer ${RESEND_API_KEY}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Resend ${res.statusCode}: ${data}`));
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!ranked.length) {
    console.log("No ranked tickers in tickers.json — skipping email.");
    return;
  }
  const result = await sendEmail(buildHtml(ranked));
  console.log("Email sent:", result.id);
}

main().catch(err => { console.error(err); process.exit(1); });
