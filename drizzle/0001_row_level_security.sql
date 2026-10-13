-- Row-level security: tenant rows are only visible inside a transaction that
-- has switched to the shab_app role and set app.workspace_id.
-- See src/db/tenant.ts (withWorkspace).
DO $$ BEGIN
  CREATE ROLE shab_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('GRANT shab_app TO %I', current_user);
EXCEPTION WHEN others THEN NULL;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO shab_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts, activities, pipelines, pipeline_stages, deals TO shab_app;
--> statement-breakpoint
GRANT SELECT ON workspaces TO shab_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts', 'activities', 'pipelines', 'pipeline_stages', 'deals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO shab_app
         USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)
         WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
