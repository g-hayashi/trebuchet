import type { Clock, IdGenerator } from "./ports.ts";
import type { AuditEntry } from "./types.ts";

/** 監査の記録の中身。before・after は値のまま渡す（JSON にするのは auditEntry） */
export type AuditInput<TTarget extends string, TAction extends string> = {
  targetType: TTarget;
  targetId: string;
  action: TAction;
  /** 省略で null */
  reason?: string | null | undefined;
  /** null・undefined なら beforeJson は null。それ以外は JSON.stringify */
  before?: unknown;
  /** null・undefined なら afterJson は null。それ以外は JSON.stringify */
  after?: unknown;
  /** 記録の日時。省略で clock.now()（書き込みと同じ日時にするときは渡す） */
  at?: string | undefined;
};

const toJson = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

/**
 * 監査の記録（audit_log・closing_audit_log・invoicing_audit_log のどれでも）の 1 行を作る。
 * ID を 1 つ採番する（呼ぶ順で ID の順が決まる）
 */
export function auditEntry<TTarget extends string, TAction extends string>(
  deps: { ids: IdGenerator; clock: Clock },
  input: AuditInput<TTarget, TAction>,
): AuditEntry<TTarget, TAction> {
  const id = deps.ids.next();
  return {
    id,
    occurredAt: input.at ?? deps.clock.now(),
    targetType: input.targetType,
    targetId: input.targetId,
    action: input.action,
    reason: input.reason ?? null,
    beforeJson: toJson(input.before),
    afterJson: toJson(input.after),
  };
}
