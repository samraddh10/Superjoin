ALTER TABLE "app_settings" ADD COLUMN "available_providers" jsonb DEFAULT '[]'::jsonb NOT NULL;
