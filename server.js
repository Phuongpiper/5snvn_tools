const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

try { require("dotenv").config(); } catch(_) {}

const START_PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_DIR = __dirname;

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "";
const R2_OBJECT_KEY        = "system_urls.json";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css",
  ".js":   "text/javascript",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon"
};

// AWS Signature v4
function hmacSha256(key, msg, enc) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest(enc);
}
function sha256hex(msg) {
  return crypto.createHash("sha256").update(msg, "utf8").digest("hex");
}

function buildR2Request(method, body) {
  body = body || "";
  const host      = R2_ACCOUNT_ID + ".r2.cloudflarestorage.com";
  const uriPath   = "/" + R2_BUCKET_NAME + "/" + R2_OBJECT_KEY;
  const now       = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate   = now.toISOString().replace(/[:-]/g, "").replace(/\.\d+/, "");
  const region    = "auto";
  const service   = "s3";

  const payloadHash  = sha256hex(body);
  const contentType  = method === "PUT" ? "application/json" : "";

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
  if (contentType) headers["Content-Type"] = contentType;
  return { host: host, path: uriPath, headers: headers };
}

function r2Fetch(method, body) {
  body = body || "";
  return new Promise(function(resolve, reject) {
    const req_info = buildR2Request(method, body);
    const options = { hostname: req_info.host, path: req_info.path, method: method, headers: req_info.headers };
    const req = https.request(options, function(res) {
      let data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() { resolve({ statusCode: res.statusCode, body: data }); });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

async function handleApiGet(req, res) {
  const parsedUrl = new URL(req.url, "http://localhost");
  const dataParam = parsedUrl.searchParams.get("data");
  if (dataParam) {
    try {
      const payload = JSON.parse(dataParam);
      const systemName = payload.name;
      const url = payload.url;
      if (!systemName || !url) {
        res.writeHead(400, Object.assign({ "Content-Type": "application/json" }, CORS));
        return res.end(JSON.stringify({ status: "error", message: "name and url required" }));
      }
      let current = {};
      const getR = await r2Fetch("GET", "");
      if (getR.statusCode === 200) {
        try { current = JSON.parse(getR.body); } catch(e) {}
      }
      current[systemName] = url;
      const putBody = JSON.stringify(current);
      const putR = await r2Fetch("PUT", putBody);
      if (putR.statusCode >= 200 && putR.statusCode < 300) {
        res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, CORS));
        res.end(JSON.stringify({ status: "success", data: current }));
      } else {
        res.writeHead(502, Object.assign({ "Content-Type": "application/json" }, CORS));
        res.end(JSON.stringify({ status: "error", message: "R2 PUT failed: " + putR.statusCode, detail: putR.body }));
      }
    } catch (err) {
      res.writeHead(500, Object.assign({ "Content-Type": "application/json" }, CORS));
      res.end(JSON.stringify({ status: "error", message: err.message }));
    }
  } else {
    try {
      const r = await r2Fetch("GET", "");
      if (r.statusCode === 404) {
        res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, CORS));
        return res.end("{}");
      }
      if (r.statusCode !== 200) {
        res.writeHead(502, Object.assign({ "Content-Type": "application/json" }, CORS));
        return res.end(JSON.stringify({ error: "R2 GET failed", status: r.statusCode, detail: r.body }));
      }
      res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, CORS));
      res.end(r.body);
    } catch (err) {
      res.writeHead(500, Object.assign({ "Content-Type": "application/json" }, CORS));
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}

function handleApiPost(req, res) {
  let raw = "";
  req.on("data", function(c) { raw += c; });
  req.on("end", async function() {
    try {
      const payload = JSON.parse(raw);
      const systemName = payload.systemName;
      const url = payload.url;
      if (!systemName || !url) {
        res.writeHead(400, Object.assign({ "Content-Type": "application/json" }, CORS));
        return res.end(JSON.stringify({ status: "error", message: "systemName and url required" }));
      }
      let current = {};
      const getR = await r2Fetch("GET", "");
      if (getR.statusCode === 200) {
        try { current = JSON.parse(getR.body); } catch(e) {}
      }
      current[systemName] = url;
      const putBody = JSON.stringify(current);
      const putR = await r2Fetch("PUT", putBody);
      if (putR.statusCode >= 200 && putR.statusCode < 300) {
        res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, CORS));
        res.end(JSON.stringify({ status: "success", data: current }));
      } else {
        res.writeHead(502, Object.assign({ "Content-Type": "application/json" }, CORS));
        res.end(JSON.stringify({ status: "error", message: "R2 PUT failed: " + putR.statusCode, detail: putR.body }));
      }
    } catch (err) {
      res.writeHead(500, Object.assign({ "Content-Type": "application/json" }, CORS));
      res.end(JSON.stringify({ status: "error", message: err.message }));
    }
  });
}

const server = http.createServer(function(req, res) {
  const parsedUrl = new URL(req.url, "http://localhost");
  const pathname  = parsedUrl.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (pathname === "/api/r2-urls") {
    if (req.method === "GET")  return handleApiGet(req, res);
    if (req.method === "POST") return handleApiPost(req, res);
    res.writeHead(405);
    return res.end("Method Not Allowed");
  }

  if (pathname === "/api/r2-table") {
    let body = "";
    req.on("data", function(chunk) { body += chunk; });
    req.on("end", async function() {
      try {
        if (body) {
          try { req.body = JSON.parse(body); } catch(_) { req.body = body; }
        }
        res.status = function(code) { res.statusCode = code; return this; };
        res.json = function(data) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(data));
          return this;
        };
        res.send = function(data) {
          res.end(typeof data === "string" ? data : JSON.stringify(data));
          return this;
        };
        const handler = require("./api/r2-table.js");
        await handler(req, res);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
    });
    return;
  }

  if (pathname === "/api/r2-tasks") {
    let body = "";
    req.on("data", function(chunk) { body += chunk; });
    req.on("end", async function() {
      try {
        if (body) {
          try { req.body = JSON.parse(body); } catch(_) { req.body = body; }
        }
        res.status = function(code) { res.statusCode = code; return this; };
        res.json = function(data) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(data));
          return this;
        };
        const handler = require("./api/r2-tasks.js");
        await handler(req, res);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
    });
    return;
  }

  if (pathname === "/api/r2-dt") {
    let body = "";
    req.on("data", function(chunk) { body += chunk; });
    req.on("end", async function() {
      try {
        if (body) {
          try { req.body = JSON.parse(body); } catch(_) { req.body = body; }
        }
        res.status = function(code) { res.statusCode = code; return this; };
        res.json = function(data) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(data));
          return this;
        };
        res.send = function(data) {
          res.end(typeof data === "string" ? data : JSON.stringify(data));
          return this;
        };
        const handler = require("./api/r2-dt.js");
        await handler(req, res);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
    });
    return;
  }

  const safeSuffix = path.normalize(pathname).replace(/^(\.\.[\\/])+/, "");
  let filePath = path.join(PUBLIC_DIR, safeSuffix);

  fs.stat(filePath, function(err, stats) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }
    if (stats.isDirectory()) filePath = path.join(filePath, "index.html");
    fs.readFile(filePath, function(err, data) {
      if (err) {
        if (err.code === "ENOENT") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("404 Not Found");
        } else {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("500 Internal Server Error: " + err.code);
        }
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
  });
});

function startServer(port) { server.listen(port); }

server.once("listening", function() {
  const addr = server.address();
  console.log("Server is running at http://localhost:" + addr.port);
  console.log("Press Ctrl+C to stop.");
});

server.on("error", function(err) {
  if (err.code === "EADDRINUSE") {
    console.log("Port " + err.port + " is in use. Trying " + (err.port + 1) + "...");
    startServer(err.port + 1);
  } else {
    console.error("Server error:", err);
  }
});

startServer(START_PORT);
