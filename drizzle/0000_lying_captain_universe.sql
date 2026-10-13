CREATE TYPE "public"."document_kind" AS ENUM('ORDER', 'CARRIER', 'SUPPORT', 'POLICY', 'LEDGER', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."packet_state" AS ENUM('NONE', 'QUEUED', 'RETRIEVING', 'DRAFTING', 'NEEDS_REVIEW', 'DRAFTED', 'SUBMITTING', 'FILED', 'FAILED');--> statement-breakpoint
CREATE TABLE "disputes" (
	"dispute_id" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"buyer_name" text,
	"amount_value" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"lifecycle_stage" text NOT NULL,
	"evidence_requested" text,
	"transaction_id" text,
	"seller_response_due_at" timestamp with time zone,
	"paypal_created_at" timestamp with time zone,
	"packet_state" "packet_state" DEFAULT 'NONE' NOT NULL,
	"win_score" integer,
	"raw" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"kind" "document_kind" NOT NULL,
	"title" text NOT NULL,
	"source_ref" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paypal_merchant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packet_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"packet_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_id" uuid,
	"quote" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" text NOT NULL,
	"state" "packet_state" DEFAULT 'QUEUED' NOT NULL,
	"model" text,
	"prompt_version" text,
	"win_score" integer,
	"score_reasons" jsonb,
	"narrative" text,
	"submitted_at" timestamp with time zone,
	"paypal_response" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paypal_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"summary" text,
	"payload" jsonb NOT NULL,
	"signature_verified" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text
);
--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_chunks" ADD CONSTRAINT "evidence_chunks_document_id_evidence_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."evidence_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_chunks" ADD CONSTRAINT "evidence_chunks_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_documents" ADD CONSTRAINT "evidence_documents_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packet_claims" ADD CONSTRAINT "packet_claims_packet_id_packets_id_fk" FOREIGN KEY ("packet_id") REFERENCES "public"."packets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packet_claims" ADD CONSTRAINT "packet_claims_document_id_evidence_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."evidence_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packet_claims" ADD CONSTRAINT "packet_claims_chunk_id_evidence_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."evidence_chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packets" ADD CONSTRAINT "packets_dispute_id_disputes_dispute_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("dispute_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disputes_merchant_idx" ON "disputes" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "disputes_due_idx" ON "disputes" USING btree ("seller_response_due_at");--> statement-breakpoint
CREATE INDEX "disputes_packet_state_idx" ON "disputes" USING btree ("packet_state");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_chunks_position_key" ON "evidence_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "evidence_chunks_merchant_idx" ON "evidence_chunks" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "evidence_chunks_embedding_idx" ON "evidence_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_documents_dedupe_key" ON "evidence_documents" USING btree ("merchant_id","content_hash");--> statement-breakpoint
CREATE INDEX "evidence_documents_merchant_idx" ON "evidence_documents" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "evidence_documents_unindexed_idx" ON "evidence_documents" USING btree ("indexed_at");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_type_idx" ON "jobs" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_paypal_id_key" ON "merchants" USING btree ("paypal_merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "packet_claims_position_key" ON "packet_claims" USING btree ("packet_id","ordinal");--> statement-breakpoint
CREATE INDEX "packets_dispute_idx" ON "packets" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "packets_state_idx" ON "packets" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_paypal_id_key" ON "webhook_events" USING btree ("paypal_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("processed_at");