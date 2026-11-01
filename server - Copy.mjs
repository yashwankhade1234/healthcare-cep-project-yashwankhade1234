import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(projectRoot, ".env");
const contentPath = path.join(projectRoot, "content.json");

if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, "utf8");
    for (const line of envFile.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
    }
}

const port = Number(process.env.PORT || 4173);
const aiProvider = (process.env.AI_PROVIDER || (process.env.GROQ_API_KEY ? "groq" : "openai")).toLowerCase();
const model = process.env.AI_MODEL || (aiProvider === "groq" ? "openai/gpt-oss-20b" : "gpt-6-luna");
const languageNames = { en: "English", mr: "Marathi", hi: "Hindi" };
const requestCounts = new Map();
const adminSessions = new Map();
const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
};

function sendJson(response, status, data) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(data));
}

function isRateLimited(request) {
    const now = Date.now();
    const address = request.socket.remoteAddress || "local";
    const window = requestCounts.get(address);
    if (!window || now - window.startedAt >= 60_000) {
        requestCounts.set(address, { startedAt: now, count: 1 });
        return false;
    }
    window.count += 1;
    return window.count > 30;
}

async function readJson(request, maxBytes = 64_000) {
    const chunks = [];
    let size = 0;

    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("request_too_large");
        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new Error("invalid_json");
    }
}

function readCookie(request, name) {
    const cookieHeader = request.headers.cookie || "";
    const pair = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
    return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
}

function hasAdminSession(request) {
    const token = readCookie(request, "hc_admin");
    const expiresAt = adminSessions.get(token);
    if (!token || !expiresAt || expiresAt < Date.now()) {
        adminSessions.delete(token);
        return false;
    }
    return true;
}

function constantTimeMatch(candidate, expected) {
    const candidateHash = crypto.createHash("sha256").update(candidate).digest();
    const expectedHash = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(candidateHash, expectedHash);
}

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateHttpsUrl(value, video = false) {
    if (value === "") return true;
    if (typeof value !== "string" || value.length > 2048) return false;
    if (!video && /^(?:[a-z0-9-]+\.html)(?:#[a-z0-9-]+)?$/i.test(value)) return true;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:") return false;
        if (!video) return true;
        const hosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"];
        const pathMatch = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/);
        const videoId = url.hostname === "youtu.be" ? url.pathname.slice(1).split("/")[0] : pathMatch?.[1] || url.searchParams.get("v");
        return hosts.includes(url.hostname) && /^[A-Za-z0-9_-]{6,20}$/.test(videoId || "");
    } catch {
        return false;
    }
}

function sanitizeContentGroup(value) {
    if (!isRecord(value) || Object.keys(value).length > 24) return null;
    const safe = {};
    for (const [id, item] of Object.entries(value)) {
        if (!/^[a-z0-9-]{1,80}$/.test(id) || !isRecord(item)) return null;
        if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 160) return null;
        if (typeof (item.summary ?? "") !== "string" || (item.summary ?? "").length > 700) return null;
        if (typeof (item.related ?? "") !== "string" || (item.related ?? "").length > 1800) return null;
        if (!Array.isArray(item.steps ?? []) || (item.steps ?? []).length > 40 || (item.steps ?? []).some((step) => typeof step !== "string" || step.length > 500)) return null;
        if (!validateHttpsUrl(item.source ?? "")) return null;
        const videos = item.videos ?? {};
        if (!isRecord(videos) || ["en", "mr", "hi"].some((language) => !validateHttpsUrl(videos[language] ?? "", true))) return null;
        safe[id] = {
            title: item.title.trim(),
            summary: item.summary ?? "",
            related: item.related ?? "",
            steps: item.steps ?? [],
            source: item.source ?? "",
            videos: { en: videos.en ?? "", mr: videos.mr ?? "", hi: videos.hi ?? "" },
        };
    }
    return safe;
}

async function handleContentGet(response) {
    try {
        const content = JSON.parse(await fs.promises.readFile(contentPath, "utf8"));
        return sendJson(response, 200, { content });
    } catch (error) {
        if (error.code === "ENOENT") return sendJson(response, 200, { content: { learning: {}, hygiene: {} } });
        return sendJson(response, 500, { error: "Saved content could not be loaded." });
    }
}

async function handleAdminLogin(request, response) {
    const password = process.env.ADMIN_PASSWORD || "";
    if (!password) return sendJson(response, 503, { error: "Admin access is not configured yet. Add ADMIN_PASSWORD to the server .env file." });
    let body;
    try { body = await readJson(request); } catch { return sendJson(response, 400, { error: "Send a valid password." }); }
    if (typeof body.password !== "string" || !constantTimeMatch(body.password, password)) {
        return sendJson(response, 401, { error: "The password did not match." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
    response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": `hc_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify({ ok: true }));
}

async function handleAdminSave(request, response) {
    if (!hasAdminSession(request)) return sendJson(response, 401, { error: "Log in to save website content." });
    let body;
    try { body = await readJson(request, 2_000_000); } catch { return sendJson(response, 400, { error: "The content could not be read." }); }
    if (!isRecord(body.content) || !isRecord(body.content.learning) || !isRecord(body.content.hygiene)) {
        return sendJson(response, 400, { error: "The content format is not valid." });
    }
    const learning = sanitizeContentGroup(body.content.learning);
    const hygiene = sanitizeContentGroup(body.content.hygiene);
    if (!learning || !hygiene) return sendJson(response, 400, { error: "Check each title, guide step, source, and YouTube video link. Video links must use HTTPS." });
    const serialized = JSON.stringify({ learning, hygiene }, null, 2);
    if (serialized.length > 1_800_000) return sendJson(response, 413, { error: "Saved content is too large." });
    const temporaryPath = `${contentPath}.tmp`;
    try {
        await fs.promises.writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
        await fs.promises.rename(temporaryPath, contentPath);
        return sendJson(response, 200, { ok: true });
    } catch {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        return sendJson(response, 500, { error: "Changes could not be saved." });
    }
}

function handleAdminLogout(request, response) {
    const token = readCookie(request, "hc_admin");
    adminSessions.delete(token);
    response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": "hc_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify({ ok: true }));
}

function getOutputText(data) {
    if (typeof data.output_text === "string") return data.output_text.trim();
    return (data.output || [])
        .flatMap((item) => item.content || [])
        .filter((item) => item.type === "output_text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim();
}

async function callOpenAI({ instructions, input, maxOutputTokens, modelOverride, retryRateLimit = true }) {
    const useGroq = aiProvider === "groq";
    const useGroqChat = useGroq && Boolean(modelOverride);
    const apiKey = useGroq ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("ai_not_configured");

    const endpoint = useGroqChat
        ? "https://api.groq.com/openai/v1/chat/completions"
        : useGroq
            ? "https://api.groq.com/openai/v1/responses"
            : "https://api.openai.com/v1/responses";
    const requestBody = useGroqChat
        ? {
            model: modelOverride,
            messages: [{ role: "system", content: instructions }, ...input],
            max_completion_tokens: maxOutputTokens,
            temperature: 0.1,
        }
        : {
            model: modelOverride || model,
            instructions,
            input,
            max_output_tokens: maxOutputTokens,
            store: false,
        };
    let upstream;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        upstream = await fetch(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(45_000),
        });

        if (upstream.status !== 429 || attempt === 2 || !retryRateLimit) break;
        const retryAfter = Number(upstream.headers.get("retry-after"));
        const retryMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 30_000)
            : 3_000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, retryMs));
    }

    if (!upstream.ok) throw new Error(`upstream_${upstream.status}`);

    const data = await upstream.json();
    const text = useGroqChat
        ? data.choices?.[0]?.message?.content?.trim()
        : getOutputText(data);
    if (!text) throw new Error("empty_response");
    return text;
}

async function handleChat(request, response) {
    let body;
    try {
        body = await readJson(request);
    } catch (error) {
        return sendJson(response, error.message === "request_too_large" ? 413 : 400, {
            error: error.message === "request_too_large" ? "The request is too large." : "Send valid JSON.",
        });
    }

    const language = languageNames[body.language] ? body.language : "en";
    const messages = Array.isArray(body.messages) ? body.messages.slice(-10) : [];
    if (!messages.length || messages.some((message) =>
        !message || !["user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" || !message.content.trim() || message.content.length > 3000
    )) {
        return sendJson(response, 400, { error: "Send up to 10 valid conversation messages." });
    }

    const instructions = [
        "You are the HealthCare+ health-awareness assistant for the general public in India.",
        `Reply in ${languageNames[language]}. Keep using that language throughout the conversation unless the user asks to switch.`,
        "Be warm, respectful, conversational, and practical. Use plain language suitable for the general public in India.",
        "Answer the question directly, then give a short explanation and clear next steps when useful. Use headings or numbered steps for longer answers, and ask at most one focused follow-up question when needed.",
        "Use the prior conversation to understand follow-up questions. If a user refers to earlier advice, respond in context and correct misunderstandings clearly.",
        "Share general health education only. Do not diagnose, prescribe or recommend a specific medicine dose, or claim to replace a qualified clinician.",
        "For severe, sudden, or life-threatening symptoms, clearly advise urgent professional care or local emergency services before general information.",
        "If you are unsure, say so and recommend a qualified healthcare professional or a reliable official health source. Never invent local services, emergency numbers, or medical facts.",
    ].join(" ");

    try {
        const answer = await callOpenAI({ instructions, input: messages, maxOutputTokens: 700 });
        return sendJson(response, 200, { answer, mode: "live" });
    } catch (error) {
        if (error.message === "ai_not_configured") {
            return sendJson(response, 503, { error: "Live AI is not configured. The website can use its local demo replies." });
        }
        console.error("Health assistant request failed:", error.message);
        return sendJson(response, 502, { error: "The live AI service is temporarily unavailable." });
    }
}

async function handleTranslate(request, response) {
    let body;
    try {
        body = await readJson(request);
    } catch (error) {
        return sendJson(response, error.message === "request_too_large" ? 413 : 400, {
            error: error.message === "request_too_large" ? "The translation batch is too large." : "Send valid JSON.",
        });
    }

    const language = body.language;
    const texts = body.texts;
    if (!languageNames[language] || !Array.isArray(texts) || texts.length < 1 || texts.length > 80 ||
        texts.some((text) => typeof text !== "string" || text.length > 1200) ||
        texts.reduce((total, text) => total + text.length, 0) > 18_000) {
        return sendJson(response, 400, { error: "Send up to 80 short text items for English, Marathi, or Hindi." });
    }

    const instructions = [
        `Translate each item into ${languageNames[language]}.`,
        "Return only a valid JSON array of strings, with exactly one translation per input item and in the same order.",
        "Preserve names, numbers, emergency phone numbers, punctuation, and the original health meaning.",
        "Use natural, clear language for the general public. Do not add advice or explanations.",
    ].join(" ");

    try {
        const inputChars = texts.reduce((total, text) => total + text.length, 0);
        const translationBudget = Math.max(1_600, Math.min(2_200, Math.ceil(inputChars * 0.95)));
        const result = await callOpenAI({
            instructions,
            input: [{ role: "user", content: JSON.stringify(texts) }],
            maxOutputTokens: translationBudget,
            retryRateLimit: false,
        });
        const jsonText = result.trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "");
        const parsed = JSON.parse(jsonText);
        const candidate = Array.isArray(parsed) ? parsed : parsed?.translations || parsed?.items;
        const translations = Array.isArray(candidate)
            ? candidate.map((item) => typeof item === "string" ? item : item?.translation || item?.translated || item?.text)
            : candidate;
        if (!Array.isArray(translations) || translations.length !== texts.length ||
            translations.some((translation) => typeof translation !== "string" || !translation.trim())) {
            throw new Error("invalid_translation_shape");
        }
        return sendJson(response, 200, { translations });
    } catch (error) {
        if (error.message === "ai_not_configured") {
            return sendJson(response, 503, { error: "Full-page translation requires the optional AI service configuration." });
        }
        if (error.message === "upstream_429") {
            response.setHeader("Retry-After", "60");
            return sendJson(response, 429, { error: "The translation service is rate-limited. Wait for the AI provider quota to reset, then try again." });
        }
        console.error("Page translation failed:", error.message);
        return sendJson(response, 502, { error: "The translation service is temporarily unavailable." });
    }
}

async function serveStatic(request, response, pathname) {
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
        response.writeHead(400);
        return response.end("Bad request");
    }
    const filePath = path.resolve(projectRoot, `.${decodedPath}`);
    if (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}${path.sep}`)) {
        response.writeHead(403);
        return response.end("Forbidden");
    }

    const relativePath = path.relative(projectRoot, filePath);
    const pathParts = relativePath.split(path.sep);
    const extension = path.extname(filePath).toLowerCase();
    const allowedExtensions = new Set([
        ".html", ".css", ".js", ".ico", ".png", ".svg", ".jpg", ".jpeg", ".webp", ".gif", ".woff", ".woff2",
    ]);
    if (pathParts.some((part) => part.startsWith(".")) || !allowedExtensions.has(extension)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return response.end("Page not found");
    }

    try {
        const data = await fs.promises.readFile(filePath);
        response.writeHead(200, {
            "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
            "Content-Length": data.length,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
        });
        response.end(request.method === "HEAD" ? undefined : data);
    } catch {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Page not found");
    }
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/api/content" && request.method === "GET") return handleContentGet(response);
    if (url.pathname === "/api/admin/login" && request.method === "POST") {
        if (isRateLimited(request)) return sendJson(response, 429, { error: "Please wait before trying again." });
        return handleAdminLogin(request, response);
    }
    if (url.pathname === "/api/admin/content" && request.method === "PUT") {
        if (isRateLimited(request)) return sendJson(response, 429, { error: "Please wait before saving again." });
        return handleAdminSave(request, response);
    }
    if (url.pathname === "/api/admin/logout" && request.method === "POST") return handleAdminLogout(request, response);
    if (url.pathname.startsWith("/api/") && ["POST", "PUT"].includes(request.method)) {
        if (isRateLimited(request)) return sendJson(response, 429, { error: "Please wait before sending another request." });
        if (url.pathname === "/api/chat") return handleChat(request, response);
        if (url.pathname === "/api/translate") return handleTranslate(request, response);
        return sendJson(response, 404, { error: "API route not found." });
    }
    if (url.pathname.startsWith("/api/")) return sendJson(response, 405, { error: "Method not allowed." });

    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD, POST" });
        return response.end("Method not allowed");
    }
    return serveStatic(request, response, url.pathname);
});

server.listen(port, "127.0.0.1", () => {
    console.log(`HealthCare+ is available at http://127.0.0.1:${port}`);
    if (!(aiProvider === "groq" ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY)) {
        console.log("Live AI and full-page translation are off; local demo replies remain available.");
    }
});
