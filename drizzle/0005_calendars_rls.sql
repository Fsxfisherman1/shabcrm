-- Calendars and appointments are tenant data: same row-level security as contacts.
GRANT SELECT, INSERT, UPDATE, DELETE ON calendars, appointments TO shab_app;
--> statement-breakpoint
ALTER TABLE calendars ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calendars FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calendars TO shab_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON appointments TO shab_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Booking pages are public settings looked up by slug; the app role only reads them.
GRANT SELECT ON booking_pages TO shab_app;
