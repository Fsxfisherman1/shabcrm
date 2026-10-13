export async function register() {
  // Runs workflow steps in the background (waits, follow-up texts…).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorkflowWorker } = await import("@/server/workflows/worker");
    startWorkflowWorker();
  }
}
