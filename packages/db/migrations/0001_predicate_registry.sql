CREATE TABLE "predicate_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"canonical_name" text NOT NULL,
	"description" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit_hint" text,
	"established_by" text DEFAULT 'extracted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "predicate_registry" ADD CONSTRAINT "predicate_registry_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "predicate_registry_collection_name_key" ON "predicate_registry" USING btree ("collection_id","canonical_name");--> statement-breakpoint
CREATE INDEX "predicate_registry_collection_idx" ON "predicate_registry" USING btree ("collection_id");