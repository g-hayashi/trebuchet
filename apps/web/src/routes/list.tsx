import { createFileRoute } from "@tanstack/react-router";
import { EntityListPage } from "@/features/entities/EntityListPage";

export const Route = createFileRoute("/list")({ component: EntityListPage });
