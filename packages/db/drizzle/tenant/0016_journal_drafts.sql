CREATE TABLE `journal_drafts` (
	`id` integer PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "journal_drafts_singleton" CHECK("journal_drafts"."id" = 1)
) STRICT;
