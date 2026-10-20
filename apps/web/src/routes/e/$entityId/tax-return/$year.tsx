import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { DocumentSection } from "@/features/tax-return/DocumentSection";
import { MemoSection } from "@/features/tax-return/MemoSection";

export const Route = createFileRoute("/e/$entityId/tax-return/$year")({
  component: TaxReturnPage,
});

/** 申告の控え（US6、FR-033〜036）。年分ごとに、事業所得以外の控えと提出書類の場所を記録する */
function TaxReturnPage() {
  const { entityId, year } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const [yearText, setYearText] = useState(year);

  const changeYear = (text: string) => {
    setYearText(text);
    if (/^\d{4}$/.test(text)) navigate({ params: { entityId, year: text } });
  };

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">申告の控え {year}年分</h1>
      <div className="grid max-w-40 gap-1">
        <label htmlFor="tax-return-year" className="text-sm font-medium">
          年分
        </label>
        <Input
          id="tax-return-year"
          inputMode="numeric"
          autoComplete="off"
          value={yearText}
          onChange={(e) => changeYear(e.target.value)}
        />
      </div>
      {/* 年分を変えたら入力欄を作り直す */}
      <MemoSection key={`memo-${year}`} entityId={entityId} year={year} />
      <DocumentSection key={`document-${year}`} entityId={entityId} year={year} />
    </main>
  );
}
