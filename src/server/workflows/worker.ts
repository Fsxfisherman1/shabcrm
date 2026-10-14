import { db } from "@/db";
import { allProviders, messagingConfig } from "@/server/messaging/config";
import { runAiQueue } from "@/server/ai";
import { sendLeadAlerts } from "@/server/lead-alerts";
import { runDueWorkflows } from "./engine";

const EVERY_MS = 5_000;
const LEAD_ALERTS_EVERY_MS = 60_000;
const state = globalThis as unknown as { workflowWorker?: NodeJS.Timeout };

/**
 * Every few seconds while the app runs: workflow steps that are due, and
 * messages waiting for the AI to tag them. Every minute: speed-to-lead alerts.
 */
export function startWorkflowWorker() {
  if (state.workflowWorker || process.env.WORKFLOW_WORKER === "off") return;
  let busy = false;
  let lastLeadCheck = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const config = messagingConfig();
      const deps = {
        providers: allProviders(),
        appUrl: config.appUrl,
        statusCallbacks: Boolean(config.twilio || config.sendblue),
      };
      // Keep going while there's a backlog, then wait for the next tick.
      while ((await runDueWorkflows(db, deps)) > 0);
      await runAiQueue(db);
      if (Date.now() - lastLeadCheck >= LEAD_ALERTS_EVERY_MS) {
        lastLeadCheck = Date.now();
        await sendLeadAlerts(db, deps);
      }
    } catch (err) {
      console.error("Workflow worker error", err);
    } finally {
      busy = false;
    }
  };
  state.workflowWorker = setInterval(tick, EVERY_MS);
  state.workflowWorker.unref?.();
}
