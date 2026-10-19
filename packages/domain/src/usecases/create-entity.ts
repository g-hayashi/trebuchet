import { fiscalYearStart, oneYearEnd } from "../dates.ts";
import type { Clock, IdGenerator, MasterRepository, RegistryRepository } from "../ports.ts";
import { INDIVIDUAL_ACCOUNTS } from "../seed/accounts.individual.ts";
import {
  domainError,
  type EntityKind,
  type EntityProfile,
  err,
  ok,
  type Result,
} from "../types.ts";

export type CreateEntityInput = {
  name: string;
  kind: EntityKind;
  fiscalStartMonth: number;
  firstFiscalYear: number;
};

export type CreateEntityDeps = {
  registry: RegistryRepository;
  /** 事業体の ID からテナントの DB を開く（なければ作ってマイグレーションする） */
  openTenant: (entityId: string) => MasterRepository;
  ids: IdGenerator;
  clock: Clock;
};

const NAME_MAX = 100;

function validateInput(input: CreateEntityInput): Result<CreateEntityInput> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > NAME_MAX) {
    return err(
      domainError("VALIDATION", "名称は 1〜100 文字で入力してください", { field: "name" }),
    );
  }
  const month = input.fiscalStartMonth;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return err(
      domainError("VALIDATION", "期首月は 1〜12 で入力してください", { field: "fiscalStartMonth" }),
    );
  }
  if (input.kind === "individual" && month !== 1) {
    return err(
      domainError("VALIDATION", "個人事業の会計期間は 1 月始まりです", {
        field: "fiscalStartMonth",
      }),
    );
  }
  const year = input.firstFiscalYear;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return err(
      domainError("VALIDATION", "最初の年度は 2000〜2100 で入力してください", {
        field: "firstFiscalYear",
      }),
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
  });

  deps.registry.insertEntity({
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    createdAt: profile.createdAt,
  });
  return ok(profile);
}
