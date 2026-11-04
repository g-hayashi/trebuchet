import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
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
import { type Partner, partnersQuery } from "@/features/masters/api";
import { PartnerProfileForm } from "@/features/masters/PartnerProfileForm";
import { billingTermsQuery } from "./api";
import { billingSummary } from "./display";

/**
 * 請求の画面の取引先（011 FR-034）。請求の条件の要約と、登録・編集のパネル。
 * 名前・敬称・請求の条件を 1 つの欄で入れる（`PartnerProfileForm`）
 */
export function InvoicePartners({ entityId }: { entityId: string }) {
  const partners = useQuery(partnersQuery(entityId));
  const terms = useQuery(billingTermsQuery(entityId));
  // null = 閉じている、"new" = 登録、Partner = 編集
  const [panel, setPanel] = useState<Partner | "new" | null>(null);
  const termsByPartner = new Map((terms.data ?? []).map((t) => [t.partnerId, t]));
  const close = () => setPanel(null);

  return (
    <section className="grid gap-3" aria-label="取引先の管理">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">取引先</h2>
        <Button variant="outline" onClick={() => setPanel("new")}>
          取引先を登録
        </Button>
      </div>
      <ApiErrorMessage error={partners.error ?? terms.error} />
      {partners.data &&
        (partners.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">取引先はまだありません。</p>
        ) : (
          <Table aria-label="取引先の一覧">
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>請求の条件</TableHead>
                <TableHead>状態</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {partners.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.name}</TableCell>
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
        ))}
      <Sheet open={panel !== null} onOpenChange={(open) => !open && close()}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              {panel === "new" || panel === null ? "取引先の登録" : "取引先の編集"}
            </SheetTitle>
            <SheetDescription>
              名前・敬称と請求の条件をまとめて保存します。請求の条件がある取引先が工数の入力の対象になります。
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
    </section>
  );
}
