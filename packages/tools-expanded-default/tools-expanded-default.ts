import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function toolsExpandedDefault(pi: ExtensionAPI) {
  pi.setLabel("tools-expanded-default");
  pi.on("session_start", (_event, ctx) => ctx.ui.setToolsExpanded(true));
}
