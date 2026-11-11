import fsp from "node:fs/promises";
import path from "node:path";
import { ensureExt } from "./helpers.js";

const INSTRUCTIONS = {
  summarize: "Summarize the text below. Keep the key facts, numbers and conclusions; use short paragraphs and a bullet list of takeaways.",
  keypoints: "Extract the most important points from the text below as a concise bullet list, grouped by theme.",
  explain: "Explain the text below in clear, plain language for a curious non-expert. Keep it under 400 words.",
  translate: "Translate the text below into English. Preserve formatting and do not add commentary.",
  custom: "Follow the custom instruction exactly.",
};

export const aiTools = {
  "ai-text": {
    category: "ai",
    name: "AI summarize / rewrite",
    description:
      "Send text to your own OpenAI-compatible endpoint using the key configured in Settings → AI. Nothing is sent unless you run the tool.",
    keywords: ["ai", "summarize", "rewrite", "translate", "openai", "llm"],
    accept: ".txt,.md,.csv,.json",
    minFiles: 0,
    maxFiles: 1,
    requiresConfig: "ai",
    fields: [
      {
        name: "mode",
        label: "Task",
        type: "select",
        options: [
          { value: "summarize", label: "Summarize" },
          { value: "keypoints", label: "Extract key points" },
          { value: "explain", label: "Explain simply" },
          { value: "translate", label: "Translate to English" },
          { value: "custom", label: "Custom instruction" },
        ],
        default: "summarize",
      },
      { name: "instruction", label: "Custom instruction", type: "textarea", placeholder: "Only used with the custom task" },
      { name: "text", label: "Text (if no file)", type: "textarea" },
      { name: "filename", label: "Output filename", type: "text", placeholder: "summary.md" },
    ],
    async run(ctx) {
      const settings = ctx.settings;
      if (!settings.ai.apiKey) {
        throw Object.assign(new Error("Configure an API key in Settings → AI before using this tool."), { status: 409 });
      }
      let input = ctx.values.text || "";
      if (ctx.files.length) input = await fsp.readFile(ctx.files[0].path, "utf8");
      input = String(input).trim();
      if (!input) throw Object.assign(new Error("Add text or choose a text file"), { status: 422 });
      if (input.length > 200_000) throw Object.assign(new Error("Text is limited to 200,000 characters"), { status: 413 });
      const mode = ctx.values.mode || "summarize";
      const instruction = mode === "custom" ? String(ctx.values.instruction || "").trim() : INSTRUCTIONS[mode] || INSTRUCTIONS.summarize;
      if (!instruction) throw Object.assign(new Error("Enter a custom instruction"), { status: 422 });
      const base = settings.ai.baseUrl.replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(base)) throw Object.assign(new Error("The AI base URL in Settings is invalid"), { status: 400 });
      const endpoint = base.endsWith("/chat/completions") ? base : base + "/chat/completions";
      let res;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${settings.ai.apiKey}` },
          body: JSON.stringify({
            model: settings.ai.model || "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a precise writing assistant. Answer directly with the requested content and no preamble." },
              { role: "user", content: `${instruction}\n\n---\n${input}` },
            ],
            temperature: 0.3,
          }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        throw Object.assign(new Error("Could not reach the AI endpoint: " + err.message), { status: 502 });
      }
      let payload;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      if (!res.ok) {
        const msg = payload?.error?.message || payload?.message || `HTTP ${res.status}`;
        throw Object.assign(new Error("AI endpoint error: " + msg), { status: 502 });
      }
      const output = payload?.choices?.[0]?.message?.content;
      if (!output) throw Object.assign(new Error("The AI endpoint returned an empty response"), { status: 502 });
      const target = ctx.out(ensureExt(ctx.values.filename || path.basename(ctx.files[0]?.name || "ai-output", path.extname(ctx.files[0]?.name || "")) || "ai-output", "md"));
      await fsp.writeFile(target, output, "utf8");
      return {
        text: output,
        files: [{ path: target, name: path.basename(target), mime: "text/markdown", size: Buffer.byteLength(output) }],
        summary: `Generated ${output.length.toLocaleString()} characters with ${settings.ai.model}.`,
      };
    },
  },
};
