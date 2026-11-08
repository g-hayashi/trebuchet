import type { Clock, IdGenerator, RegistryRepository } from "../../src/ports.ts";
import type { EntitySummary } from "../../src/types.ts";

/** UUID の形式の連番を返す */
export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `00000000-0000-7000-8000-${this.n.toString(16).padStart(12, "0")}`;
  }
}

export class FixedClock implements Clock {
  value: string;
  constructor(value = "2026-10-18T00:00:00.000Z") {
    this.value = value;
  }
  now(): string {
    return this.value;
  }
}

export class InMemoryRegistry implements RegistryRepository {
  /** 準備中を含む全部の行（status は `statuses`。なければ active） */
  entities: EntitySummary[] = [];
  statuses = new Map<string, "active" | "preparing">();
  failOnInsert = false;

  private isPreparing(id: string): boolean {
    return this.statuses.get(id) === "preparing";
  }
  listEntities(): EntitySummary[] {
    return this.entities.filter((e) => !this.isPreparing(e.id));
  }
  getEntity(id: string): EntitySummary | undefined {
    return this.listEntities().find((e) => e.id === id);
  }
  insertEntity(entity: EntitySummary & { status?: "active" | "preparing" | undefined }): void {
    if (this.failOnInsert) throw new Error("registry insert failed");
    const { status, ...summary } = entity;
    this.entities.push(summary);
    this.statuses.set(summary.id, status ?? "active");
  }
  renameEntity(id: string, name: string): void {
    this.entities = this.entities.map((e) => (e.id === id ? { ...e, name } : e));
  }
  activateEntity(id: string): void {
    if (this.isPreparing(id)) this.statuses.set(id, "active");
  }
  listPreparingEntities(): EntitySummary[] {
    return this.entities.filter((e) => this.isPreparing(e.id));
  }
}
