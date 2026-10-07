// api/voip24h-calls.js
// Vercel Serverless Function & Local Endpoint for fetching Voip24h call history
try { require("dotenv").config(); } catch (_) {}
const https = require("https");
const crypto = require("crypto");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "";
const R2_CACHE_KEY         = "voip24h_calls_cache.json";

function hmacSha256(key, msg, enc) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest(enc);
}
function sha256hex(msg) {
  const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(String(msg || ""), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function r2Fetch(method, body, objectKey = R2_CACHE_KEY) {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return Promise.resolve({ statusCode: 500, body: "" });
  }
  const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8")) : Buffer.alloc(0);
  const host      = R2_ACCOUNT_ID + ".r2.cloudflarestorage.com";
  const uriPath   = "/" + R2_BUCKET_NAME + "/" + objectKey;
  const now       = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate   = now.toISOString().replace(/[:-]/g, "").replace(/\.\d+/, "");
  const region    = "auto";
  const service   = "s3";

  const payloadHash  = sha256hex(bodyBuf);
  const contentType  = method === "PUT" ? "application/json; charset=utf-8" : "";

  let canonicalHeaders = "host:" + host + "\nx-amz-content-sha256:" + payloadHash + "\nx-amz-date:" + amzDate + "\n";
  let signedHeaders    = "host;x-amz-content-sha256;x-amz-date";
  if (contentType) {
    canonicalHeaders = "content-length:" + bodyBuf.length + "\ncontent-type:" + contentType + "\n" + canonicalHeaders;
    signedHeaders    = "content-length;content-type;" + signedHeaders;
  }

  const canonicalRequest = [method, uriPath, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope  = dateStamp + "/" + region + "/" + service + "/aws4_request";
  const stringToSign     = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256hex(canonicalRequest)].join("\n");

  const kDate    = hmacSha256("AWS4" + R2_SECRET_ACCESS_KEY, dateStamp);
  const kRegion  = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign, "hex");

  const auth = "AWS4-HMAC-SHA256 Credential=" + R2_ACCESS_KEY_ID + "/" + credentialScope + ",SignedHeaders=" + signedHeaders + ",Signature=" + signature;

  const headers = {
    "Authorization":        auth,
    "x-amz-date":           amzDate,
    "x-amz-content-sha256": payloadHash
  };
  if (contentType) {
    headers["Content-Type"] = contentType;
    headers["Content-Length"] = bodyBuf.length;
  }

  return new Promise(function(resolve, reject) {
    const options = { hostname: host, path: uriPath, method: method, headers: headers };
    const req = https.request(options, function(res) {
      const chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    if (bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

async function saveCacheToR2(data) {
  try {
    data.syncedAt = new Date().toISOString();
    await r2Fetch("PUT", JSON.stringify(data));
  } catch (err) {
    console.error("saveCacheToR2 error:", err.message);
  }
}

async function getCacheFromR2() {
  try {
    const res = await r2Fetch("GET");
    if (res.statusCode === 200 && res.body) {
      return JSON.parse(res.body);
    }
  } catch (err) {
    console.error("getCacheFromR2 error:", err.message);
  }
  return null;
}

let cachedSession = {
  jar: null,
  loginTime: 0
};

function parseCookies(cookieHeaders, jar = {}) {
  for (const h of (cookieHeaders || [])) {
    if (!h) continue;
    const parts = h.split(';');
    const [name, ...valParts] = parts[0].split('=');
    const val = valParts.join('=');
    const isDeleted = parts.some(p => p.trim().toLowerCase().startsWith('expires=') && p.includes('1970'));
    if (isDeleted) {
      delete jar[name.trim()];
    } else {
      jar[name.trim()] = val;
    }
  }
  return jar;
}

function jarToString(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function getVoipSession(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedSession.jar && (now - cachedSession.loginTime < 15 * 60 * 1000)) {
    return cachedSession.jar;
  }

  const username = process.env.MISSCALL_USERID;
  const password = process.env.MISSCALL_PASS;

  if (!username || !password) {
    throw new Error("MISSCALL_USERID hoặc MISSCALL_PASS chưa được cấu hình.");
  }

  const jar = {};
  const fd = new URLSearchParams();
  fd.append("username", username);
  fd.append("password", password);

  // Set 6s timeout to fail fast on foreign blocking
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch("https://khachhang.voip24h.vn/apps/api/sign", {
      method: "POST",
      body: fd.toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "x-requested-with": "XMLHttpRequest"
      },
      signal: controller.signal
    });

    let setCookieHeaders = [];
    if (res.headers.getSetCookie) {
      setCookieHeaders = res.headers.getSetCookie();
    } else {
      const single = res.headers.get("set-cookie");
      if (single) setCookieHeaders = [single];
    }
    parseCookies(setCookieHeaders, jar);

    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_) {}

    if (json.status !== 1000) {
      throw new Error("Đăng nhập Voip24h thất bại: " + (json.message || text.slice(0, 200)));
    }

    cachedSession = { jar, loginTime: now };
    return jar;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getCurrentMonthFormatted() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const startStr = `01-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
  const endStr = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
  return {
    date_start: `${startStr} 00:00:00`,
    date_end: `${endStr} 23:59:59`
  };
}

function getTodayFormatted() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const dStr = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
  return {
    date_start: `${dStr} 00:00:00`,
    date_end: `${dStr} 23:59:59`
  };
}

async function fetchCallList(jar, params) {
  const searchParams = new URLSearchParams();
  searchParams.append("draw", "1");
  searchParams.append("start", "0");
  searchParams.append("length", params.length || "5000");
  searchParams.append("date_start", params.date_start);
  searchParams.append("date_end", params.date_end);
  if (params.did && params.did !== "all") {
    searchParams.append("did[]", params.did);
  }
  searchParams.append("extension", params.extension || "");
  searchParams.append("source", params.source || "");
  searchParams.append("dest", params.dest || "");
  searchParams.append("type", params.type || "");
  searchParams.append("status", params.status || "");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000);

  try {
    const res = await fetch("https://khachhang.voip24h.vn/call_history/api/historyTotalCallIndex", {
      method: "POST",
      headers: {
        "cookie": jarToString(jar),
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      body: searchParams.toString(),
      signal: controller.signal
    });

    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { return null; }
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const defaultDates = getCurrentMonthFormatted();

  // Parse query params
  let queryParams = {};
  if (req.url && req.url.includes("?")) {
    try {
      const parsedUrl = new URL(req.url, "http://localhost");
      parsedUrl.searchParams.forEach((v, k) => { queryParams[k] = v; });
    } catch (_) {}
  }

  const payload = Object.assign({}, queryParams, req.body || {});
  const action = payload.action || "fetch";
  const date_start = payload.date_start || defaultDates.date_start;
  const date_end = payload.date_end || defaultDates.date_end;
  const did = payload.did !== undefined ? payload.did : "02873065650";

  // ── DOWNLOAD action ────────────────────────────────────────────────────────
  if (action === "download") {
    try {
      let jar = await getVoipSession();

      const dlParams = new URLSearchParams();
      dlParams.append("date_start", date_start);
      dlParams.append("date_end", date_end);
      if (did && did !== "all") dlParams.append("did[]", did);
      dlParams.append("extension", payload.extension || "");
      dlParams.append("source", payload.source || "");
      dlParams.append("dest", payload.dest || "");
      dlParams.append("type", payload.type || "");
      dlParams.append("status", payload.status || "");

      let resDl = await fetch("https://khachhang.voip24h.vn/call_history/api/downloadrecording", {
        method: "POST",
        headers: {
          "cookie": jarToString(jar),
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        body: dlParams.toString()
      });

      let dlJson = await resDl.json().catch(() => null);
      if (!dlJson || dlJson.status !== 1000) {
        jar = await getVoipSession(true);
        resDl = await fetch("https://khachhang.voip24h.vn/call_history/api/downloadrecording", {
          method: "POST",
          headers: {
            "cookie": jarToString(jar),
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          },
          body: dlParams.toString()
        });
        dlJson = await resDl.json().catch(() => null);
      }

      const downloadUrl = dlJson?.data?.url || dlJson?.url || "";

      return res.status(200).json({
        status: "success",
        url: downloadUrl,
        data: dlJson?.data || {},
        message: dlJson?.message || "Export completed"
      });
    } catch (err) {
      console.error("voip24h download error:", err.message);
      return res.status(500).json({
        status: "error",
        message: "Không thể kết nối tổng đài để tải file: " + err.message
      });
    }
  }

  // ── FETCH action (default) ─────────────────────────────────────────────────
  try {
    let jar = await getVoipSession();
    let data = await fetchCallList(jar, { date_start, date_end, did, ...payload });

    if (!data || !data.data) {
      jar = await getVoipSession(true);
      data = await fetchCallList(jar, { date_start, date_end, did, ...payload });
    }

    if (data && data.data) {
      const rawList = data.data || [];
      const calls = rawList.map((item, idx) => {
        const cleanStatus = (item.status || "").replace(/<[^>]+>/g, "").trim();
        const cleanType = (item.type || "").replace(/<[^>]+>/g, "").trim();
        return {
          id: item.uniqueid || item.linkedid || String(idx),
          stt: idx + 1,
          calldate: item.calldate,
          calldate_end: item.calldate_end,
          src: item.src,
          dst: item.dst,
          duration: item.duration,
          billsec: item.billsec,
          disposition: item.disposition || item.asterisk_disposition,
          statusText: cleanStatus || item.disposition,
          typeText: cleanType || item.type_origin,
          type_origin: item.type_origin,
          did: item.did,
          recordingfile: item.recordingfile,
          media_token: item.media_token
        };
      });

      function isCallAnswered(c) {
        const disp = (c.disposition || "").toUpperCase();
        const st = (c.statusText || "").toLowerCase();
        const byDisp = disp === "ANSWERED" || st.includes("tra loi") || st.includes("trả lời");
        if (!byDisp) return false;
        const bs = c.billsec;
        if (bs === undefined || bs === null || bs === "" || bs === "—") return false;
        if (typeof bs === "number") return bs > 0;
        const parts = String(bs).split(":").map(Number);
        const totalSec = parts.length === 3
          ? parts[0] * 3600 + parts[1] * 60 + parts[2]
          : parts.length === 2 ? parts[0] * 60 + parts[1] : Number(bs);
        return totalSec > 0;
      }

      let answered = 0, missed = 0, inbound = 0, outbound = 0;
      for (const c of calls) {
        if (isCallAnswered(c)) answered++;
        else missed++;

        const t = (c.type_origin || "").toLowerCase();
        const tt = (c.typeText || "").toLowerCase();
        if (t === "inbound" || tt.includes("vao") || tt.includes("vào")) inbound++;
        else if (t === "outbound" || tt.includes("ra")) outbound++;
      }

      const responsePayload = {
        status: "success",
        source: "live_voip24h",
        total: calls.length,
        recordsTotal: data.recordsTotal || calls.length,
        recordsFiltered: data.recordsFiltered || calls.length,
        stats: { total: calls.length, answered, missed, inbound, outbound },
        filter: { date_start, date_end, did },
        syncedAt: new Date().toISOString(),
        calls
      };

      // Save to Cloudflare R2 cache asynchronously so Vercel can always read it
      saveCacheToR2(responsePayload);

      return res.status(200).json(responsePayload);
    }
  } catch (liveErr) {
    console.warn("Voip24h live fetch failed (likely blocked IP outside VN):", liveErr.message);
  }

  // ── FALLBACK TO R2 CACHE ───────────────────────────────────────────────────
  // When running on foreign cloud (Vercel) where Voip24h blocks incoming connections,
  // load the latest synced data from Cloudflare R2!
  const cachedData = await getCacheFromR2();
  if (cachedData && cachedData.calls) {
    // Recalculate stats with strict billsec > 0 rule
    let cAnswered = 0, cMissed = 0, cInbound = 0, cOutbound = 0;
    for (const c of cachedData.calls) {
      const disp = (c.disposition || "").toUpperCase();
      const st = (c.statusText || "").toLowerCase();
      const byDisp = disp === "ANSWERED" || st.includes("tra loi") || st.includes("trả lời");
      const bs = c.billsec;
      let ans = false;
      if (byDisp && bs !== undefined && bs !== null && bs !== "" && bs !== "—") {
        if (typeof bs === "number") ans = bs > 0;
        else {
          const parts = String(bs).split(":").map(Number);
          const totalSec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : Number(bs);
          ans = totalSec > 0;
        }
      }
      if (ans) cAnswered++;
      else cMissed++;
      const t = (c.type_origin || "").toLowerCase();
      const tt = (c.typeText || "").toLowerCase();
      if (t === "inbound" || tt.includes("vao") || tt.includes("vào")) cInbound++;
      else if (t === "outbound" || tt.includes("ra")) cOutbound++;
    }

    return res.status(200).json({
      ...cachedData,
      stats: { total: cachedData.calls.length, answered: cAnswered, missed: cMissed, inbound: cInbound, outbound: cOutbound },
      source: "r2_cloud",
      note: "Dữ liệu được tải từ bộ nhớ đệm đám mây R2 (Do tổng đài Voip24h chặn IP nước ngoài của Vercel)"
    });
  }

  return res.status(500).json({
    status: "error",
    message: "Tổng đài Voip24h chặn IP máy chủ Vercel ở nước ngoài và chưa có bản lưu trên R2. Hãy nhấn đồng bộ trên máy có chạy server nội bộ để cập nhật lên R2."
  });
};
