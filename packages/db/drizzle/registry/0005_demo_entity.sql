PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`db_file` text NOT NULL,
	`created_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`is_demo` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "entities_kind" CHECK("__new_entities"."kind" IN ('individual', 'corporation')),
	CONSTRAINT "entities_status" CHECK("__new_entities"."status" IN ('active', 'archived', 'deleting', 'preparing')),
	CONSTRAINT "entities_is_demo" CHECK("__new_entities"."is_demo" IN (0, 1))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_entities`("id", "name", "kind", "db_file", "created_at", "status") SELECT "id", "name", "kind", "db_file", "created_at", "status" FROM `entities`;--> statement-breakpoint
DROP TABLE `entities`;--> statement-breakpoint
ALTER TABLE `__new_entities` RENAME TO `entities`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `entities_db_file_unique` ON `entities` (`db_file`);