import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";

// 青色申告決算書の API（003 contracts/http-api.md「決算書」「控除の回答」）

const blueReturnApi = api.api.entities[":entityId"]["blue-return"][":year"];

/** 決算書の画面のクエリのキー。回答を保存したら前方一致で読み直す */
export const blueReturnKeys = {
  all: (entityId: string) => ["entities", entityId, "blue-return"] as const,
  year: (entityId: string, year: string) => ["entities", entityId, "blue-return", year] as const,
  answers: (entityId: string, year: string) =>
    ["entities", entityId, "blue-return", year, "deduction-answers"] as const,
};

/** 決算書。使わない欄は常に 0（空欄の表示は画面が行う） */
export const blueReturnQuery = (entityId: string, year: string) =>
  queryOptions({
    queryKey: blueReturnKeys.year(entityId, year),
    queryFn: async () =>
      (await unwrap(await blueReturnApi.$get({ param: { entityId, year } }))).blueReturn,
  });

export const deductionAnswersQuery = (entityId: string, year: string) =>
  queryOptions({
    queryKey: blueReturnKeys.answers(entityId, year),
    queryFn: async () =>
      unwrap(await blueReturnApi["deduction-answers"].$get({ param: { entityId, year } })),
  });

export const putDeductionAnswers = async (
  entityId: string,
  year: string,
  json: Parameters<(typeof blueReturnApi)["deduction-answers"]["$put"]>[0]["json"],
) => unwrap(await blueReturnApi["deduction-answers"].$put({ param: { entityId, year }, json }));

/** CSV のダウンロードの URL。blankUnused は表示の切り替えと同じ値を渡す（保存しない） */
export const blueReturnCsvUrl = (entityId: string, year: string, blankUnused: boolean) =>
  `/api/entities/${encodeURIComponent(entityId)}/blue-return/${encodeURIComponent(year)}/csv?blankUnused=${blankUnused}`;
