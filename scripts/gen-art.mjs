#!/usr/bin/env node
// Generates one image with the OpenAI Images API and writes it atomically.
//   OPENAI_API_KEY=... node scripts/gen-art.mjs --prompt "..." --out public/assets/rooms/go/hero.webp \
//     [--size 1536x1024] [--quality high|medium|low] [--model gpt-image-2.6-sunburst|gpt-image-2.6-flare]
//     [--format webp|png|jpeg] [--transparent]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    prompt: { type: "string" },
    out: { type: "string" },
    size: { type: "string", default: "1024x1024" },
    quality: { type: "string", default: "medium" },
    model: { type: "string", default: "gpt-image-2.6-sunburst" },
    format: { type: "string" },
    transparent: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (values.help || !values.prompt || !values.out) {
  fail("Usage: node scripts/gen-art.mjs --prompt <text> --out <file> [--size WxH] [--quality high|medium|low] [--model id] [--format webp|png|jpeg] [--transparent]");
}
if (!process.env.OPENAI_API_KEY) fail("OPENAI_API_KEY is not set");
const [width, height] = values.size.split("x").map(Number);
if (!width || !height || width % 16 || height % 16) fail(`--size must be WxH with multiples of 16, got ${values.size}`);
const format = values.format ?? (values.transparent ? "png" : path.extname(values.out).slice(1).replace("jpg", "jpeg") || "webp");
if (values.transparent && format === "jpeg") fail("--transparent needs png or webp");

const body = { model: values.model, prompt: values.prompt, size: values.size, quality: values.quality, output_format: format, n: 1 };
if (values.transparent) body.background = "transparent";

const startedAt = Date.now();
const response = await fetch("https://api.openai.com/v1/images/generations", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const payload = await response.json().catch(() => null);
if (!response.ok) fail(`Image generation failed (HTTP ${response.status}): ${payload?.error?.message ?? "no details"}`);
const encoded = payload?.data?.[0]?.b64_json;
if (!encoded) fail("The response contained no image");

const outPath = path.resolve(values.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const temporary = `${outPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, Buffer.from(encoded, "base64"));
fs.renameSync(temporary, outPath);
const kilobytes = Math.round(fs.statSync(outPath).size / 1024);
console.log(`${path.relative(process.cwd(), outPath)} ${values.size} ${format} ${kilobytes} KB in ${((Date.now() - startedAt) / 1000).toFixed(1)}s${kilobytes > 600 ? " (over 600 KB: consider --quality medium)" : ""}`);
