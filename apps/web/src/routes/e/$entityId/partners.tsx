import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { billingTermsQuery } from "@/features/invoicing/api";
import { billingSummary } from "@/features/invoicing/display";
import { type Partner, partnersQuery } from "@/features/masters/api";
import { PartnerProfileForm } from "@/features/masters/PartnerProfileForm";

export const Route = createFileRoute("/e/$entityId/partners")({
  component: PartnersPage,
});

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().trim();

/** 名前とメモの部分一致（FR-048） */
const matchesPartner = (partner: Partner, query: string) => {
  const needle = normalize(query);
  return [partner.name, partner.memo ?? ""].some((v) => normalize(v).includes(needle));
};

/**
 * 取引先（011 FR-048・049）。検索と、名前・敬称・メモ・請求の条件・使用停止を 1 つの欄で保存する
 * パネル（`PartnerProfileForm`）。使用停止の取引先は請求書・仕訳の入力の候補に出ない
 */
function PartnersPage() {
  const { entityId } = Route.useParams();
  const { data: partners, isPending, error } = useQuery(partnersQuery(entityId));
  const terms = useQuery(billingTermsQuery(entityId));
  const termsByPartner = new Map((terms.data ?? []).map((t) => [t.partnerId, t]));
  // null = 閉じている、"new" = 登録、Partner = 編集
  const [panel, setPanel] = useState<Partner | "new" | null>(null);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const close = () => setPanel(null);
  const visible = partners?.filter((p) => matchesPartner(p, query)) ?? [];

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">取引先</h1>
        <Button variant="outline" onClick={() => setPanel("new")}>
          取引先を登録
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>取引先の一覧</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={error ?? terms.error} />
          {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {partners && partners.length === 0 && (
            <p className="text-sm text-muted-foreground">取引先はまだありません。</p>
          )}
          {partners && partners.length > 0 && (
            <>
              <div className="flex items-center gap-2">
                <Label htmlFor={searchId}>取引先を検索</Label>
                <Input
                  id={searchId}
                  type="search"
                  className="h-8 w-60"
                  placeholder="名称・メモ"
                  autoComplete="off"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {visible.length === 0 ? (
                <p className="text-sm text-muted-foreground">条件に合う取引先はありません。</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>名称</TableHead>
                      <TableHead className="w-16">敬称</TableHead>
                      <TableHead>メモ</TableHead>
                      <TableHead>請求の条件</TableHead>
                      <TableHead>状態</TableHead>
                      <TableHead className="w-0">
                        <span className="sr-only">操作</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((p) => (
                      <TableRow key={p.id} className={p.isActive ? undefined : "opacity-60"}>
                        <TableCell>{p.name}</TableCell>
                        <TableCell>{p.honorific ?? ""}</TableCell>
                        <TableCell className="whitespace-pre-wrap text-muted-foreground">
                          {p.memo ?? ""}
                        </TableCell>
                        <TableCell>{billingSummary(termsByPartner.get(p.id))}</TableCell>
                        <TableCell>{p.isActive ? "有効" : "使用停止"}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`取引先の編集（${p.name}）`}
                            onClick={() => setPanel(p)}
                          >
                            編集
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <Sheet open={panel !== null} onOpenChange={(open) => !open && close()}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              {panel === "new" || panel === null ? "取引先の登録" : "取引先の編集"}
            </SheetTitle>
            <SheetDescription>
              名前・敬称・メモ・請求の条件・使用停止をまとめて保存します。請求の条件がある取引先が工数の入力の対象になります。
            </SheetDescription>
          </SheetHeader>
          {panel !== null && (
            <PartnerProfileForm
              key={panel === "new" ? "new" : panel.id}
              entityId={entityId}
              partner={panel === "new" ? null : panel}
              terms={panel === "new" ? null : (termsByPartner.get(panel.id) ?? null)}
              onDone={close}
            />
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}
