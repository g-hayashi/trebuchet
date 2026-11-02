import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AiSettings, type AiSettingsInput, isAllowedAiBaseUrl } from "@trebuchet/schema";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { aiSettingsKeys, aiSettingsQuery, putAiSettings } from "./api";

type Errors = { url?: string; model?: string; apiKey?: string };

function Fields({ settings }: { settings: AiSettings }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [localEnabled, setLocalEnabled] = useState(settings.localEnabled);
  const [externalEnabled, setExternalEnabled] = useState(settings.externalEnabled);
  const [url, setUrl] = useState(settings.externalBaseUrl ?? "");
  const [model, setModel] = useState(settings.externalModel ?? "");
  const [apiKey, setApiKey] = useState("");
  // 証憑の画像を外部の AI に送る（010 R15）。有効にする前に確認を求める
  const [receiptImages, setReceiptImages] = useState(
    settings.externalEnabled && settings.receiptImagesEnabled,
  );
  const [confirmingImages, setConfirmingImages] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState("");

  const save = useMutation({
    mutationFn: putAiSettings,
    onSuccess: (saved) => {
      queryClient.setQueryData(aiSettingsKeys.all, saved);
      // キーは保存したら画面に残さない
      setApiKey("");
      setNotice("保存しました。");
    },
  });

  /** `apiKey`: 省略は変えない、空文字は削除。URL・モデルが空なら送らない（サーバーは null にする） */
  const send = (key: string | undefined) => {
    const input: AiSettingsInput = {
      localEnabled,
      externalEnabled,
      // 必須の項目。外部の AI を無効にするときは、画像の送信も false にする（server も同じに扱う）
      receiptImagesEnabled: externalEnabled && receiptImages,
      ...(url.trim() === "" ? {} : { externalBaseUrl: url.trim() }),
      ...(model.trim() === "" ? {} : { externalModel: model.trim() }),
      ...(key === undefined ? {} : { apiKey: key }),
    };
    save.mutate(input);
  };

  const submit = (key: string | undefined) => {
    setNotice("");
    save.reset();
    const next: Errors = {};
    if (url.trim() !== "" && !isAllowedAiBaseUrl(url.trim())) {
      next.url = "接続先の URL は https:// か localhost だけです";
    }
    if (key === undefined && externalEnabled) {
      if (url.trim() === "") next.url = "接続先の URL を入力してください";
      if (model.trim() === "") next.model = "モデルを入力してください";
      if (apiKey === "" && !settings.apiKeySet) next.apiKey = "API キーを入力してください";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    send(key);
  };

  return (
    <form
      noValidate
      aria-label="AI の設定"
      className="grid max-w-xl gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit(apiKey === "" ? undefined : apiKey);
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>端末内の AI</CardTitle>
          <CardDescription>
            この端末で動く AI（Apple
            のオンデバイスモデル）で推定します。明細の内容は端末の外へ出ません。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex items-center gap-2">
            <input
              id={`${id}-local`}
              type="checkbox"
              checked={localEnabled}
              onChange={(e) => setLocalEnabled(e.target.checked)}
            />
            <Label htmlFor={`${id}-local`}>端末内の AI を使う</Label>
          </div>
          <p role="status" className="text-sm text-muted-foreground">
            {settings.localAvailable
              ? "この端末の AI は使えます。"
              : "この端末の AI は使えません。"}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>外部の AI</CardTitle>
          <CardDescription>
            端末内の AI
            の確信度が、明細の設定のしきい値に届かないときだけ、外部へ送ります。送る内容は、4
            桁以上の数字・連絡先・振込の名義を伏せたものです（口座の名前・メモ・取引先の一覧は送りません）。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center gap-2">
            <input
              id={`${id}-external`}
              type="checkbox"
              checked={externalEnabled}
              onChange={(e) => {
                setExternalEnabled(e.target.checked);
                // 外部を無効にしたら画像の送信も外す（戻したときに確認なしで有効に戻らない）
                if (!e.target.checked) setReceiptImages(false);
              }}
            />
            <Label htmlFor={`${id}-external`}>外部の AI を使う</Label>
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2">
              <input
                id={`${id}-receipt-images`}
                type="checkbox"
                checked={externalEnabled && receiptImages}
                disabled={!externalEnabled}
                aria-describedby={`${id}-receipt-images-hint`}
                onChange={(e) => {
                  // 有効にする前に確認する。無効にするときは確認しない
                  if (e.target.checked) setConfirmingImages(true);
                  else setReceiptImages(false);
                }}
              />
              <Label htmlFor={`${id}-receipt-images`}>証憑の画像を外部の AI に送る</Label>
            </div>
            <p id={`${id}-receipt-images-hint`} className="text-xs text-muted-foreground">
              証憑の画面で「AI で読み取る」を使えるようにします。画像はマスクできず、そのまま外部の
              AI に送られます。外部の AI を使うときだけ選べます。
            </p>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-url`}>接続先の URL</Label>
            <Input
              id={`${id}-url`}
              autoComplete="off"
              placeholder="https://api.example.com/v1"
              value={url}
              aria-invalid={errors.url ? true : undefined}
              aria-describedby={`${id}-url-error`}
              onChange={(e) => setUrl(e.target.value)}
            />
            <FieldError id={`${id}-url-error`} message={errors.url} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-model`}>モデル</Label>
            <Input
              id={`${id}-model`}
              autoComplete="off"
              value={model}
              aria-invalid={errors.model ? true : undefined}
              aria-describedby={`${id}-model-error`}
              onChange={(e) => setModel(e.target.value)}
            />
            <FieldError id={`${id}-model-error`} message={errors.model} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-key`}>API キー</Label>
            <Input
              id={`${id}-key`}
              type="password"
              autoComplete="off"
              value={apiKey}
              aria-invalid={errors.apiKey ? true : undefined}
              aria-describedby={`${id}-key-error ${id}-key-hint`}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <div id={`${id}-key-hint`} className="grid gap-0.5 text-xs text-muted-foreground">
              <p>{settings.apiKeySet ? "API キーは設定済みです。" : "API キーは未設定です。"}</p>
              <p>
                キーはキーチェーンに保存し、画面には表示しません。変えるときだけ入力してください。
              </p>
            </div>
            <FieldError id={`${id}-key-error`} message={errors.apiKey} />
            {settings.apiKeySet && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={save.isPending}
                  onClick={() => {
                    setApiKey("");
                    submit("");
                  }}
                >
                  API キーを削除
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          保存
        </Button>
        {notice && <SaveNotice message={notice} />}
      </div>
      <ApiErrorMessage error={save.error} />
      <Dialog
        open={confirmingImages}
        onOpenChange={(next) => {
          if (!next) setConfirmingImages(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>証憑の画像を外部の AI に送る</DialogTitle>
            <DialogDescription>
              証憑の画像はマスクできず、そのまま外部の AI に送られます（006
              の送る情報の原則の例外です）。送るのは、読み取りを操作した証憑の画像（メタデータを除いたもの）と、科目・税区分の選択肢だけで、取引先の一覧・ほかの仕訳・口座の名前は送りません。保存するまで帳簿は変わりません。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmingImages(false)}>
              やめる
            </Button>
            <Button
              type="button"
              onClick={() => {
                setReceiptImages(true);
                setConfirmingImages(false);
              }}
            >
              理解して有効にする
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}

/** AI の設定（H:§7。FR-027・027a）: 端末内の AI の可否と、外部の接続先・モデル・API キー。端末の設定 */
export function AiSettingsForm() {
  const settings = useQuery(aiSettingsQuery());
  return (
    <div className="grid gap-3">
      <ApiErrorMessage error={settings.error} />
      {settings.isPending && !settings.error && (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      )}
      {settings.data && <Fields settings={settings.data} />}
    </div>
  );
}
