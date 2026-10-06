/**
 * agent-progress-tool-omp — registers the essential `progress` tool in OMP sessions.
 *
 * The tool allows the agent to report its progress toward the active goal once per turn.
 * Downstream extensions such as session-governor-omp inspect the branch to detect blocked
 * streaks and escalate models.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-agent-core";
import { PROGRESS_DESCRIPTION, PROGRESS_STATUSES, PROGRESS_TOOL } from "./progress.ts";

export * from "./progress.ts";

export default function registerProgressTool(pi: ExtensionAPI): void {
	const T = pi.typebox.Type;
	pi.registerTool({
		name: PROGRESS_TOOL,
		label: "Progress",
		description: PROGRESS_DESCRIPTION,
		loadMode: "essential",
		approval: "read",
		parameters: T.Object({
			goal: T.String({ description: "The user's current goal, one line; same text while the goal is the same" }),
			status: T.Enum([...PROGRESS_STATUSES], { description: "progress | blocked | done" }),
			evidence: T.String({ description: "One raw output line that shows the status" }),
		}),
		async execute(_id, params) {
			return { content: [{ type: "text", text: `recorded: ${params.status}` }] };
		},
	});
}
