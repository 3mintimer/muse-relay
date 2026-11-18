CREATE TABLE `relay_blobs` (
	`object_key` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`byte_length` integer NOT NULL,
	`checked_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `relay_blobs_collection` ON `relay_blobs` (`checked_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `relay_chunks` (
	`revision` text NOT NULL,
	`ordinal` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`revision`, `ordinal`)
);
--> statement-breakpoint
CREATE TABLE `relay_head` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	CONSTRAINT "relay_head_singleton" CHECK("relay_head"."id" = 1)
);
