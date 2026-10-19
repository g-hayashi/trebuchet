import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilePicker } from "@/features/imports/FilePicker";

export const Route = createFileRoute("/e/$entityId/imports/")({
  component: ImportsPage,
});

/** 取込の画面。プレビューと確定は US1 で加える */
function ImportsPage() {
  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">取込</h1>
      <Card>
        <CardHeader>
          <CardTitle>freee の仕訳帳</CardTitle>
          <CardDescription>freee から書き出した仕訳帳の CSV を選んでください。</CardDescription>
        </CardHeader>
        <CardContent>
          <FilePicker label="仕訳帳のファイル" onChange={() => {}} />
        </CardContent>
      </Card>
    </main>
  );
}
