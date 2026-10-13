import { db } from "@/db";
import { emailProvider, messagingConfig, smsProvider } from "@/server/messaging/config";
import { runDueWorkflows } from "./engine";

const EVERY_MS = 5_000;
const state = globalThis as unknown as { workflowWorker?: NodeJS.Timeout };

/** Checks for workflow steps that are due every few seconds, while the app runs. */
export function startWorkflowWorker() {
  if (state.workflowWorker || process.env.WORKFLOW_WORKER === "off") return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const config = messagingConfig();
      const deps = {
        providers: { sms: smsProvider(), email: emailProvider() },
        appUrl: config.appUrl,
        statusCallbacks: Boolean(config.twilio),
      };
      // Keep going while there's a backlog, then wait for the next tick.
      while ((await runDueWorkflows(db, deps)) > 0);
    } catch (err) {
      console.error("Workflow worker error", err);
    } finally {
      busy = false;
    }
  };
  state.workflowWorker = setInterval(tick, EVERY_MS);
  state.workflowWorker.unref?.();
}
