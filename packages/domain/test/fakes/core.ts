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
  entities: EntitySummary[] = [];
  failOnInsert = false;

  listEntities(): EntitySummary[] {
    return [...this.entities];
  }
  getEntity(id: string): EntitySummary | undefined {
    return this.entities.find((e) => e.id === id);
  }
  insertEntity(entity: EntitySummary): void {
    if (this.failOnInsert) throw new Error("registry insert failed");
    this.entities.push(entity);
  }
  renameEntity(id: string, name: string): void {
    this.entities = this.entities.map((e) => (e.id === id ? { ...e, name } : e));
  }
}
