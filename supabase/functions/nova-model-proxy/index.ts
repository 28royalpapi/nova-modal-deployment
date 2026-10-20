import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const H = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-nova-worker-token,x-nova-worker-task-id,x-nova-user-id",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const out = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: H });
const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
async function sha256(s: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}
function constantTimeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
function bearerToken(req: Request) {
  const match = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}
async function readJsonLimited(req: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("REQUEST_TOO_LARGE");
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(joined));
  } catch {
    return null;
  }
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

function safeMessageList(value: unknown, workerMode: boolean): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 80) return false;
  return value.every((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const m = raw as Record<string, unknown>;
    if (!["system", "developer", "user", "assistant", "tool"].includes(String(m.role))) return false;
    const content = m.content;
    if (typeof content === "string") {
      if (content.length > 50000) return false;
    } else if (content === null) {
      if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length < 1) return false;
    } else if (Array.isArray(content)) {
      if (content.length > 48) return false;
      for (const part of content) {
        if (!part || typeof part !== "object" || Array.isArray(part)) return false;
        const p = part as Record<string, unknown>;
        if (p.type === "text") {
          if (typeof p.text !== "string" || p.text.length > 50000) return false;
        } else if (p.type === "image_url" && !workerMode) {
          const image = p.image_url;
          if (!image || typeof image !== "object" || Array.isArray(image)) return false;
          const url = (image as Record<string, unknown>).url;
          if (typeof url !== "string" || url.length > 60000 ||
              !(url.startsWith("https://") || url.startsWith("http://") || url.startsWith("data:image/"))) return false;
        } else {
          // Browser workers intentionally use DOM/text mode; no screenshot payloads.
          return false;
        }
      }
    } else {
      return false;
    }
    if (m.name !== undefined && (typeof m.name !== "string" || m.name.length > 120 ||
        !/^[a-zA-Z0-9_-]+$/.test(m.name))) return false;
    if (m.role === "tool" && (typeof m.tool_call_id !== "string" ||
        m.tool_call_id.length < 1 || m.tool_call_id.length > 200)) return false;
    if (m.tool_call_id !== undefined && (typeof m.tool_call_id !== "string" || m.tool_call_id.length > 200)) return false;
    if (m.tool_calls !== undefined) {
      if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length > 32) return false;
      for (const call of m.tool_calls) {
        if (!call || typeof call !== "object" || Array.isArray(call)) return false;
        const t = call as Record<string, unknown>;
        if (t.type !== "function" || typeof t.id !== "string" || t.id.length > 200 ||
            !t.function || typeof t.function !== "object" || Array.isArray(t.function)) return false;
        const fn = t.function as Record<string, unknown>;
        if (typeof fn.name !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(fn.name) ||
            typeof fn.arguments !== "string" || fn.arguments.length > 20000) return false;
      }
    }
    return true;
  });
}

function normalizeMessages(value: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return value.map((raw) => {
    const m: Record<string, unknown> = { role: mRole(raw.role) };
    if (typeof raw.content === "string" || raw.content === null) {
      m.content = raw.content;
    } else if (Array.isArray(raw.content)) {
      m.content = raw.content.map((part) => {
        const p = part as Record<string, unknown>;
        if (p.type === "text") return { type: "text", text: p.text };
        const image = p.image_url as Record<string, unknown>;
        return { type: "image_url", image_url: { url: image.url, ...(image.detail === "low" || image.detail === "high" || image.detail === "auto" ? { detail: image.detail } : {}) } };
      });
    }
    if (typeof raw.name === "string") m.name = raw.name;
    if (typeof raw.tool_call_id === "string") m.tool_call_id = raw.tool_call_id;
    if (Array.isArray(raw.tool_calls)) m.tool_calls = raw.tool_calls;
    return m;
  });
}
function mRole(value: unknown): string {
  return String(value);
}

function safeTools(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > 32) return false;
  return value.every((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const t = tool as Record<string, unknown>;
    if (t.type !== "function" || !t.function || typeof t.function !== "object" || Array.isArray(t.function)) return false;
    const fn = t.function as Record<string, unknown>;
    return typeof fn.name === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(fn.name) &&
      (fn.description === undefined || (typeof fn.description === "string" && fn.description.length <= 4000)) &&
      (fn.parameters === undefined || (typeof fn.parameters === "object" && fn.parameters !== null && !Array.isArray(fn.parameters)));
  });
}
function safeToolChoice(value: unknown) {
  if (value === undefined || value === "auto" || value === "none" || value === "required") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const fn = v.function as Record<string, unknown> | undefined;
  return v.type === "function" && !!fn && typeof fn.name === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(fn.name);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return out({ error: "METHOD_NOT_ALLOWED" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return out({ error: "CONFIGURATION_MISSING" }, 503);

  const token = bearerToken(req);
  const workerToken = req.headers.get("x-nova-worker-token") || "";
  const taskId = (req.headers.get("x-nova-worker-task-id") || "").trim();
  const claimedUserId = (req.headers.get("x-nova-user-id") || "").trim();
  const workerMode = Boolean(workerToken || taskId || claimedUserId);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let userId = "";
  if (workerMode) {
    // The task worker uses a one-task bearer token. Disable gateway JWT verification for
    // this function only; this branch independently validates the hashed token, task owner,
    // and running state before granting any model access.
    if (!token || token !== workerToken || !/^[a-f0-9]{64}$/i.test(workerToken) ||
        !isUuid(taskId) || !isUuid(claimedUserId)) {
      return out({ error: "WORKER_AUTH_INVALID" }, 401);
    }
    const { data: task, error } = await admin
      .from("nova_linux_task_runs")
      .select("id,user_id,status,worker_token_hash")
      .eq("id", taskId)
      .maybeSingle();
    if (error) return out({ error: "WORKER_AUTH_CHECK_FAILED" }, 503);
    const suppliedHash = await sha256(workerToken);
    if (!task || task.user_id !== claimedUserId || task.status !== "running" ||
        !task.worker_token_hash || !constantTimeEqual(suppliedHash, String(task.worker_token_hash))) {
      return out({ error: "WORKER_TASK_NOT_AUTHORIZED" }, 401);
    }
    userId = task.user_id;
  } else {
    if (!token) return out({ error: "AUTH_REQUIRED" }, 401);
    if (!anon) return out({ error: "CONFIGURATION_MISSING" }, 503);
    const userClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: who, error } = await userClient.auth.getUser(token);
    if (error || !who.user) return out({ error: "AUTH_INVALID" }, 401);
    userId = who.user.id;
  }

  let body: Record<string, unknown> | null;
  try {
    body = await readJsonLimited(req, workerMode ? 180_000 : 80_000);
  } catch (e) {
    if (e instanceof Error && e.message === "REQUEST_TOO_LARGE") return out({ error: "REQUEST_TOO_LARGE" }, 413);
    return out({ error: "INVALID_BODY" }, 400);
  }
  if (!body) return out({ error: "INVALID_BODY" }, 400);
  if (body.action === "health") {
    return out({
      ok: true,
      service: "nova-model-proxy",
      providers: {
        openai_api: Boolean(Deno.env.get("OPENAI_API_KEY")),
        lovable_managed_ai: Boolean(Deno.env.get("LOVABLE_API_KEY")),
        openrouter_free: Boolean(Deno.env.get("OPENROUTER_API_KEY")),
        gemini_api: Boolean(Deno.env.get("GEMINI_API_KEY")),
      },
      worker_mode: workerMode,
    });
  }

  const configuredLovableModel = (Deno.env.get("NOVA_LOVABLE_CHAT_MODEL") || "google/gemini-3.8-flash").trim();
  const configuredGeminiModel = (Deno.env.get("NOVA_GEMINI_CHAT_MODEL") || "gemini-3.8-flash").trim();
  const configuredOpenAIModel = (Deno.env.get("NOVA_OPENAI_CHAT_MODEL") || "gpt-5-mini").trim();
  let storedPreference: { provider_id?: string; model_id?: string } | null = null;
  if (workerMode) {
    const { data: pref, error: preferenceError } = await admin
      .from("nova_model_preferences").select("provider_id,model_id").eq("user_id", userId).maybeSingle();
    if (preferenceError) return out({ error: "WORKER_MODEL_PREFERENCE_LOOKUP_FAILED" }, 503);
    storedPreference = pref || null;
  }
  // Prefer the free-model route automatically when its server-side key exists.
  // Never silently fall back from a user's free choice to a billed provider.
  const defaultProvider = Deno.env.get("GEMINI_API_KEY")?.trim()
    ? "gemini-api"
    : Deno.env.get("OPENROUTER_API_KEY")?.trim()
      ? "openrouter-free"
      : Deno.env.get("OPENAI_API_KEY")?.trim()
        ? "openai-api"
        : "lovable-managed-ai";
  const provider = workerMode
    ? (typeof storedPreference?.provider_id === "string" ? storedPreference.provider_id : defaultProvider)
    : (typeof body.provider_id === "string" && body.provider_id.trim() ? body.provider_id.trim() : defaultProvider);
  if (!["gemini-api", "openai-api", "lovable-managed-ai", "openrouter-free"].includes(provider)) {
    return out({
      error: workerMode ? "WORKER_PROVIDER_NOT_SUPPORTED" : "PROVIDER_NOT_SUPPORTED",
      provider,
      detail: workerMode
        ? "This remote browser worker only supports server-configured hosted providers. A user-local model must execute on that user's own device."
        : "This provider has no verified API adapter in this request path.",
    }, 409);
  }
  const requestedModel = workerMode
    ? (typeof storedPreference?.model_id === "string" ? storedPreference.model_id.trim() : "")
    : (typeof body.model_id === "string" ? body.model_id.trim() : "");
  const freeModelId = requestedModel === "openrouter/free" ||
    /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+:free$/.test(requestedModel);
  if (provider === "openrouter-free" && requestedModel && !freeModelId) {
    return out({ error: "MODEL_NOT_ALLOWED", detail: "Only OpenRouter's free router or model IDs tagged :free are accepted." }, 409);
  }
  if (provider === "lovable-managed-ai" && workerMode && requestedModel && requestedModel !== configuredLovableModel) {
    return out({ error: "MANAGED_MODEL_LOCKED", configured_model: configuredLovableModel }, 409);
  }
  if (provider === "gemini-api" && requestedModel && requestedModel !== configuredGeminiModel) {
    return out({ error: "MODEL_NOT_ALLOWED", configured_model: configuredGeminiModel }, 409);
  }
  if (provider === "openai-api" && requestedModel && requestedModel !== configuredOpenAIModel) {
    return out({ error: "MODEL_NOT_ALLOWED", configured_model: configuredOpenAIModel }, 409);
  }
  const model = provider === "gemini-api" ? configuredGeminiModel
    : provider === "openrouter-free" ? (requestedModel || "openrouter/free")
    : provider === "openai-api" ? configuredOpenAIModel : configuredLovableModel;
  const messages = body.messages;
  if (!safeMessageList(messages, workerMode)) return out({ error: "MESSAGES_INVALID" }, 400);
  const messageBytes = new TextEncoder().encode(JSON.stringify(messages)).length;
  if (messageBytes > (workerMode ? 140_000 : 48_000)) return out({ error: "REQUEST_TOO_LARGE" }, 413);
  const normalizedMessages = normalizeMessages(messages);

  const toolsValue = body.tools;
  if (toolsValue !== undefined && (!safeTools(toolsValue) ||
      new TextEncoder().encode(JSON.stringify(toolsValue)).length > 32_000)) {
    return out({ error: "TOOLS_INVALID" }, 400);
  }
  if (!safeToolChoice(body.tool_choice)) return out({ error: "TOOL_CHOICE_INVALID" }, 400);
  if (body.response_format !== undefined &&
      (!body.response_format || typeof body.response_format !== "object" || Array.isArray(body.response_format))) {
    return out({ error: "RESPONSE_FORMAT_INVALID" }, 400);
  }

  const key = (
    provider === "gemini-api" ? Deno.env.get("GEMINI_API_KEY") :
    provider === "openrouter-free" ? Deno.env.get("OPENROUTER_API_KEY") :
    provider === "openai-api" ? Deno.env.get("OPENAI_API_KEY") :
    Deno.env.get("LOVABLE_API_KEY")
  )?.trim();
  if (!key) return out({
    error: provider === "gemini-api" ? "GEMINI_API_KEY_NOT_CONFIGURED" :
      provider === "openrouter-free" ? "OPENROUTER_NOT_CONFIGURED" :
      provider === "openai-api" ? "OPENAI_API_KEY_NOT_CONFIGURED" : "LOVABLE_AI_NOT_CONFIGURED",
    required_secret: provider === "gemini-api" ? "GEMINI_API_KEY" : provider === "openai-api" ? "OPENAI_API_KEY" : undefined,
    no_inference_submitted: true,
  }, 503);

  // Apply quota checks in the proxy itself so direct function calls cannot bypass
  // the same limits enforced for interactive chat and background browser jobs.
  if (workerMode) {
    const agentQuotaResult = await admin.rpc("nova_consume_agent_model_quota", { p_user_id: userId, p_source: "background" });
    if (agentQuotaResult.error) return out({ error: "AGENT_MODEL_QUOTA_CHECK_FAILED" }, 503);
    if (agentQuotaResult.data?.allowed !== true) return out({ error: "AGENT_MODEL_QUOTA_EXHAUSTED", quota: agentQuotaResult.data || null }, 429);
  }
  const quotaResult = await admin.rpc("nova_consume_model_quota_for_user", { p_user_id: userId, p_provider: provider });
  if (quotaResult.error) return out({ error: "MODEL_QUOTA_CHECK_FAILED" }, 503);
  const quota = quotaResult.data as Record<string, unknown> | null;
  if (!quota || quota.allowed !== true) {
    return out({ error: "MODEL_QUOTA_EXHAUSTED", quota: quota || null }, 429);
  }

  const readLimit = (name: string, fallback: number) => {
    const raw = Deno.env.get(name)?.trim();
    if (!raw) return fallback;
    if (!/^\d{1,7}$/.test(raw)) return NaN;
    return Number(raw);
  };
  const quotaPrefix = provider === "gemini-api" ? "NOVA_GEMINI_API"
    : provider === "openrouter-free" ? "NOVA_OPENROUTER_FREE"
    : provider === "openai-api" ? "NOVA_OPENAI_API" : "NOVA_LOVABLE";
  const globalLimit = readLimit(quotaPrefix + "_DAILY_GLOBAL_LIMIT", 1000);
  const sourceLimit = readLimit(
    quotaPrefix + (workerMode ? "_DAILY_BACKGROUND_LIMIT" : "_DAILY_CHAT_LIMIT"),
    Math.min(workerMode ? 200 : 800, globalLimit),
  );
  if (!Number.isSafeInteger(globalLimit) || globalLimit < 1 || globalLimit > 1000000 ||
      !Number.isSafeInteger(sourceLimit) || sourceLimit < 1 || sourceLimit > globalLimit) {
    return out({ error: "MODEL_QUOTA_CONFIGURATION_INVALID" }, 503);
  }
  const globalQuotaResult = await admin.rpc("nova_consume_managed_ai_quota", {
    p_provider_id: provider,
    p_source: workerMode ? "background" : "chat",
    p_source_limit: sourceLimit,
    p_daily_global_limit: globalLimit,
  });
  if (globalQuotaResult.error) return out({ error: "MANAGED_AI_GLOBAL_QUOTA_CHECK_FAILED" }, 503);
  if (globalQuotaResult.data?.allowed !== true) {
    return out({ error: "MANAGED_AI_DAILY_LIMIT_EXHAUSTED", quota: globalQuotaResult.data || null }, 429);
  }

  const payload: Record<string, unknown> = { model, messages: normalizedMessages, stream: false };
  if (toolsValue !== undefined) payload.tools = toolsValue;
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;
  if (body.response_format !== undefined) payload.response_format = body.response_format;
  if (typeof body.parallel_tool_calls === "boolean") payload.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.temperature === "number" && Number.isFinite(body.temperature)) {
    if (body.temperature < 0 || body.temperature > 2) return out({ error: "TEMPERATURE_INVALID" }, 400);
    payload.temperature = body.temperature;
  }
  if (typeof body.max_tokens === "number" && Number.isInteger(body.max_tokens)) {
    if (body.max_tokens < 1 || body.max_tokens > 8192) return out({ error: "MAX_TOKENS_INVALID" }, 400);
    payload.max_tokens = body.max_tokens;
  }
  if (typeof body.top_p === "number" && Number.isFinite(body.top_p)) {
    if (body.top_p < 0 || body.top_p > 1) return out({ error: "TOP_P_INVALID" }, 400);
    payload.top_p = body.top_p;
  }
  if (typeof body.stop === "string" || Array.isArray(body.stop)) payload.stop = body.stop;

  let response: Response;
  try {
    response = await fetch(
      provider === "gemini-api"
        ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        : provider === "openrouter-free"
          ? "https://openrouter.ai/api/v1/chat/completions"
          : provider === "openai-api"
            ? "https://api.openai.com/v1/chat/completions"
            : "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: provider === "openrouter-free"
          ? { Authorization: "Bearer " + key, "Content-Type": "application/json", "X-Title": "NOVA" }
          : { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45_000),
      },
    );
  } catch {
    return out({ error: "AI_PROVIDER_UNREACHABLE" }, 502);
  }
  const raw = await response.text();
  if (!response.ok) {
    return out({
      error: response.status === 402 ? "AI_CREDITS_EXHAUSTED" :
        response.status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_FAILED",
      status: response.status,
    }, response.status === 402 ? 402 : response.status === 429 ? 429 : 502);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out({ error: "AI_RESPONSE_INVALID" }, 502);
  }
  if (!parsed?.choices?.[0]?.message) return out({ error: "AI_RESPONSE_MISSING_MESSAGE" }, 502);

  // Keep a standard OpenAI ChatCompletion envelope for the Browser Use / LangChain client.
  return out({
    id: typeof parsed.id === "string" ? parsed.id : "nova-" + crypto.randomUUID(),
    object: typeof parsed.object === "string" ? parsed.object : "chat.completion",
    created: typeof parsed.created === "number" ? parsed.created : Math.floor(Date.now() / 1000),
    model: parsed.model || model,
    provider,
    ok: true,
    choices: parsed.choices,
    usage: parsed.usage || null,
  });
});