/**
 * Plannotator Plugin for OpenCode
 *
 * Provides iterative planning with interactive browser-based plan review.
 *
 * When the agent is in plan mode:
 * - Injects planning prompt directing the agent to write plans in $XDG_DATA_HOME/opencode/plans/
 * - Agent creates a uniquely-named plan file, revises it on feedback
 * - submit_plan(path) reads the plan from disk and opens browser UI
 * - plan_exit suppressed in favor of submit_plan (experimental mode compatibility)
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote mode (devcontainer, SSH)
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 *   PLANNOTATOR_PLAN_TIMEOUT_SECONDS - Max wait for submit_plan approval (default: 345600, set 0 to disable)
 *   PLANNOTATOR_ALLOW_SUBAGENTS - Set to "1" to allow subagents to see submit_plan tool
 *
 * @packageDocumentation
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import {
  startPlannotatorServer,
  handleServerReady,
} from "@plannotator/server";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";
import {
  startAnnotateServer,
  handleAnnotateServerReady,
} from "@plannotator/server/annotate";
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import {
  handleReviewCommand,
  handleAnnotateCommand,
  handleAnnotateLastCommand,
  type CommandDeps,
} from "./commands";
import { planDenyFeedback } from "@plannotator/shared/feedback-templates";
import {
  getPlanDirectory,
  validatePlanPath,
  stripConflictingPlanModeRules,
} from "./plan-mode";

// @ts-ignore - Bun import attribute for text
import indexHtml from "./plannotator.html" with { type: "text" };
const htmlContent = indexHtml as unknown as string;

// @ts-ignore - Bun import attribute for text
import reviewHtml from "./review-editor.html" with { type: "text" };
const reviewHtmlContent = reviewHtml as unknown as string;

const DEFAULT_PLAN_TIMEOUT_SECONDS = 345_600; // 96 hours

// ── Planning prompt ───────────────────────────────────────────────────────

function getPlanningPrompt(planDir: string): string {
  return `## Plannotator — Iterative Planning

**CRITICAL: Do NOT use TodoWrite for planning. Do NOT write plans to the current working directory.**

Write all plan files to this global directory:

${planDir}

Create the directory with \`mkdir -p ${planDir}\` if it does not exist.

You must not edit the codebase during planning. The only files you may create or edit are plan markdown files inside that directory. Do not run destructive shell commands (rm, git push, npm install, etc.).

### Step 1 — Explore

Before writing anything, understand the task and the code it touches.

- Read the relevant source files. Trace call paths, data flow, and dependencies.
- Look at existing patterns, utilities, and conventions in the codebase — your plan should reuse them.
- Check related tests to understand expected behavior and edge cases.
- Scale depth to the task: a vague feature request needs deep exploration; a focused bug fix may only need a few files.

Do not jump to writing a plan or asking questions until you have the context you need. If the conversation already provided sufficient context, or the task is greenfield with no code to explore, move on to the next step.

### Step 2 — Ask (if needed)

If there are things only the user can answer — requirements, preferences, tradeoffs, edge-case priorities — use the \`question\` tool. Do not ask via plain text output.

- Never ask what you could find out by reading the code.
- Batch related questions into a single \`question\` call.
- For greenfield tasks, this may be your first step.

### Step 3 — Write the plan

Once you understand the task, create exactly one markdown plan file in the directory above with a unique, descriptive filename (e.g. \`auth-refactor.md\`, \`fix-upload-timeout.md\`). Do not overwrite or reuse filenames from existing plans.

Structure the plan with:
- **Context** — Why this change is being made.
- **Approach** — Your recommended approach only, not all alternatives considered.
- **Files to modify** — List the critical file paths that will be changed.
- **Reuse** — Reference existing functions and utilities you found, with their file paths.
- **Steps** — Implementation checklist with \`- [ ]\` items.
- **Verification** — How to test the changes end-to-end.

Keep it concise enough to scan quickly, but detailed enough to execute effectively.

### Step 4 — Submit

Call \`submit_plan(path: "/absolute/path/to/your-plan.md")\` to open the plan in a visual review UI. Do not submit plan text directly — submit the file path.

### If the user requests changes

1. Read the same plan file you previously submitted.
2. Edit that same file to address the feedback.
3. Call \`submit_plan\` again with the same \`path\`.
4. Never create a new file in response to feedback — always revise the existing one.

### Ending your turn

Your turn should only end by either:
- Using the question tool to ask the user for information.
- Calling submit_plan when the plan is ready for review.

Do not end your turn without doing one of these two things.

### Summary — Required workflow

1. **Explore** the codebase to understand the task.
2. **Ask** the user clarifying questions using the \`question\` tool (not plain text).
3. **Write** a plan markdown file to \`${planDir}\` — never the current working directory, never TodoWrite.
4. **Submit** by calling \`submit_plan\` with the absolute file path.

Do not skip or reorder these steps. Do not use TodoWrite as a substitute for writing a plan file.`;
}

// ── Plugin ────────────────────────────────────────────────────────────────

export const PlannotatorPlugin: Plugin = async (ctx) => {
  // Agents list is static for the session lifetime — fetch once and cache
  let cachedAgents: any[] | null = null;

  // Helper to determine if sharing is enabled (lazy evaluation)
  // Priority: OpenCode config > env var > default (enabled)
  async function getSharingEnabled(): Promise<boolean> {
    try {
      const response = await ctx.client.config.get({ query: { directory: ctx.directory } });
      // @ts-ignore - share config may exist
      const share = response?.data?.share;
      if (share !== undefined) {
        return share !== "disabled";
      }
    } catch {
      // Config read failed, fall through to env var
    }
    return process.env.PLANNOTATOR_SHARE !== "disabled";
  }

  function getShareBaseUrl(): string | undefined {
    return process.env.PLANNOTATOR_SHARE_URL || undefined;
  }

  function getPlanTimeoutSeconds(): number | null {
    const raw = process.env.PLANNOTATOR_PLAN_TIMEOUT_SECONDS?.trim();
    if (!raw) return DEFAULT_PLAN_TIMEOUT_SECONDS;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(
        `[Plannotator] Invalid PLANNOTATOR_PLAN_TIMEOUT_SECONDS="${raw}". Using default ${DEFAULT_PLAN_TIMEOUT_SECONDS}s.`
      );
      return DEFAULT_PLAN_TIMEOUT_SECONDS;
    }

    if (parsed === 0) return null;
    return parsed;
  }

  function allowSubagents(): boolean {
    const val = process.env.PLANNOTATOR_ALLOW_SUBAGENTS?.trim();
    return val === "1" || val === "true";
  }

  return {
    // Register submit_plan as primary-only tool (hidden from sub-agents by default)
    config: async (opencodeConfig) => {
      if (!allowSubagents()) {
        const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? [];
        if (!existingPrimaryTools.includes("submit_plan")) {
          opencodeConfig.experimental = {
            ...opencodeConfig.experimental,
            primary_tools: [...existingPrimaryTools, "submit_plan"],
          };
        }
      }

      // Allow the plan agent to write .md files anywhere.
      // OpenCode's built-in plan agent uses relative-path globs that break
      // when worktree != cwd (non-git projects). Per-agent config merges
      // last (agent.ts:232), so this only affects the plan agent.
      opencodeConfig.agent ??= {};
      opencodeConfig.agent.plan ??= {};
      opencodeConfig.agent.plan.permission ??= {};
      opencodeConfig.agent.plan.permission.edit = {
        ...opencodeConfig.agent.plan.permission.edit,
        "*.md": "allow",
      };
    },

    // Strip OpenCode's built-in "STRICTLY FORBIDDEN" plan mode prompt from
    // synthetic user message parts. The plugin's system prompt injection is
    // the full replacement — this removes the conflicting original.
    "experimental.chat.messages.transform": async (input, output) => {
      for (const message of output.messages) {
        if (message.info.role !== "user") continue;
        message.parts = message.parts.filter(
          (part: any) => !(part.type === "text" && part.text?.includes("STRICTLY FORBIDDEN"))
        );
      }
    },

    // Suppress plan_exit in favor of submit_plan
    "tool.definition": async (input, output) => {
      if (input.toolID === "plan_exit") {
        output.description =
          "Do not call this tool. Use submit_plan instead — it opens a visual review UI for plan approval.";
      }
      if (input.toolID === "todowrite") {
        output.description =
          "Track implementation progress by creating and updating task checklists. Only use this after a plan has been approved — not for planning itself. For planning, write a plan file and call submit_plan.";
      }
    },

    // Inject planning instructions into system prompt
    "experimental.chat.system.transform": async (input, output) => {
      // Skip for title generation requests
      const systemText = output.system.join("\n");
      if (systemText.toLowerCase().includes("title generator") || systemText.toLowerCase().includes("generate a title")) {
        return;
      }

      let lastUserAgent: string | undefined;
      try {
        // Fetch session messages to determine current agent
        const messagesResponse = await ctx.client.session.messages({
          // @ts-ignore - sessionID exists on input
          path: { id: input.sessionID }
        });
        const messages = messagesResponse.data;

        // Find last user message (reverse iteration)
        if (messages) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.info.role === "user") {
              // @ts-ignore - UserMessage has agent field
              lastUserAgent = msg.info.agent;
              break;
            }
          }
        }

        // Skip if agent detection fails (safer)
        if (!lastUserAgent) return;

        // Hardcoded exclusion: build agent
        if (lastUserAgent === "build") return;

        // Agents list is static — cache after first fetch
        if (!cachedAgents) {
          const agentsResponse = await ctx.client.app.agents({
            query: { directory: ctx.directory }
          });
          cachedAgents = agentsResponse.data ?? [];
        }
        const agent = cachedAgents.find((a: { name: string }) => a.name === lastUserAgent);

        // Skip if agent is a sub-agent
        // @ts-ignore - Agent has mode field
        if (agent?.mode === "subagent") return;

      } catch {
        // Skip injection on any error (safer)
        return;
      }
      if (lastUserAgent === "plan") {
        const planDir = getPlanDirectory();
        output.system = stripConflictingPlanModeRules(output.system);
        // Replace conflicting instructions in the base prompt
        output.system = output.system.map((s: string) =>
          s
            .replace("This includes markdown files.", `Exception: you must create plan markdown files in ${planDir}.`)
            .replace("These tools are also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable.", `Do not use TodoWrite for planning. Instead, write your plan as a markdown file in ${planDir} and call submit_plan.`)
            .replace("Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.", "TodoWrite is for tracking implementation progress only, not for planning.")
            .replace("- Use the TodoWrite tool to plan the task if required", `- Write your plan to ${planDir} and call submit_plan`)
            .replace("IMPORTANT: Always use the TodoWrite tool to plan and track tasks throughout the conversation.", `IMPORTANT: In plan mode, always write a plan file to ${planDir} and call submit_plan. Do not use TodoWrite for planning.`)
            .replace("Let me first use the TodoWrite tool to plan this task.", "Let me first write a plan file and submit it for review.")
            .replace("You have access to the TodoWrite tools to help you manage and plan tasks.", "You have access to the TodoWrite tools to help you track implementation tasks.")
            .replace(
              `<example>
user: Help me write a new feature that allows users to track their usage metrics and export them to various formats
assistant: I'll help you implement a usage metrics tracking and export feature. Let me first write a plan file and submit it for review.
Adding the following todos to the todo list:
1. Research existing metrics tracking in the codebase
2. Design the metrics collection system
3. Implement core metrics tracking functionality
4. Create export functionality for different formats

Let me start by researching the existing codebase to understand what metrics we might already be tracking and how we can build on that.

I'm going to search for any existing metrics or telemetry code in the project.

I've found some existing telemetry code. Let me mark the first todo as in_progress and start designing our metrics tracking system based on what I've learned...

[Assistant continues implementing the feature step by step, marking todos as in_progress and completed as they go]
</example>`,
              `<example>
user: Help me write a new feature that allows users to track their usage metrics and export them to various formats
assistant: I'll write a plan for this feature. Let me first explore the codebase to understand existing patterns.

[Assistant explores code, asks clarifying questions using the question tool]

Now I'll write the plan file.

[Assistant writes plan markdown to ${planDir}/usage-metrics.md]

[Assistant calls submit_plan with the absolute path to open the review UI]
</example>`)
        );
        // Final sweep: replace any remaining TodoWrite/todo references in plan mode
        output.system = output.system.map((s: string) =>
          s
            .replace(/TodoWrite/g, "submit_plan")
            .replace(/todowrite/gi, "submit_plan")
            .replace(/todo list/gi, "plan file")
            .replace(/todo items/gi, "plan steps")
            .replace(/todos/gi, "plan steps")
        );
        const prompt = getPlanningPrompt(planDir);
        output.system.push(prompt);
        // Append a short reinforcement reminder at the very end of system prompt
        output.system.push(`<system-reminder>You are in PLAN MODE. The user has asked you to plan, not execute. Explore the codebase, ask clarifying questions using the question tool, and finalize your plan in a markdown file written to ${planDir}. Then call submit_plan with the absolute path. Do not use the todowrite tool. Do not create todos. The plan file is your only output.</system-reminder>`);
        return;
      }

      // Other primary agents: inject minimal submission reminder
      output.system.push(`
## Plan Submission

When you have completed your plan, you MUST call the \`submit_plan\` tool to submit it for user review.
The user will be able to:
- Review your plan visually in a dedicated UI
- Annotate specific sections with feedback
- Approve the plan to proceed with implementation
- Request changes with detailed feedback

If your plan is rejected, you will receive the user's annotated feedback. Revise your plan
based on their feedback and call submit_plan again.

Do NOT proceed with implementation until your plan is approved.
`);
    },

    // Intercept plannotator-last before the agent sees the command
    "command.execute.before": async (input, output) => {
      if (input.command !== "plannotator-last") return;

      // Clear parts so the agent doesn't respond to the command body
      output.parts = [];

      const deps: CommandDeps = {
        client: ctx.client,
        htmlContent,
        reviewHtmlContent,
        getSharingEnabled,
        getShareBaseUrl,
        directory: ctx.directory,
      };

      // Fetch last message, run annotation server, get feedback
      const feedback = await handleAnnotateLastCommand(
        { properties: { sessionID: input.sessionID } },
        deps
      );

      // Send feedback as a new prompt — same pattern as review/annotate
      if (feedback) {
        try {
          await ctx.client.session.prompt({
            path: { id: input.sessionID },
            body: {
              parts: [{
                type: "text",
                text: `# Message Annotations\n\n${feedback}\n\nPlease address the annotation feedback above.`,
              }],
            },
          });
        } catch {
          // Session may not be available
        }
      }
    },

    // Listen for slash commands (review + annotate)
    event: async ({ event }) => {
      const isCommandEvent =
        event.type === "command.executed" ||
        event.type === "tui.command.execute";

      if (!isCommandEvent) return;

      // @ts-ignore - Event structure varies
      const commandName = event.properties?.name || event.command || event.payload?.name;

      const deps: CommandDeps = {
        client: ctx.client,
        htmlContent,
        reviewHtmlContent,
        getSharingEnabled,
        getShareBaseUrl,
        directory: ctx.directory,
      };

      if (commandName === "plannotator-review")
        return handleReviewCommand(event, deps);
      if (commandName === "plannotator-annotate")
        return handleAnnotateCommand(event, deps);
    },

    tool: {
      submit_plan: tool({
        description:
          "Use this tool to create and submit plans. When the user asks you to plan something, follow the planning process: explore the codebase, ask clarifying questions, then write your plan as a markdown file. After following the planning process, call this tool with the absolute file path to open an interactive review UI where the user can annotate, approve, or request changes.",
        args: {
          path: tool.schema
            .string()
            .describe("Absolute path to the plan markdown file on disk."),
        },

        async execute(args, context) {
          const planDir = getPlanDirectory();
          const validation = validatePlanPath(args.path, planDir);

          if (!validation.ok) {
            return `Error: ${validation.error}`;
          }

          const planContent = validation.content;
          const sharingEnabled = await getSharingEnabled();
          const server = await startPlannotatorServer({
            plan: planContent,
            origin: "opencode",
            sharingEnabled,
            shareBaseUrl: getShareBaseUrl(),
            htmlContent,
            opencodeClient: ctx.client,
            onReady: async (url, isRemote, port) => {
              handleServerReady(url, isRemote, port);
              if (isRemote && sharingEnabled) {
                await writeRemoteShareLink(planContent, getShareBaseUrl(), "review the plan", "plan only").catch(() => {});
              }
            },
          });

          const timeoutSeconds = getPlanTimeoutSeconds();
          const timeoutMs = timeoutSeconds === null ? null : timeoutSeconds * 1000;

          const result = timeoutMs === null
            ? await server.waitForDecision()
            : await new Promise<Awaited<ReturnType<typeof server.waitForDecision>>>((resolve) => {
                const timeoutId = setTimeout(
                  () =>
                    resolve({
                      approved: false,
                      feedback: `[Plannotator] No response within ${timeoutSeconds} seconds. Port released automatically. Please call submit_plan again.`,
                    }),
                  timeoutMs
                );

                server.waitForDecision().then((r) => {
                  clearTimeout(timeoutId);
                  resolve(r);
                });
              });
          await Bun.sleep(1500);
          server.stop();

          if (result.approved) {
            // Check agent switch setting
            const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== 'disabled';
            const targetAgent = result.agentSwitch || 'build';

            if (shouldSwitchAgent) {
              try {
                await ctx.client.tui.executeCommand({
                  body: { command: "agent_cycle" },
                });
              } catch {
                // Silently fail
              }

              try {
                await ctx.client.session.prompt({
                  path: { id: context.sessionID },
                  body: {
                    agent: targetAgent,
                    noReply: true,
                    parts: [{ type: "text", text: "Proceed with implementation" }],
                  },
                });
              } catch {
                // Silently fail if session is busy
              }
            }

            if (result.feedback) {
              return `Plan approved with notes!
${result.savedPath ? `Saved to: ${result.savedPath}` : ""}

## Implementation Notes

The user approved your plan but added the following notes to consider during implementation:

${result.feedback}

Proceed with implementation, incorporating these notes where applicable.`;
            }

            return `Plan approved!${result.savedPath ? ` Saved to: ${result.savedPath}` : ""}`;
          } else {
            return planDenyFeedback(result.feedback || "", "submit_plan", { planFilePath: args.path });
          }
        },
      }),
    },
  };
};

export default PlannotatorPlugin;
