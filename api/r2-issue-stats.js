try { require("dotenv").config(); } catch(_) {}
const https = require("https");
const crypto = require("crypto");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "";
const R2_ISSUES_KEY        = "dms_note_issues.json";
const R2_CALLS_KEY         = "voip24h_calls_cache.json";
const R2_TASK_KEY          = "task_pending_data.json";

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
    const rawMemberCode = String(issue.memberCode || issue.member || "").trim();
    const memberCode = rawMemberCode.toLowerCase();

    if (!date || !memberCode) continue;

    // --- Áp dụng bộ lọc ---
    if (filterDate && date !== filterDate) continue;

    if (filterFrom || filterTo) {
      const [d, m, y] = date.split("/");
      const dateVal = new Date(Number(y), Number(m) - 1, Number(d));
      if (filterFrom && dateVal < filterFrom) continue;
      if (filterTo   && dateVal > filterTo)   continue;
    }

    if (filterMember && rawMemberCode.toUpperCase() !== filterMember) continue;
    // ----------------------

    const key = date + "__" + memberCode.toUpperCase();
    if (countMap.has(key)) {
      countMap.get(key).count++;
    } else {
      countMap.set(key, { date, memberCode: memberCode.toLowerCase(), count: 1 });
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

/**
 * Kiểm tra cuộc gọi đã được trả lời (đàm thoại > 0)
 */
function isCallAnswered(c) {
  if (!c) return false;
  const bs = c.billsec;
  if (bs === undefined || bs === null || bs === "" || bs === "—") return false;
  if (typeof bs === "number") return bs > 0;
  const parts = String(bs).split(":").map(Number);
  const totalSec = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts.length === 2 ? parts[0] * 60 + parts[1] : Number(bs);
  return totalSec > 0;
}

/**
 * Lấy ngày và tháng hôm nay theo giờ Việt Nam (UTC+7)
 */
function getVietnamToday() {
  const d = new Date(Date.now() + 7 * 3600000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return {
    isoDate: `${yyyy}-${mm}-${dd}`,
    isoMonth: `${yyyy}-${mm}`,
    displayDate: `${dd}/${mm}/${yyyy}`
  };
}

/**
 * Tổng hợp số lượng cuộc gọi theo tháng và ngày cho từng nhân viên
 */
function aggregateCallStats(calls, members, targetIsoDate, targetIsoMonth) {
  // Danh sách nhân viên mặc định nếu không có trên R2
  const canonicalMembers = [
    { code: "khoa.a.ly.6069", extension: "113" },
    { code: "phuong.h.nguyen.0750", extension: "116" },
    { code: "tanh.h.bui.3811", extension: "118" },
    { code: "toan.t.nguyen.0814", extension: "119" }
  ];

  const memberMap = new Map();
  canonicalMembers.forEach(m => memberMap.set(m.code.toLowerCase(), { ...m }));

  if (Array.isArray(members)) {
    members.forEach(m => {
      const code = String(m.code || "").toLowerCase().trim();
      const ext = String(m.extension || "").trim();
      if (code && ext && !memberMap.has(code)) {
        memberMap.set(code, { code, extension: ext });
      } else if (code && ext && memberMap.has(code) && !memberMap.get(code).extension) {
        memberMap.get(code).extension = ext;
      }
    });
  }

  const sortedMembers = Array.from(memberMap.values()).sort((a, b) => a.code.localeCompare(b.code));

  let totalMonth = 0;
  let totalDay = 0;
  const rows = [];

  for (const m of sortedMembers) {
    const ext = String(m.extension || "").trim();
    let monthCount = 0;
    let dayCount = 0;

    if (ext && Array.isArray(calls)) {
      for (const c of calls) {
        if (!c) continue;
        const isExt = String(c.src) === ext || String(c.dst) === ext;
        if (!isExt) continue;
        if (!isCallAnswered(c)) continue;

        const time = String(c.calldate || c.call_date || c.time || "");
        if (targetIsoMonth && time.startsWith(targetIsoMonth)) {
          monthCount++;
        }
        if (targetIsoDate && time.startsWith(targetIsoDate)) {
          dayCount++;
        }
      }
    }

    totalMonth += monthCount;
    totalDay += dayCount;
    rows.push([m.code, String(monthCount), String(dayCount)]);
  }

  return {
    title: "Số lượng cuộc gọi",
    headers: ["Mã NV", "Theo tháng", "Theo ngày"],
    rows: rows,
    total: {
      label: "Tổng cộng",
      month: String(totalMonth),
      today: String(totalDay)
    },
    rowCount: rows.length
  };
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
    // ?date=07/10/2026                       -> lọc đúng một ngày
    // ?dateFrom=01/10/2026&dateTo=07/10/2026 -> lọc khoảng ngày
    // ?memberCode=khoa.a.ly.6069             -> lọc một nhân viên
    let q = {};
    try {
      const parsedUrl = new URL(req.url, "http://localhost");
      parsedUrl.searchParams.forEach((v, k) => { q[k] = v; });
    } catch (_) {
      const urlParts = require("url").parse(req.url, true);
      q = urlParts.query || {};
    }

    const filters = {
      date:       q.date       || "",
      dateFrom:   q.dateFrom   || q.from   || "",
      dateTo:     q.dateTo     || q.to     || "",
      memberCode: q.memberCode || q.member || ""
    };

    // Xác định ngày và tháng mục tiêu cho cuộc gọi
    const vnToday = getVietnamToday();
    let targetIsoDate = vnToday.isoDate;
    let targetIsoMonth = vnToday.isoMonth;
    let targetDisplayDate = vnToday.displayDate;

    if (filters.date) {
      const nDate = normalizeDate(filters.date);
      if (nDate && nDate.includes("/")) {
        const [d, m, y] = nDate.split("/");
        targetIsoDate = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
        targetIsoMonth = `${y}-${m.padStart(2, "0")}`;
        targetDisplayDate = `${d.padStart(2, "0")}/${m.padStart(2, "0")}/${y}`;
      }
    } else {
      // Mặc định bộ lọc lọc theo ngày hôm nay
      filters.date = targetDisplayDate;
    }

    // ---- Lấy song song dữ liệu từ R2 ----
    const [r2IssuesRes, r2CallsRes, r2TaskRes] = await Promise.all([
      r2Fetch("GET", "", R2_ISSUES_KEY).catch(() => ({ statusCode: 500, body: "" })),
      r2Fetch("GET", "", R2_CALLS_KEY).catch(() => ({ statusCode: 500, body: "" })),
      r2Fetch("GET", "", R2_TASK_KEY).catch(() => ({ statusCode: 500, body: "" }))
    ]);

    let issues = [];
    if (r2IssuesRes.statusCode === 200) {
      try {
        const parsed = JSON.parse(r2IssuesRes.body);
        issues = Array.isArray(parsed.issues) ? parsed.issues
               : Array.isArray(parsed)        ? parsed
               : [];
      } catch (_) {}
    }

    let calls = [];
    if (r2CallsRes.statusCode === 200) {
      try {
        const parsed = JSON.parse(r2CallsRes.body);
        calls = Array.isArray(parsed.calls) ? parsed.calls
              : Array.isArray(parsed)       ? parsed
              : [];
      } catch (_) {}
    }

    let members = [];
    if (r2TaskRes.statusCode === 200) {
      try {
        const parsed = JSON.parse(r2TaskRes.body);
        members = Array.isArray(parsed.members) ? parsed.members : [];
      } catch (_) {}
    }

    // 1. Thống kê Issue
    const stats = aggregateIssueStats(issues, filters);

    const leftRows = (stats.rows || []).map(r => [
      r.date || targetDisplayDate,
      (r.memberCode || "").toLowerCase().trim(),
      String(r.count !== undefined && r.count !== null ? r.count : 0)
    ]);

    const leftTable = {
      title: "Số lượng Issue",
      headers: ["Date", "Mã NV", "Số lượng"],
      rows: leftRows,
      total: {
        label: "Tổng cộng",
        value: String(stats.total || 0)
      },
      rowCount: leftRows.length
    };

    // 2. Thống kê Cuộc gọi
    const rightTable = aggregateCallStats(calls, members, targetIsoDate, targetIsoMonth);

    return res.status(200).json({
      status:        "success",
      filters:       filters,
      date:          targetDisplayDate,
      leftTable:     leftTable,
      rightTable:    rightTable,
      rows:          stats.rows,
      total:         stats.total,
      groupedByDate: stats.groupedByDate,
      issueCount:    issues.length,
      callCount:     calls.length
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};

