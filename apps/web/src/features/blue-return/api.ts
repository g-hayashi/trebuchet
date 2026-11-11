import { queryOptions } from "@tanstack/react-query";
import { api, entityPath, unwrap } from "@/lib/api";

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

// ---- 家事按分・地代家賃の内訳・決算整理の仕訳の案（US2） ----
// どれも年度のキーの下に置く。年度のキーを無効にすると、決算書とあわせて読み直される

export const homeUseQuery = (entityId: string, year: string) =>
  queryOptions({
    queryKey: [...blueReturnKeys.year(entityId, year), "home-use"] as const,
    queryFn: async () =>
      unwrap(await blueReturnApi["home-use"].$get({ param: { entityId, year } })),
  });

export const rentDetailsQuery = (entityId: string, year: string) =>
  queryOptions({
    queryKey: [...blueReturnKeys.year(entityId, year), "rent-details"] as const,
    queryFn: async () =>
      (await unwrap(await blueReturnApi["rent-details"].$get({ param: { entityId, year } }))).rows,
  });

export const adjustmentsQuery = (entityId: string, year: string) =>
  queryOptions({
    queryKey: [...blueReturnKeys.year(entityId, year), "adjustments"] as const,
    queryFn: async () =>
      (await unwrap(await blueReturnApi.adjustments.$get({ param: { entityId, year } }))).proposals,
  });

export const putHomeUse = async (
  entityId: string,
  year: string,
  json: Parameters<(typeof blueReturnApi)["home-use"]["$put"]>[0]["json"],
) => unwrap(await blueReturnApi["home-use"].$put({ param: { entityId, year }, json }));

export const putRentDetails = async (
  entityId: string,
  year: string,
  json: Parameters<(typeof blueReturnApi)["rent-details"]["$put"]>[0]["json"],
) => unwrap(await blueReturnApi["rent-details"].$put({ param: { entityId, year }, json }));

/** 按分の登録（API の応答の1件） */
export type HomeUseAllocationRow = Awaited<ReturnType<typeof putHomeUse>>["allocation"];
/** 地代家賃の内訳（API の応答の1行） */
export type RentDetailRow = Awaited<ReturnType<typeof putRentDetails>>["rows"][number];

export const postAdjustment = async (
  entityId: string,
  year: string,
  json: Parameters<(typeof blueReturnApi)["adjustments"]["$post"]>[0]["json"],
) => unwrap(await blueReturnApi.adjustments.$post({ param: { entityId, year }, json }));

/** 決算のメモ（特別な事情・期首と前期末の差の説明）の保存（US4。FR-027, FR-030） */
export const putClosingNote = async (
  entityId: string,
  year: string,
  kind: "special_circumstances" | "opening_difference",
  body: string,
) =>
  unwrap(
    await blueReturnApi.notes[":kind"].$put({
      param: { entityId, year, kind },
      json: { body },
    }),
  );

/** CSV のダウンロードの URL。使わない欄は常に空にする（`blankUnused=true`。様式の行の対応を保つ。FR-045） */
export const blueReturnCsvUrl = (entityId: string, year: string) =>
  `${entityPath(entityId)}/blue-return/${encodeURIComponent(year)}/csv?blankUnused=true`;
