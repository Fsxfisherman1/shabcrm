-- Form submissions are tenant data: same row-level security as contacts.
GRANT SELECT, INSERT, UPDATE, DELETE ON forms, form_submissions TO shab_app;
--> statement-breakpoint
ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE form_submissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON form_submissions TO shab_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Forms are public settings the form page looks up by slug, so row-level
-- security isn't forced; inside the app the app role only sees its account's forms.
ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON forms TO shab_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
