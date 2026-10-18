import { describeError } from "@/lib/api-errors";

/**
 * API のエラーをフォームの近くに表示する。読み上げのため aria-live の領域を常に置き、
 * エラーがあるときだけ中身を入れる
 */
export function ApiErrorMessage({ error, className }: { error: unknown; className?: string }) {
  const described = error ? describeError(error) : undefined;
  return (
    <div aria-live="assertive" className={className}>
      {described && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
        >
          <p className="font-medium">{described.message}</p>
          {described.details.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {described.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** 入力欄ごとの検証メッセージ。入力欄の aria-describedby から id で参照する */
export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return (
    <p id={id} aria-live="polite" className="text-sm text-destructive empty:hidden">
      {message}
    </p>
  );
}
