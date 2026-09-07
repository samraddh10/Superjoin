-- pgvector must exist before claim_embeddings.embedding is created.
-- Drizzle Kit does not emit this; it is added by hand, which is why the plan calls
-- for generated migrations to be reviewed rather than applied straight from the schema.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('accepted', 'needs_review', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."evidence_entailment" AS ENUM('supported', 'unsupported', 'unclear', 'unchecked');--> statement-breakpoint
CREATE TYPE "public"."evidence_verification" AS ENUM('verified_native_text', 'visual_only', 'quote_not_found', 'block_not_found', 'unchecked');--> statement-breakpoint
CREATE TYPE "public"."extraction_method" AS ENUM('native_text', 'model_transcription');--> statement-breakpoint
CREATE TYPE "public"."issue_resolution" AS ENUM('open', 'retrying', 'resolved', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."relationship_label" AS ENUM('corroborates', 'contradicts', 'likely_contradiction', 'reconciled_by_context', 'insufficient_context', 'unrelated');--> statement-breakpoint
CREATE TYPE "public"."run_stage" AS ENUM('queued', 'parsing', 'extracting', 'normalizing', 'comparing', 'completed', 'completed_with_issues', 'failed');--> statement-breakpoint
CREATE TYPE "public"."source_block_type" AS ENUM('paragraph', 'heading', 'list', 'table', 'table_cell', 'chart', 'figure', 'caption', 'other');--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"page_count" integer,
	"publication_date" date,
	"pdf_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"stage" "run_stage" DEFAULT 'queued' NOT NULL,
	"pipeline_version" text NOT NULL,
	"model_name" text,
	"prompt_version" text,
	"embedding_model" text,
	"pages_total" integer,
	"pages_processed" integer DEFAULT 0 NOT NULL,
	"chunks_total" integer,
	"chunks_processed" integer DEFAULT 0 NOT NULL,
	"claims_extracted" integer DEFAULT 0 NOT NULL,
	"claims_accepted" integer DEFAULT 0 NOT NULL,
	"relationships_created" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"physical_page" integer NOT NULL,
	"printed_page_label" text,
	"block_type" "source_block_type" NOT NULL,
	"extraction_method" "extraction_method" NOT NULL,
	"block_index" integer NOT NULL,
	"content" text NOT NULL,
	"positioned_items" jsonb,
	"table_row_index" integer,
	"table_column_index" integer,
	"table_headers" jsonb,
	"bbox_x" double precision,
	"bbox_y" double precision,
	"bbox_width" double precision,
	"bbox_height" double precision,
	"coordinate_origin" text DEFAULT 'bottom-left' NOT NULL,
	"page_width_pt" double precision,
	"page_height_pt" double precision,
	"page_rotation" integer DEFAULT 0 NOT NULL,
	"page_image_key" text,
	"produced_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"canonical_label" text NOT NULL,
	"entity_type" text NOT NULL,
	"normalized_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"source_block_id" uuid,
	"established_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"entity_id" uuid,
	"predicate" text NOT NULL,
	"context_key" jsonb,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"task_type" text NOT NULL,
	"embedded_text" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_block_id" uuid NOT NULL,
	"quote" text NOT NULL,
	"quote_start" integer,
	"quote_end" integer,
	"verification" "evidence_verification" DEFAULT 'unchecked' NOT NULL,
	"entailment" "evidence_entailment" DEFAULT 'unchecked' NOT NULL,
	"verification_note" text,
	"support_role" text DEFAULT 'value' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"run_id" uuid,
	"entity_id" uuid,
	"fact_group_id" uuid,
	"subject" text NOT NULL,
	"predicate" text NOT NULL,
	"original_statement" text NOT NULL,
	"raw_value" text,
	"numeric_value" numeric,
	"normalized_value" numeric,
	"normalized_unit" text,
	"currency" text,
	"scale" text,
	"unit" text,
	"value_precision" integer,
	"period_label" text,
	"period_type" text,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"scope" text,
	"assertion_status" text,
	"qualifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"normalization" jsonb,
	"status" "claim_status" DEFAULT 'needs_review' NOT NULL,
	"status_reason" text,
	"assertion_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"claim_a_id" uuid NOT NULL,
	"claim_b_id" uuid NOT NULL,
	"label" "relationship_label" NOT NULL,
	"rationale" text NOT NULL,
	"context_differences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uncertainty_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deterministic_checks" jsonb,
	"supporting_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"method" text NOT NULL,
	"method_version" text NOT NULL,
	"model_name" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage" "run_stage" NOT NULL,
	"failure_kind" text NOT NULL,
	"is_transient" boolean,
	"physical_page" integer,
	"source_block_id" uuid,
	"claim_id" uuid,
	"message" text NOT NULL,
	"detail" jsonb,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"resolution" "issue_resolution" DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_blocks" ADD CONSTRAINT "source_blocks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_source_block_id_source_blocks_id_fk" FOREIGN KEY ("source_block_id") REFERENCES "public"."source_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_groups" ADD CONSTRAINT "fact_groups_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_groups" ADD CONSTRAINT "fact_groups_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_embeddings" ADD CONSTRAINT "claim_embeddings_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_source_block_id_source_blocks_id_fk" FOREIGN KEY ("source_block_id") REFERENCES "public"."source_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_fact_group_id_fact_groups_id_fk" FOREIGN KEY ("fact_group_id") REFERENCES "public"."fact_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_claim_a_id_claims_id_fk" FOREIGN KEY ("claim_a_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_claim_b_id_claims_id_fk" FOREIGN KEY ("claim_b_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_issues" ADD CONSTRAINT "processing_issues_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_issues" ADD CONSTRAINT "processing_issues_source_block_id_source_blocks_id_fk" FOREIGN KEY ("source_block_id") REFERENCES "public"."source_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_issues" ADD CONSTRAINT "processing_issues_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_collection_content_hash_key" ON "documents" USING btree ("collection_id","content_hash");--> statement-breakpoint
CREATE INDEX "documents_collection_idx" ON "documents" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "processing_runs_document_idx" ON "processing_runs" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "processing_runs_stage_idx" ON "processing_runs" USING btree ("stage");--> statement-breakpoint
CREATE UNIQUE INDEX "source_blocks_identity_key" ON "source_blocks" USING btree ("document_id","physical_page","block_index","produced_by");--> statement-breakpoint
CREATE INDEX "source_blocks_document_page_idx" ON "source_blocks" USING btree ("document_id","physical_page");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_collection_normalized_key" ON "entities" USING btree ("collection_id","normalized_label");--> statement-breakpoint
CREATE INDEX "entities_collection_idx" ON "entities" USING btree ("collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_aliases_entity_alias_key" ON "entity_aliases" USING btree ("entity_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "entity_aliases_normalized_idx" ON "entity_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "fact_groups_collection_predicate_idx" ON "fact_groups" USING btree ("collection_id","predicate");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_embeddings_claim_model_key" ON "claim_embeddings" USING btree ("claim_id","model");--> statement-breakpoint
CREATE INDEX "claim_embeddings_model_idx" ON "claim_embeddings" USING btree ("model");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_evidence_claim_block_quote_key" ON "claim_evidence" USING btree ("claim_id","source_block_id","quote");--> statement-breakpoint
CREATE INDEX "claim_evidence_claim_idx" ON "claim_evidence" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_block_idx" ON "claim_evidence" USING btree ("source_block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_document_fingerprint_key" ON "claims" USING btree ("document_id","assertion_fingerprint");--> statement-breakpoint
CREATE INDEX "claims_document_idx" ON "claims" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "claims_entity_predicate_idx" ON "claims" USING btree ("entity_id","predicate");--> statement-breakpoint
CREATE INDEX "claims_predicate_idx" ON "claims" USING btree ("predicate");--> statement-breakpoint
CREATE INDEX "claims_status_idx" ON "claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX "claims_fact_group_idx" ON "claims" USING btree ("fact_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_pair_method_key" ON "relationships" USING btree ("claim_a_id","claim_b_id","method_version");--> statement-breakpoint
CREATE INDEX "relationships_collection_label_idx" ON "relationships" USING btree ("collection_id","label");--> statement-breakpoint
CREATE INDEX "relationships_claim_a_idx" ON "relationships" USING btree ("claim_a_id");--> statement-breakpoint
CREATE INDEX "relationships_claim_b_idx" ON "relationships" USING btree ("claim_b_id");--> statement-breakpoint
CREATE INDEX "processing_issues_run_idx" ON "processing_issues" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "processing_issues_resolution_idx" ON "processing_issues" USING btree ("resolution");--> statement-breakpoint
CREATE INDEX "processing_issues_kind_idx" ON "processing_issues" USING btree ("failure_kind");