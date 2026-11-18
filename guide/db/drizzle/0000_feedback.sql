CREATE TABLE `feedback_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_limits_expiry` ON `feedback_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `feedback_receipts` (
	`receipt` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`share` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`issue_url` text,
	CONSTRAINT "feedback_kind" CHECK("feedback_receipts"."kind" IN ('idea', 'problem', 'question')),
	CONSTRAINT "feedback_share" CHECK("feedback_receipts"."share" IN (0, 1)),
	CONSTRAINT "feedback_message_length" CHECK(length("feedback_receipts"."message") BETWEEN 10 AND 4000),
	CONSTRAINT "feedback_status" CHECK("feedback_receipts"."status" IN ('new', 'reviewed', 'issue', 'closed')),
	CONSTRAINT "feedback_issue_consent" CHECK("feedback_receipts"."issue_url" IS NULL OR "feedback_receipts"."share" = 1)
);
--> statement-breakpoint
CREATE INDEX `feedback_receipts_created` ON `feedback_receipts` (`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_receipts_status_created` ON `feedback_receipts` (`status`,`created_at`);