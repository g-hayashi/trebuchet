CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`db_file` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "entities_kind" CHECK("entities"."kind" IN ('individual', 'corporation'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `entities_db_file_unique` ON `entities` (`db_file`);