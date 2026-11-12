import {
  ENTITY_NAME_MAX,
  FIRST_FISCAL_YEAR_MAX,
  FIRST_FISCAL_YEAR_MIN,
  FISCAL_START_MONTH_MAX,
  FISCAL_START_MONTH_MIN,
} from "@trebuchet/schema";
import { fiscalYearStart, oneYearEnd } from "../dates.ts";
import type { Clock, IdGenerator, MasterRepository, RegistryRepository } from "../ports.ts";
import { INDIVIDUAL_ACCOUNTS } from "../seed/accounts.individual.ts";
import {
  type EntityKind,
  type EntityProfile,
  entityNotFoundError,
  err,
  ok,
  type Result,
  validation,
} from "../types.ts";

export type CreateEntityInput = {
  name: string;
  kind: EntityKind;
  fiscalStartMonth: number;
  firstFiscalYear: number;
  /** 既定は `active`。デモは `preparing` で作り、投入が済んだら `activateEntity` する（014 R2）。`POST /api/entities` からは渡さない */
  status?: "active" | "preparing" | undefined;
  /** デモ事業の印。既定は false（014 R3）。`POST /api/entities` からは渡さない */
  demo?: boolean | undefined;
};

export type CreateEntityDeps = {
  registry: RegistryRepository;
  /** 事業体の ID からテナントの DB を開く（なければ作ってマイグレーションする） */
  openTenant: (entityId: string) => MasterRepository;
  ids: IdGenerator;
  clock: Clock;
};

function validateInput(input: CreateEntityInput): Result<CreateEntityInput> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > ENTITY_NAME_MAX) {
    return validation(`名称は 1〜${ENTITY_NAME_MAX} 文字で入力してください`, { field: "name" });
  }
  const month = input.fiscalStartMonth;
  if (
    !Number.isInteger(month) ||
    month < FISCAL_START_MONTH_MIN ||
    month > FISCAL_START_MONTH_MAX
  ) {
    return validation(
      `期首月は ${FISCAL_START_MONTH_MIN}〜${FISCAL_START_MONTH_MAX} で入力してください`,
      { field: "fiscalStartMonth" },
    );
  }
  if (input.kind === "individual" && month !== 1) {
    return validation("個人事業の会計期間は 1 月始まりです", { field: "fiscalStartMonth" });
  }
  const year = input.firstFiscalYear;
  if (!Number.isInteger(year) || year < FIRST_FISCAL_YEAR_MIN || year > FIRST_FISCAL_YEAR_MAX) {
    return validation(
      `最初の年度は ${FIRST_FISCAL_YEAR_MIN}〜${FIRST_FISCAL_YEAR_MAX} で入力してください`,
      { field: "firstFiscalYear" },
    );
  }
  return ok({ ...input, name });
}

/**
 * 事業体を作成する（US1, FR-001, FR-004）。
 * テナントの DB に、プロファイル・勘定科目の初期セット（001 では kind によらず個人用）・最初の会計期間・
 * 消費税の設定（免税・税込、適用開始日 = 会計期間の開始日）を1トランザクションで投入し、最後に registry に登録する。
 *
 * registry とテナントは別の DB ファイルのため、両方にまたがるトランザクションは張れない。
 * そのため registry への登録を最後に行い、registry を「事業体が存在する」ことの正本とする:
 * - テナントへの投入が失敗したら、そのトランザクションはロールバックされ、registry には何も残らない。
 * - registry への登録が失敗したら、例外を投げる。投入済みのテナントの DB は registry から参照されないため、
 *   一覧にも API（registry で存在を確認する）にも現れない孤立したファイルになる（ID は再利用しない）。
 *   補償として削除はしない（ファイルの削除は db 層の責務で、失敗時にさらに不整合を生むため）。
 */
export function createEntity(
  deps: CreateEntityDeps,
  input: CreateEntityInput,
): Result<EntityProfile> {
  const validated = validateInput(input);
  if (!validated.ok) return validated;
  const { name, kind, fiscalStartMonth, firstFiscalYear } = validated.value;

  const profile: EntityProfile = {
    id: deps.ids.next(),
    name,
    kind,
    fiscalStartMonth,
    createdAt: deps.clock.now(),
  };
  const startDate = fiscalYearStart(firstFiscalYear, fiscalStartMonth);

  const tenant = deps.openTenant(profile.id);
  tenant.transaction((tx) => {
    tx.saveProfile(profile);
    for (const seed of INDIVIDUAL_ACCOUNTS) {
      tx.insertAccount({ ...seed, id: deps.ids.next(), isSystem: true, isActive: true });
    }
    tx.insertFiscalPeriod({
      id: deps.ids.next(),
      fiscalYear: firstFiscalYear,
      startDate,
      endDate: oneYearEnd(startDate),
      status: "open",
      closedAt: null,
    });
    tx.replaceTaxSettings([
      {
        id: deps.ids.next(),
        effectiveFrom: startDate,
        taxpayerStatus: "exempt",
        accountingMethod: "tax_included",
      },
    ]);
    return ok(null);
  });

  deps.registry.insertEntity({
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    createdAt: profile.createdAt,
    demo: input.demo ?? false,
    status: input.status ?? "active",
  });
  return ok(profile);
}

/**
 * 事業体の名前を変える（PATCH /entities/:entityId）。テナントのプロファイルと registry の両方を変える。
 * registry とテナントは別の DB のため、registry の更新をテナントのトランザクションの最後に行う。
 * registry の更新が例外で失敗すれば、プロファイルの変更も巻き戻る
 */
export function renameEntity(
  deps: { tenant: MasterRepository; registry: RegistryRepository },
  entityId: string,
  name: string,
): Result<EntityProfile> {
  return deps.tenant.transaction((tx) => {
    const profile = tx.getProfile();
    if (profile === undefined) {
      return err(entityNotFoundError());
    }
    const updated = { ...profile, name };
    tx.saveProfile(updated);
    deps.registry.renameEntity(entityId, name);
    return ok(updated);
  });
}
