// api/voip24h-calls.js
// Vercel Serverless Function & Local Endpoint for fetching Voip24h call history & exports

let cachedSession = {
  jar: null,
  loginTime: 0
};

function parseCookies(cookieHeaders, jar = {}) {
  for (const h of cookieHeaders) {
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

  const username = process.env.MISSCALL_USERID || "Misscall@5stars.com.vn";
  const password = process.env.MISSCALL_PASS || "Misscall@123";

  if (!username || !password) {
    throw new Error("MISSCALL_USERID hoặc MISSCALL_PASS chưa được cấu hình.");
  }

  const jar = {};
  const fd = new FormData();
  fd.append("username", username);
  fd.append("password", password);

  const res = await fetch("https://khachhang.voip24h.vn/apps/api/sign", {
    method: "POST",
    body: fd,
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
  });

  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")];
  parseCookies((cookies || []).filter(Boolean), jar);

  const json = await res.json().catch(() => ({}));
  if (json.status !== 1000) {
    throw new Error("Đăng nhập Voip24h thất bại: " + (json.message || JSON.stringify(json)));
  }

  cachedSession = {
    jar,
    loginTime: now
  };
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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const defaultDates = getTodayFormatted();
    let queryParams = {};

    if (req.url && req.url.includes("?")) {
      const parsedUrl = new URL(req.url, "http://localhost");
      parsedUrl.searchParams.forEach((v, k) => { queryParams[k] = v; });
    }

    const payload = Object.assign({}, queryParams, req.body || {});
    const action = payload.action || "fetch";
    const date_start = payload.date_start || defaultDates.date_start;
    const date_end = payload.date_end || defaultDates.date_end;
    // Selection 2 is 02873065650
    const did = payload.did !== undefined ? payload.did : "02873065650";

    if (action === "download") {
      // Trigger Voip24h export file
      let jar = await getVoipSession();
      const dlParams = new URLSearchParams();
      dlParams.append("date_start", date_start);
      dlParams.append("date_end", date_end);
      if (did && did !== "all") {
        dlParams.append("did[]", did);
      }
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
        // Retry with refreshed session
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
      const downloadUrl = dlJson?.data?.url || "";
      if (payload.stream === "1" || payload.stream === "true" || payload.stream === true) {
        if (!downloadUrl) {
          return res.status(404).json({ status: "error", message: "Không tìm thấy file để tải" });
        }
        const fileRes = await fetch(downloadUrl);
        const buffer = await fileRes.arrayBuffer();
        const filename = downloadUrl.split("/").pop() || "CallHistory.csv";
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-Type", fileRes.headers.get("content-type") || "text/csv; charset=utf-8");
        return res.status(200).send(Buffer.from(buffer));
      }

      return res.status(200).json({
        status: "success",
        url: downloadUrl,
        data: dlJson?.data || {},
        message: dlJson?.message || "Export completed"
      });
    }

    // Default: fetch call list and stats
    let jar = await getVoipSession();

    const searchParams = new URLSearchParams();
    searchParams.append("draw", "1");
    searchParams.append("start", "0");
    searchParams.append("length", payload.length || "1000"); // up to 1000 items
    searchParams.append("date_start", date_start);
    searchParams.append("date_end", date_end);
    if (did && did !== "all") {
      searchParams.append("did[]", did);
    }
    searchParams.append("extension", payload.extension || "");
    searchParams.append("source", payload.source || "");
    searchParams.append("dest", payload.dest || "");
    searchParams.append("type", payload.type || "");
    searchParams.append("status", payload.status || "");

    let resTable = await fetch("https://khachhang.voip24h.vn/call_history/api/historyTotalCallIndex", {
      method: "POST",
      headers: {
        "cookie": jarToString(jar),
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      body: searchParams.toString()
    });

    let data = await resTable.json().catch(() => null);
    if (!data || !data.data) {
      // Re-login and try again
      jar = await getVoipSession(true);
      resTable = await fetch("https://khachhang.voip24h.vn/call_history/api/historyTotalCallIndex", {
        method: "POST",
        headers: {
          "cookie": jarToString(jar),
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        body: searchParams.toString()
      });
      data = await resTable.json().catch(() => null);
    }

    const rawList = data?.data || [];
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
    let answered = 0;
    let missed = 0;
    let inbound = 0;
    let outbound = 0;

    for (const c of calls) {
      const disp = (c.disposition || "").toUpperCase();
      const st = (c.statusText || "").toLowerCase();
      if (disp === "ANSWERED" || st.includes("trả lời")) {
        answered++;
      } else if (disp === "MISSED" || st.includes("nhỡ") || st.includes("không")) {
        missed++;
      }

      const t = (c.type_origin || "").toLowerCase();
      const tt = (c.typeText || "").toLowerCase();
      if (t === "inbound" || tt.includes("vào")) {
        inbound++;
      } else if (t === "outbound" || tt.includes("ra")) {
        outbound++;
      }
    }

    return res.status(200).json({
      status: "success",
      total: calls.length,
      recordsTotal: data?.recordsTotal || calls.length,
      recordsFiltered: data?.recordsFiltered || calls.length,
      stats: {
        total: calls.length,
        answered,
        missed,
        inbound,
        outbound
      },
      filter: {
        date_start,
        date_end,
        did
      },
      calls
    });
  } catch (err) {
    console.error("voip24h-calls error:", err);
    return res.status(500).json({
      status: "error",
      message: err.message || "Lỗi khi gọi Voip24h API"
    });
  }
};
