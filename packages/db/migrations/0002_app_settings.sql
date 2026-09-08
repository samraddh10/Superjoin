CREATE TABLE "app_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"active_provider" text DEFAULT 'bedrock' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" text DEFAULT 'singleton' NOT NULL,
	CONSTRAINT "app_settings_provider_known" CHECK ("app_settings"."active_provider" in ('bedrock', 'groq')),
	CONSTRAINT "app_settings_single_row" CHECK ("app_settings"."singleton" = 'singleton')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_settings_singleton_key" ON "app_settings" USING btree ("singleton");
--> statement-breakpoint
INSERT INTO "app_settings" ("active_provider") VALUES ('bedrock') ON CONFLICT DO NOTHING;
