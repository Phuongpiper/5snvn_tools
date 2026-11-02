// functions/api/[[route]].js - Universal API Router for Cloudflare Pages Functions
// Supports both direct Cloudflare R2 bindings and Node S3/HMAC handlers

const DEFAULT_R2_ACCOUNT_ID = "b63e9e1ed38dbfd59b2e77a28bb00a36";
const DEFAULT_R2_ACCESS_KEY_ID = "30d0d30195468279bab5ca499ff39cf0";
const DEFAULT_R2_SECRET_ACCESS_KEY = "7f2dc82f5e23d39b0743fbd615ce1ea964f4e182806c0c18ba81fac706c777bd";
const DEFAULT_R2_BUCKET_NAME = "dylan";

if (typeof process !== "undefined" && process.env) {
  process.env.R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || DEFAULT_R2_ACCOUNT_ID;
  process.env.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || DEFAULT_R2_ACCESS_KEY_ID;
  process.env.R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || DEFAULT_R2_SECRET_ACCESS_KEY;
  process.env.R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || DEFAULT_R2_BUCKET_NAME;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, If-None-Match, Pragma, Cache-Control, X-Requested-With",
  "Access-Control-Expose-Headers": "ETag, Last-Modified, Content-Length"
};

// Route registry
const HANDLERS = {
  "r2-issues": require("../../api/r2-issues.js"),
  "r2-tasks": require("../../api/r2-tasks.js"),
  "r2-dt": require("../../api/r2-dt.js"),
  "r2-settings": require("../../api/r2-settings.js"),
  "r2-temp-issues": require("../../api/r2-temp-issues.js"),
  "r2-issue-stats": require("../../api/r2-issue-stats.js"),
  "voip24h-calls": require("../../api/voip24h-calls.js"),
  "helpdesk-tickets": require("../../api/helpdesk-tickets.js"),
  "r2-urls": require("../../api/r2-urls.js"),
  "r2-vanmau": require("../../api/r2-vanmau.js"),
  "r2-table": require("../../api/r2-table.js"),
  "r2-calllog": require("../../api/r2-calllog.js"),
  "device-auth": require("../../api/device-auth.js"),
  "daily-report-stats": require("../../api/daily-report-stats.js")
};

async function runNodeHandler(handler, request, env) {
  const url = new URL(request.url);

  // In Cloudflare Pages, inject env vars into process.env if needed
  if (env) {
    if (typeof process !== "undefined" && process.env) {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string" && !process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  }

  // Parse body
  let bodyBytes = new Uint8Array(0);
  let bodyText = "";
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    const arrayBuf = await request.arrayBuffer();
    bodyBytes = new Uint8Array(arrayBuf);
    bodyText = new TextDecoder().decode(bodyBytes);
  }

  const headers = {};
  for (const [k, v] of request.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }

  const query = {};
  for (const [k, v] of url.searchParams.entries()) {
    query[k] = v;
  }

  let parsedBody = undefined;
  if (bodyBytes.length > 0) {
    try {
      parsedBody = JSON.parse(bodyText);
    } catch (_) {
      parsedBody = bodyText;
    }
  }

  const clientIp = headers["cf-connecting-ip"] || 
                   headers["x-real-ip"] || 
                   (headers["x-forwarded-for"] ? headers["x-forwarded-for"].split(",")[0].trim() : "") || 
                   "127.0.0.1";

  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers: headers,
    query: query,
    body: parsedBody,
    rawBody: bodyText,
    clientIp: clientIp
  };

  let statusCode = 200;
  const resHeaders = new Headers();
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    resHeaders.set(k, v);
  }

  let resBody = "";
  let finished = false;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const res = {
    setHeader(name, val) {
      resHeaders.set(name, String(val));
      return this;
    },
    getHeader(name) {
      return resHeaders.get(name);
    },
    removeHeader(name) {
      resHeaders.delete(name);
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    writeHead(code, headersObj) {
      statusCode = code;
      if (headersObj) {
        for (const [k, v] of Object.entries(headersObj)) {
          resHeaders.set(k, String(v));
        }
      }
      return this;
    },
    json(data) {
      if (!resHeaders.has("Content-Type")) {
        resHeaders.set("Content-Type", "application/json; charset=utf-8");
      }
      resBody = JSON.stringify(data);
      finished = true;
      resolvePromise();
      return this;
    },
    send(data) {
      resBody = typeof data === "object" ? JSON.stringify(data) : String(data || "");
      finished = true;
      resolvePromise();
      return this;
    },
    end(data) {
      if (data !== undefined) {
        resBody = data;
      }
      finished = true;
      resolvePromise();
      return this;
    }
  };

  try {
    const handlerPromise = handler(req, res);
    if (handlerPromise && typeof handlerPromise.then === "function") {
      await handlerPromise;
    }
  } catch (err) {
    if (!finished) {
      statusCode = 500;
      resHeaders.set("Content-Type", "application/json; charset=utf-8");
      resBody = JSON.stringify({ error: err.message, stack: err.stack });
      resolvePromise();
    }
  }

  if (!finished) {
    // If handler finished without explicitly calling json/send/end
    resolvePromise();
  }

  await promise;

  return new Response(request.method === "HEAD" ? null : resBody, {
    status: statusCode,
    headers: resHeaders
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  const routeSegments = params.route || [];
  const routeName = routeSegments[0];

  if (!routeName || !HANDLERS[routeName]) {
    return new Response(JSON.stringify({ error: `Route /api/${routeName || ""} not found` }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  const handler = HANDLERS[routeName];
  return runNodeHandler(handler, request, env);
}

