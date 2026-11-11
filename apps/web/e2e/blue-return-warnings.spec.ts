import { expect, test } from "@playwright/test";
import { type BlueReturn, BlueReturnWarningCode } from "@trebuchet/schema";
import { MOBILE_VIEWPORT } from "./helpers/viewports.ts";

test("決算書の全警告に説明と対応を表示し、対応画面へ移動できる", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const entityId = "11111111-1111-4111-8111-111111111111";
  const path = `/e/${entityId}/blue-return/2026`;
  const side = { rows: [], total: 0 };
  const blueReturn: BlueReturn = {
    fiscalYear: 2026,
    formYear: 2026,
    status: "open",
    page1: { lines: [] },
    page2: {
      monthly: { months: [], total: { sales: 0, otherIncome: 0, total: 0 } },
      rentDetails: [],
      deduction: null,
    },
    page3: {
      salesPartners: { rows: [], others: 0, total: 0, withoutPartner: null },
      depreciation: [],
      specialCircumstances: null,
    },
    page4: {
      opening: { assets: side, liabilityEquity: side },
      closing: { assets: side, liabilityEquity: side },
      carryForwardCheck: "no_prior_year",
      openingDifferenceNote: null,
    },
    transfer: { businessIncome: null, blueDeduction: null },
    warnings: BlueReturnWarningCode.options.map((code) => ({ code, message: `${code}の警告` })),
  };
  // 全 API を合成応答に置き換え、実データに接続せず表示と画面遷移を確認する。
  const responses: Record<string, unknown> = {
    "/api/auth/status": {
      registered: true,
      signedIn: true,
      rpId: "localhost",
      remote: { enabled: false, host: null },
      recoveryAcknowledged: true,
    },
    "/api/backup/status": { configured: true, folderSource: "configured", alert: null },
    "/api/entities": {
      entities: [{ id: entityId, name: "警告確認用の合成事業", type: "individual" }],
    },
    [`/api/entities/${entityId}/recurring-journals/status`]: { unacknowledged: [], blocked: [] },
    [`/api/entities/${entityId}/blue-return/2026`]: { blueReturn },
    [`/api/entities/${entityId}/blue-return/2026/home-use`]: { allocations: [], previousYear: [] },
    [`/api/entities/${entityId}/blue-return/2026/rent-details`]: { rows: [] },
    [`/api/entities/${entityId}/blue-return/2026/adjustments`]: { proposals: [] },
    [`/api/entities/${entityId}/accounts`]: { accounts: [] },
    [`/api/entities/${entityId}/fiscal-periods`]: { fiscalPeriods: [] },
    [`/api/entities/${entityId}/fixed-assets`]: { assets: [] },
    [`/api/entities/${entityId}/deferred-assets`]: { deferredAssets: [] },
  };
  const unexpected: string[] = [];
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!(pathname in responses)) {
      unexpected.push(pathname);
      return route.fulfill({ status: 501, json: {} });
    }
    return route.fulfill({ json: responses[pathname] });
  });
  await page.goto(path);
  const main = page.getByRole("main", { exact: true });
  const warnings = main.getByRole("region", { name: "警告", exact: true });
  const warningCount = BlueReturnWarningCode.options.length;
  await expect(warnings.getByText(/^意味：/)).toHaveCount(warningCount);
  await expect(warnings.getByText(/^対応：/)).toHaveCount(warningCount);
  await expect(warnings.locator("details[open]")).toHaveCount(0);
  await expect(warnings.getByText(/^意味：/).first()).toBeHidden();
  await warnings.scrollIntoViewIfNeeded();
  await page.setViewportSize(MOBILE_VIEWPORT);
  await warnings.getByText("SALES_WITHOUT_PARTNERの警告", { exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const rent = warnings.getByRole("listitem").filter({ hasText: "RENT_DETAILS_MISMATCHの警告" });
  await rent.locator("summary").click();
  await expect(rent.getByText(/^対応：/)).toBeVisible();
  await warnings.getByRole("link", { name: "地代家賃の内訳を直す", exact: true }).click();
  await expect(
    main.getByRole("heading", { name: "家事按分・地代家賃の内訳（2026年分）", exact: true }),
  ).toBeVisible();
  await page.goto(path);
  const deferred = warnings
    .getByRole("listitem")
    .filter({ hasText: "DEFERRED_ASSET_NOT_AMORTIZEDの警告" });
  await deferred.locator("summary").click();
  await deferred.getByRole("link", { name: "開業費の償却額を決める", exact: true }).click();
  await expect(main.getByRole("heading", { name: "開業費", exact: true })).toBeVisible();
  await expect(main.getByLabel("年分", { exact: true })).toHaveValue("2026");
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
