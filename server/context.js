import zlib from "node:zlib";
import { pushLog } from "./prd.js";

export const CONTEXT_CAP = 8000;
const SUMMARY_CAP = 900;

export function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function assertPublicHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    const error = new Error("That URL is not valid.");
    error.status = 400;
    error.code = "bad_url";
    throw error;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    const error = new Error("Only http and https URLs can be loaded.");
    error.status = 400;
    error.code = "bad_url";
    throw error;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (privateHost) {
    const error = new Error("That URL is not a public page.");
    error.status = 400;
    error.code = "bad_url";
    throw error;
  }
  return url;
}

function pdfStrings(blob) {
  const parts = [];
  const pattern = /\((?:\\\)|\\.|[^\\)]){2,}\)/g;
  let match;
  while ((match = pattern.exec(blob))) {
    const inner = match[0]
      .slice(1, -1)
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");
    if (/[A-Za-z]{3,}/.test(inner)) parts.push(inner);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function extractPdfText(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const raw = bytes.toString("latin1");
  const chunks = [];
  const streams = /stream\r?\n([\s\S]*?)endstream/g;
  let match;
  while ((match = streams.exec(raw))) {
    let data = Buffer.from(match[1], "latin1");
    const header = raw.slice(Math.max(0, match.index - 240), match.index);
    if (/FlateDecode/.test(header)) {
      try {
        data = zlib.inflateSync(data);
      } catch {
        try {
          data = zlib.unzipSync(data);
        } catch {
          continue;
        }
      }
    }
    chunks.push(data.toString("latin1"));
  }
  const text = pdfStrings(chunks.join("\n") || raw);
  if (text.length < 40) {
    const error = new Error("Couldn't read text from that PDF. Paste the notes, or upload a .md or .txt file.");
    error.status = 400;
    error.code = "bad_pdf";
    throw error;
  }
  return text;
}

export function summarizeContext(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= SUMMARY_CAP) return clean;
  return `${clean.slice(0, SUMMARY_CAP).trim()}…`;
}

export function capContext(text) {
  const clean = String(text || "").replace(/\u0000/g, "").trim();
  return clean.length > CONTEXT_CAP ? clean.slice(0, CONTEXT_CAP) : clean;
}

export async function fetchUrlText(value) {
  const url = assertPublicHttpUrl(value);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "Shape/0.1 (context fetch)" },
  });
  if (response.url) assertPublicHttpUrl(response.url);
  if (!response.ok) {
    const error = new Error(`Could not fetch that page (${response.status}).`);
    error.status = 400;
    error.code = "fetch_failed";
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 500_000) {
    const error = new Error("That page is too large to load.");
    error.status = 400;
    error.code = "too_large";
    throw error;
  }
  let text = bytes.toString("utf8");
  const type = response.headers.get("content-type") || "";
  if (/html/i.test(type) || /<html[\s>]/i.test(text.slice(0, 800))) text = stripHtml(text);
  return capContext(text);
}

export function loadContext(session, { text, source, label }) {
  const body = capContext(text);
  if (body.length < 20) {
    const error = new Error("Add a bit more context, at least a sentence.");
    error.status = 400;
    error.code = "empty_context";
    throw error;
  }
  const summary = summarizeContext(body);
  session.context = {
    loaded: true,
    source: source || "paste",
    label: label || "notes",
    chars: body.length,
    summary,
  };
  pushLog(session, {
    name: "load_context",
    via: "tool",
    transport: "in-process",
    source: "ui",
    args: { source: session.context.source, chars: body.length, label: session.context.label },
    summary: `${session.context.label} · ${body.length} chars`,
  });
  return session.context;
}
