-- Workflows, their runs and logs are tenant data: same row-level security as contacts.
GRANT SELECT, INSERT, UPDATE, DELETE ON workflows, workflow_runs, workflow_run_logs, workflow_queue TO shab_app;
--> statement-breakpoint
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON workflows TO shab_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON workflow_runs TO shab_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE workflow_run_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workflow_run_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON workflow_run_logs TO shab_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The queue holds only ids and times; the worker reads it across accounts. It
-- stays without row-level security, but the app role can only touch the rows of
-- the account it's working in.
ALTER TABLE workflow_queue ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON workflow_queue TO shab_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
