// api/helpdesk-tickets.js
// Vercel Serverless Function & Local Endpoint for fetching Helpdesk (Chatbox AI) tickets
try { require("dotenv").config(); } catch (_) {}

try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.resolve(__dirname, "..", ".env");
  const envPathLocal = path.resolve(__dirname, ".env");
  const targetPath = fs.existsSync(envPath) ? envPath : (fs.existsSync(envPathLocal) ? envPathLocal : null);
  if (targetPath) {
    const lines = fs.readFileSync(targetPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
} catch (_) {}

const https = require("https");
const crypto = require("crypto");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "b63e9e1ed38dbfd59b2e77a28bb00a36";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "30d0d30195468279bab5ca499ff39cf0";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "7f2dc82f5e23d39b0743fbd615ce1ea964f4e182806c0c18ba81fac706c777bd";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "dylan";
const R2_CACHE_KEY         = "helpdesk_tickets_cache.json";

const HELPDESK_BASE_URL    = "https://helpdesk.ai-audit-test.online";
const DEFAULT_USERNAME     = process.env.HELPDESK_USERNAME || "tanh.h.bui.3811";
const DEFAULT_PASSWORD     = process.env.HELPDESK_PASSWORD || "1";

function hmacSha256(key, msg, enc) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest(enc);
}
function sha256hex(msg) {
  const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(String(msg || ""), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function r2Fetch(method, body = "", objectKey = R2_CACHE_KEY) {
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
    const req = https.request({ hostname: host, path: uriPath, method: method, headers: headers }, function(res) {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

async function getCacheFromR2() {
  try {
    const res = await r2Fetch("GET");
    if (res.statusCode === 200 && res.body) {
      return JSON.parse(res.body);
    }
  } catch (err) {
    console.warn("[Helpdesk] Lỗi đọc cache R2:", err.message);
  }
  return null;
}

async function saveCacheToR2(payload) {
  try {
    const jsonStr = JSON.stringify(payload);
    const res = await r2Fetch("PUT", jsonStr);
    return res.statusCode >= 200 && res.statusCode < 300;
  } catch (err) {
    console.warn("[Helpdesk] Lỗi lưu cache R2:", err.message);
    return false;
  }
}

function httpsRequest(url, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, data: JSON.parse(bodyStr) }); }
        catch { resolve({ status: res.statusCode, body: bodyStr }); }
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function getCurrentMonthRange() {
  const d = new Date(Date.now() + 7 * 3600000); // UTC+7
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return {
    from_date: `${yyyy}-${mm}-01`,
    to_date: `${yyyy}-${mm}-${dd}`
  };
}

async function loginHelpdesk(username, password) {
  const postData = JSON.stringify({
    username: username || DEFAULT_USERNAME,
    password: password || DEFAULT_PASSWORD
  });
  const res = await httpsRequest(`${HELPDESK_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData)
    }
  }, postData);

  if (res.status === 200 && res.data && res.data.access_token) {
    return res.data;
  }
  throw new Error(`Login Helpdesk thất bại (HTTP ${res.status}): ${JSON.stringify(res.data || res.body)}`);
}

async function fetchLiveTickets(options = {}) {
  const username = options.username || DEFAULT_USERNAME;
  const password = options.password || DEFAULT_PASSWORD;
  const auth = await loginHelpdesk(username, password);
  const token = auth.access_token;

  const defaultRange = getCurrentMonthRange();
  const from_date = options.from_date || defaultRange.from_date;
  const to_date = options.to_date || defaultRange.to_date;

  let allItems = [];
  let page = 1;
  const limit = 100;
  const maxPages = 50;

  while (page <= maxPages) {
    const query = new URLSearchParams({
      scope: "team",
      category: "HELPDESK",
      project: "NVN",
      from_date: from_date,
      to_date: to_date,
      page: String(page),
      limit: String(limit)
    });
    const url = `${HELPDESK_BASE_URL}/api/tickets?${query.toString()}`;
    const res = await httpsRequest(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.status !== 200 || !res.data) {
      console.warn(`[Helpdesk] Fetch page ${page} error: HTTP ${res.status}`);
      break;
    }

    const items = res.data.items || [];
    allItems = allItems.concat(items);

    const total = res.data.total || 0;
    if (items.length < limit || allItems.length >= total) {
      break;
    }
    page++;
  }

  // Normalize tickets
  const cleanTickets = allItems.map(t => {
    let callDetailObj = null;
    if (t.call_details) {
      try {
        callDetailObj = typeof t.call_details === "string" ? JSON.parse(t.call_details) : t.call_details;
      } catch (_) {}
    }

    return {
      id: t.id,
      project: t.project || "NVN",
      category: t.ticket_category || t.category || "HELPDESK",
      status: t.status || "",
      priority: t.priority || "P3",
      agentId: (t.assigned_agent?.agent_id || t.assigned_agent_id || "").trim(),
      agentName: (t.assigned_agent?.name || "").trim(),
      date: t.date || t.created_date || (t.created_at ? t.created_at.slice(0, 10) : ""),
      createdAt: t.created_at || "",
      createdDate: t.created_date || t.date || "",
      phone: (t.contact_source || "").trim(),
      distName: (t.dist_name || "").trim(),
      dsrCode: (t.dsr_code || "").trim(),
      solutionCode: (t.solution_code || callDetailObj?.solution_linked?.solution_code || "").trim(),
      solutionName: (t.solution_name || callDetailObj?.solution_linked?.solution_name || t.description || "").trim(),
      description: (t.description || "").trim(),
      callDetails: t.call_details || "",
      callDetailsParsed: callDetailObj,
      result: (t.result || "").trim(),
      processSteps: (t.process_steps || "").trim(),
      rootCause: (t.root_cause || "").trim()
    };
  });

  return {
    tickets: cleanTickets,
    total: cleanTickets.length,
    filter: { scope: "team", category: "HELPDESK", project: "NVN", from_date, to_date },
    loggedUser: { username: auth.username, fullName: auth.full_name }
  };
}

let lastLiveSyncTime = 0;
let ongoingLiveSyncPromise = null;

async function syncHelpdeskTickets(force = false, options = {}) {
  // 1. Nếu không ép buộc, kiểm tra cache R2 xem còn hạn (< 3 phút) không
  if (!force) {
    const cached = await getCacheFromR2();
    if (cached && Array.isArray(cached.tickets)) {
      const syncedMs = cached.syncedAt ? new Date(cached.syncedAt).getTime() : 0;
      const ageMinutes = (Date.now() - syncedMs) / (60 * 1000);
      if (ageMinutes < 3) {
        return {
          ...cached,
          source: "r2_cache",
          cacheAgeMinutes: Math.round(ageMinutes * 10) / 10
        };
      }
    }
  }

  if (ongoingLiveSyncPromise) {
    return ongoingLiveSyncPromise;
  }

  ongoingLiveSyncPromise = (async () => {
    try {
      console.log(`[Helpdesk Sync] 🚀 Đang cào dữ liệu từ Helpdesk AI Assistant (scope=team, category=HELPDESK, project=NVN)...`);
      const result = await fetchLiveTickets(options);
      const payload = {
        status: "success",
        total: result.total,
        syncedAt: new Date().toISOString(),
        source: "live_crawled",
        filter: result.filter,
        loggedUser: result.loggedUser,
        tickets: result.tickets
      };
      await saveCacheToR2(payload);
      lastLiveSyncTime = Date.now();
      console.log(`[Helpdesk Sync] ✅ Đã đồng bộ thành công ${payload.total} ticket lên Cloudflare R2!`);
      return payload;
    } finally {
      ongoingLiveSyncPromise = null;
    }
  })();

  return ongoingLiveSyncPromise;
}

// ── VERCEL SERVERLESS & LOCAL HANDLER ─────────────────────────────────────────
module.exports = async function handler(req, res) {
  const isVercel = process.env.VERCEL === "1";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Pragma, Cache-Control, X-Requested-With");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const parsedUrl = new URL(req.url, "http://localhost");
  const forceSync = parsedUrl.searchParams.get("sync") === "1" || parsedUrl.searchParams.get("force") === "1";
  const from_date = parsedUrl.searchParams.get("from_date") || undefined;
  const to_date = parsedUrl.searchParams.get("to_date") || undefined;
  const username = parsedUrl.searchParams.get("username") || undefined;

  // 1. Nếu không yêu cầu ép đồng bộ, thử lấy từ Cloudflare R2 cache trước
  if (!forceSync) {
    const cached = await getCacheFromR2();
    if (cached && Array.isArray(cached.tickets)) {
      const syncedMs = cached.syncedAt ? new Date(cached.syncedAt).getTime() : 0;
      const ageMinutes = (Date.now() - syncedMs) / (60 * 1000);

      // Nếu cache còn mới (< 3 phút), trả về ngay tức khắc để tránh spam
      if (ageMinutes < 3) {
        return res.status(200).json({
          ...cached,
          source: "r2_cache",
          cacheAgeMinutes: Math.round(ageMinutes * 10) / 10,
          server: isVercel ? "vercel" : "local"
        });
      }
    }
  }

  // 2. Cần đồng bộ mới hoặc cache đã quá 3 phút (hoặc forceSync = true)
  try {
    const payload = await syncHelpdeskTickets(forceSync, { from_date, to_date, username });
    return res.status(200).json({
      ...payload,
      source: "live_helpdesk",
      server: isVercel ? "vercel" : "local"
    });
  } catch (err) {
    console.error("[Helpdesk] Lỗi khi đồng bộ:", err.message);
    // Fallback: nếu gọi live lỗi, cố gắng trả về bản cache cũ trên R2
    const fallbackCached = await getCacheFromR2();
    if (fallbackCached && Array.isArray(fallbackCached.tickets)) {
      return res.status(200).json({
        ...fallbackCached,
        source: "r2_cache_fallback",
        warning: `Không thể kết nối trực tiếp đến Helpdesk: ${err.message}. Đang sử dụng dữ liệu đã lưu gần nhất.`,
        server: isVercel ? "vercel" : "local"
      });
    }

    return res.status(500).json({
      status: "error",
      message: `Lỗi đồng bộ ticket từ Helpdesk: ${err.message}`
    });
  }
};

module.exports.syncHelpdeskTickets = syncHelpdeskTickets;
module.exports.getCacheFromR2 = getCacheFromR2;
