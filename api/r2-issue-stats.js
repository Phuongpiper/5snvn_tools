try { require("dotenv").config(); } catch(_) {}
const https = require("https");
const crypto = require("crypto");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "";
const R2_ISSUES_KEY        = "dms_note_issues.json";

function hmacSha256(key, msg, enc) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest(enc);
}
function sha256hex(msg) {
  const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(String(msg || ""), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function buildR2Request(method, body, objectKey) {
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
    canonicalHeaders = "content-type:" + contentType + "\n" + canonicalHeaders;
    signedHeaders    = "content-type;" + signedHeaders;
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
  return { host, path: uriPath, headers, bodyBuf };
}

function r2Fetch(method, body, objectKey) {
  body = body || "";
  return new Promise(function(resolve, reject) {
    const info = buildR2Request(method, body, objectKey);
    const options = { hostname: info.host, path: info.path, method: method, headers: info.headers };
    const req = https.request(options, function(res) {
      const chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        const fullBody = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, body: fullBody, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (info.bodyBuf && info.bodyBuf.length > 0) req.write(info.bodyBuf);
    req.end();
  });
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "ETag, Last-Modified"
};

/**
 * Chuẩn hoá chuỗi ngày về định dạng DD/MM/YYYY
 * Hỗ trợ: YYYY-MM-DD, DD/MM/YYYY, D/M/YYYY, timestamp số
 */
function normalizeDate(dateStr) {
  if (!dateStr) return "";
  const s = String(dateStr).trim();

  // Dạng DD/MM/YYYY hoặc D/M/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split("/");
    return d.padStart(2, "0") + "/" + m.padStart(2, "0") + "/" + y;
  }

  // Dạng YYYY-MM-DD (ISO date)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split("-");
    return d + "/" + m + "/" + y;
  }

  // Timestamp số (milliseconds)
  const ts = Number(s);
  if (!isNaN(ts) && ts > 1000000000000) {
    const dt = new Date(ts);
    const dd   = String(dt.getDate()).padStart(2, "0");
    const mm   = String(dt.getMonth() + 1).padStart(2, "0");
    const yyyy = dt.getFullYear();
    return dd + "/" + mm + "/" + yyyy;
  }

  return s;
}

/**
 * Tổng hợp số lượng Issue theo ngày và nhân viên
 * @param {Array}  issues  - Danh sách issues từ R2
 * @param {Object} filters - { date, memberCode, dateFrom, dateTo }
 * @returns {{ rows: Array, total: number, groupedByDate: Object }}
 */
function aggregateIssueStats(issues, filters) {
  filters = filters || {};
  if (!Array.isArray(issues) || issues.length === 0) {
    return { rows: [], total: 0, groupedByDate: {} };
  }

  // Parse ngày lọc một lần duy nhất
  function parseDMY(s) {
    const n = normalizeDate(s);
    if (!n) return null;
    const [d, m, y] = n.split("/");
    return new Date(Number(y), Number(m) - 1, Number(d));
  }

  const filterDate     = filters.date       ? normalizeDate(filters.date) : "";
  const filterFrom     = filters.dateFrom   ? parseDMY(filters.dateFrom)  : null;
  const filterTo       = filters.dateTo     ? parseDMY(filters.dateTo)    : null;
  const filterMember   = filters.memberCode ? String(filters.memberCode).trim().toUpperCase() : "";

  // Map: "DD/MM/YYYY__MEMBERCODE" -> { date, memberCode, count }
  const countMap = new Map();

  for (const issue of issues) {
    if (!issue || !issue.result) continue;

    const date       = normalizeDate(issue.date);
    const memberCode = String(issue.memberCode || issue.member || "").trim();

    if (!date || !memberCode) continue;

    // --- Áp dụng bộ lọc ---
    if (filterDate && date !== filterDate) continue;

    if (filterFrom || filterTo) {
      const [d, m, y] = date.split("/");
      const dateVal = new Date(Number(y), Number(m) - 1, Number(d));
      if (filterFrom && dateVal < filterFrom) continue;
      if (filterTo   && dateVal > filterTo)   continue;
    }

    if (filterMember && memberCode.toUpperCase() !== filterMember) continue;
    // ----------------------

    const key = date + "__" + memberCode.toUpperCase();
    if (countMap.has(key)) {
      countMap.get(key).count++;
    } else {
      countMap.set(key, { date, memberCode, count: 1 });
    }
  }

  // Sắp xếp: ngày mới nhất trước, trong cùng ngày sort theo memberCode A->Z
  const rows = Array.from(countMap.values()).sort(function(a, b) {
    function toTime(s) {
      const [d, m, y] = s.split("/");
      return new Date(Number(y), Number(m) - 1, Number(d)).getTime();
    }
    const diff = toTime(b.date) - toTime(a.date);
    if (diff !== 0) return diff;
    return a.memberCode.localeCompare(b.memberCode);
  });

  const total = rows.reduce(function(sum, r) { return sum + r.count; }, 0);

  // Group theo ngày để extension dễ render bảng theo nhóm ngày
  const groupedByDate = {};
  for (const row of rows) {
    if (!groupedByDate[row.date]) groupedByDate[row.date] = [];
    groupedByDate[row.date].push({ memberCode: row.memberCode, count: row.count });
  }

  return { rows, total, groupedByDate };
}

// ============================================================
// Handler chính
// ============================================================
module.exports = async function handler(req, res) {
  // CORS preflight
  Object.entries(CORS).forEach(function(e) { res.setHeader(e[0], e[1]); });
  if (req.method === "OPTIONS") return res.status(204).end();

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  try {
    // ---- Query params ----
    // ?date=05/10/2026                       -> lọc đúng một ngày
    // ?dateFrom=01/10/2026&dateTo=05/10/2026 -> lọc khoảng ngày
    // ?memberCode=khoa.a.ly.6069             -> lọc một nhân viên
    // Có thể kết hợp nhiều params
    const urlParts = require("url").parse(req.url, true);
    const q = urlParts.query || {};

    const filters = {
      date:       q.date       || "",
      dateFrom:   q.dateFrom   || q.from   || "",
      dateTo:     q.dateTo     || q.to     || "",
      memberCode: q.memberCode || q.member || ""
    };

    // ---- Lấy dữ liệu từ R2 ----
    const r2Res = await r2Fetch("GET", "", R2_ISSUES_KEY);

    if (r2Res.statusCode === 404) {
      return res.status(200).json({
        status: "success",
        filters: filters,
        rows: [],
        total: 0,
        groupedByDate: {},
        issueCount: 0
      });
    }

    if (r2Res.statusCode !== 200) {
      return res.status(502).json({
        error: "Không thể đọc dữ liệu từ R2",
        r2Status: r2Res.statusCode
      });
    }

    let issues = [];
    try {
      const parsed = JSON.parse(r2Res.body);
      issues = Array.isArray(parsed.issues) ? parsed.issues
             : Array.isArray(parsed)        ? parsed
             : [];
    } catch (_) {
      // body không parse được -> trả về rỗng
    }

    const stats = aggregateIssueStats(issues, filters);

    return res.status(200).json({
      status:        "success",
      filters:       filters,
      /**
       * rows: mảng phẳng, mỗi phần tử = 1 dòng trong bảng
       * [
       *   { date: "05/10/2026", memberCode: "khoa.a.ly.6069",         count: 9  },
       *   { date: "05/10/2026", memberCode: "phuong.h.nguyen.0750",    count: 15 },
       *   ...
       * ]
       */
      rows:          stats.rows,
      /**
       * total: Tổng cộng (dòng "Tổng cộng" cuối bảng)
       */
      total:         stats.total,
      /**
       * groupedByDate: group theo ngày để render bảng theo nhóm
       * {
       *   "05/10/2026": [
       *     { memberCode: "khoa.a.ly.6069",      count: 9  },
       *     { memberCode: "phuong.h.nguyen.0750", count: 15 },
       *   ]
       * }
       */
      groupedByDate: stats.groupedByDate,
      issueCount:    issues.length
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
