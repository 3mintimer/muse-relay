CREATE TABLE `relay_soniox_quota` (
	`id` integer PRIMARY KEY NOT NULL,
	`calls` text NOT NULL,
	`allowed` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_soniox_quota_singleton" CHECK("relay_soniox_quota"."id" = 1)
);
