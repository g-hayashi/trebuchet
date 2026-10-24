import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FilePicker } from "@/features/imports/FilePicker";
import { formatDateTime } from "@/lib/format";
import { inspectBackup } from "./api";

/**
 * 復元の前の検査（FR-024・027、research R13）。ファイルとパスフレーズを送り、要約を表示する。
 * 画面からは復元しない（server を止めてコマンドで行う）
 */
export function InspectBackup() {
  const [file, setFile] = useState<File>();
  const [passphrase, setPassphrase] = useState("");
  const inspect = useMutation({ mutationFn: inspectBackup });
  const result = inspect.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>復元</CardTitle>
        <CardDescription>
          バックアップのファイルを検査して、中身を確かめます。検査では帳簿は変わりません。復元そのものは、このあとの手順でコマンドから行います。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          aria-label="バックアップの検査"
          className="grid max-w-xl gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (file === undefined || passphrase === "") return;
            inspect.mutate({ file, passphrase });
          }}
        >
          <FilePicker
            label="バックアップのファイル"
            accept=".tbk"
            onChange={(picked) => {
              setFile(picked);
              inspect.reset();
            }}
          />
          <div className="grid gap-2">
            <Label htmlFor="backup-inspect-passphrase">バックアップのパスフレーズ</Label>
            <Input
              id="backup-inspect-passphrase"
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(event) => setPassphrase(event.currentTarget.value)}
            />
          </div>
          <ApiErrorMessage error={inspect.error} />
          <div>
            <Button
              type="submit"
              disabled={file === undefined || passphrase === "" || inspect.isPending}
            >
              検査
            </Button>
          </div>
        </form>
        {result && (
          <>
            <section aria-label="検査の結果" className="grid gap-2 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">作成日時</dt>
                <dd>{formatDateTime(result.createdAt)}</dd>
                <dt className="text-muted-foreground">作った Mac の ID</dt>
                <dd>{result.macId}</dd>
              </dl>
              {result.entities.length === 0 ? (
                <p>事業体はありません。</p>
              ) : (
                <ul className="grid gap-2">
                  {result.entities.map((entity) => (
                    <li key={entity.id}>
                      <p className="font-medium">{entity.name}</p>
                      <ul className="list-disc pl-5">
                        {entity.fiscalYears.map((y) => (
                          <li key={y.year}>
                            {y.year}年度: 仕訳 {y.journals}件
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="復元の手順" className="grid gap-2 text-sm">
              <h3 className="font-medium">復元の手順</h3>
              <ol className="list-decimal pl-5">
                <li>server を止める（`pnpm dev` を終了する）。</li>
                <li>
                  次のコマンドを実行し、パスフレーズを入力する。
                  <pre className="mt-1 overflow-x-auto rounded-md bg-muted px-3 py-2">
                    pnpm restore -- --file &lt;path&gt; [--data-dir &lt;dir&gt;]
                  </pre>
                </li>
                <li>起動してパスキーを登録し、バックアップの置き場所などの設定をし直す。</li>
              </ol>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
