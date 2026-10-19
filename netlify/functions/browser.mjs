import browserHandler from "../../api/browser.js";

function jsonError(status, error, detail) {
  return new Response(JSON.stringify({ ok: false, error, detail }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type,apikey",
      "access-control-allow-methods": "POST,OPTIONS",
    },
  });
}

export default async function handler(request) {
  const headers = Object.fromEntries(request.headers.entries());
  let body = null;

  if (request.method === "POST") {
    const length = Number(headers["content-length"] || 0);
    if (length > 256 * 1024) {
      return jsonError(413, "REQUEST_TOO_LARGE", "The browser request exceeds 256 KB.");
    }
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "INVALID_JSON", "Send a JSON request body.");
    }
  }

  const req = { method: request.method, headers, body };
  let statusCode = 200;
  const responseHeaders = {};
  let responseBody = "";

  const res = {
    status(code) { statusCode = code; return this; },
    setHeader(name, value) { responseHeaders[name] = value; return this; },
    json(value) {
      responseHeaders["Content-Type"] ||= "application/json; charset=utf-8";
      responseBody = JSON.stringify(value);
      return this;
    },
    end(value = "") { responseBody = value; return this; },
  };

  try {
    await browserHandler(req, res);
    return new Response(responseBody, { status: statusCode, headers: responseHeaders });
  } catch {
    return jsonError(500, "CHROMIUM_FUNCTION_FAILED", "The isolated Chromium request failed. Check Netlify function logs.");
  }
}
