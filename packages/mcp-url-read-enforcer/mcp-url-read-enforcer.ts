import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const MCP_TOOL_URI = "xd://mcp__local_reader_read_url";
const NATIVE_EXTENSIONS = /\.(?:pdf|xlsx?|docx?|pptx?|csv|tsv|json|xml|ya?ml|txt|md|rst|log|zip|tar|gz|tgz|7z|rar|png|jpe?g|gif|webp|svg|mp[34]|wav|webm)$/i;
const NATIVE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "raw.githubusercontent.com", "api.github.com"]);

export function shouldDefuddle(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (NATIVE_HOSTS.has(hostname)) return false;
  return !NATIVE_EXTENSIONS.test(url.pathname);
}

export default function(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "read") return;
    const path = event.input.path;
    if (typeof path !== "string" || !shouldDefuddle(path)) return;
    return {
      block: true,
      reason:
        `This URL looks like an HTML page. Use local-reader to extract the article without spending context on navigation and page chrome: ` +
        `write JSON {"url":${JSON.stringify(path)}} to ${MCP_TOOL_URI}.`,
    };
  });
}
