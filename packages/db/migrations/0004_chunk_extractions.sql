CREATE TABLE IF NOT EXISTS "chunk_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_fingerprint" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"prompt_version" text NOT NULL,
	"model_name" text NOT NULL,
	"claims_extracted" integer DEFAULT 0 NOT NULL,
	"claims_accepted" integer DEFAULT 0 NOT NULL,
	"claims_needing_review" integer DEFAULT 0 NOT NULL,
	"claims_rejected" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunk_extractions" ADD CONSTRAINT "chunk_extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chunk_extractions_identity_key" ON "chunk_extractions" USING btree ("document_id","chunk_fingerprint","prompt_version","model_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunk_extractions_document_idx" ON "chunk_extractions" USING btree ("document_id");
