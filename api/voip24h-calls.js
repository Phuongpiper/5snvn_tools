// api/voip24h-calls.js
// Vercel Serverless Function & Local Endpoint for fetching Voip24h call history

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
  // Session valid for 15 minutes
  if (!forceRefresh && cachedSession.jar && (now - cachedSession.loginTime < 15 * 60 * 1000)) {
    return cachedSession.jar;
  }

  const username = process.env.MISSCALL_USERID;
  const password = process.env.MISSCALL_PASS;

  if (!username || !password) {
    throw new Error("MISSCALL_USERID hoac MISSCALL_PASS chua duoc cau hinh.");
  }

  const jar = {};
  const fd = new URLSearchParams();
  fd.append("username", username);
  fd.append("password", password);

  const res = await fetch("https://khachhang.voip24h.vn/apps/api/sign", {
    method: "POST",
    body: fd.toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "x-requested-with": "XMLHttpRequest"
    }
  });

  // Collect cookies
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
    throw new Error("Dang nhap Voip24h that bai: " + (json.message || text.slice(0, 200)));
  }

  cachedSession = { jar, loginTime: now };
  return jar;
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
  searchParams.append("length", params.length || "1000");
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

  const res = await fetch("https://khachhang.voip24h.vn/call_history/api/historyTotalCallIndex", {
    method: "POST",
    headers: {
      "cookie": jarToString(jar),
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    body: searchParams.toString()
  });

  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const defaultDates = getTodayFormatted();

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

    // ── DOWNLOAD action ──────────────────────────────────────────────────────
    if (action === "download") {
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

      let dlText = await resDl.text();
      let dlJson = null;
      try { dlJson = JSON.parse(dlText); } catch (_) {}

      // Retry once if session expired
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
        dlText = await resDl.text();
        try { dlJson = JSON.parse(dlText); } catch (_) {}
      }

      const downloadUrl = dlJson?.data?.url || dlJson?.url || "";

      return res.status(200).json({
        status: "success",
        url: downloadUrl,
        data: dlJson?.data || {},
        message: dlJson?.message || "Export completed"
      });
    }

    // ── FETCH action (default) ───────────────────────────────────────────────
    let jar = await getVoipSession();
    let data = await fetchCallList(jar, { date_start, date_end, did, ...payload });

    // Retry with fresh session if needed
    if (!data || !data.data) {
      jar = await getVoipSession(true);
      data = await fetchCallList(jar, { date_start, date_end, did, ...payload });
    }

    if (!data) {
      return res.status(502).json({ status: "error", message: "Voip24h khong tra ve du lieu hop le." });
    }

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

    // Compute stats
    let answered = 0, missed = 0, inbound = 0, outbound = 0;
    for (const c of calls) {
      const disp = (c.disposition || "").toUpperCase();
      const st = (c.statusText || "").toLowerCase();
      if (disp === "ANSWERED" || st.includes("tra loi") || st.includes("trả lời")) answered++;
      else if (disp === "MISSED" || st.includes("nho") || st.includes("nhỡ") || st.includes("khong")) missed++;

      const t = (c.type_origin || "").toLowerCase();
      const tt = (c.typeText || "").toLowerCase();
      if (t === "inbound" || tt.includes("vao") || tt.includes("vào")) inbound++;
      else if (t === "outbound" || tt.includes(" ra")) outbound++;
    }

    return res.status(200).json({
      status: "success",
      total: calls.length,
      recordsTotal: data.recordsTotal || calls.length,
      recordsFiltered: data.recordsFiltered || calls.length,
      stats: { total: calls.length, answered, missed, inbound, outbound },
      filter: { date_start, date_end, did },
      calls
    });

  } catch (err) {
    console.error("voip24h-calls error:", err);
    return res.status(500).json({
      status: "error",
      message: err.message || "Loi khi goi Voip24h API"
    });
  }
};
