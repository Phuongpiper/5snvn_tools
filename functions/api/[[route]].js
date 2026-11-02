// functions/api/[[route]].js - Universal API Router for Cloudflare Pages Functions
// Supports both direct Cloudflare R2 bindings and Node S3/HMAC handlers

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
  "r2-calllog": require("../../api/r2-calllog.js")
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
  let bodyBuffer = Buffer.alloc(0);
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    const arrayBuf = await request.arrayBuffer();
    bodyBuffer = Buffer.from(arrayBuf);
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
  if (bodyBuffer.length > 0) {
    try {
      parsedBody = JSON.parse(bodyBuffer.toString("utf8"));
    } catch (_) {
      parsedBody = bodyBuffer.toString("utf8");
    }
  }

  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers: headers,
    query: query,
    body: parsedBody,
    rawBody: bodyBuffer
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

