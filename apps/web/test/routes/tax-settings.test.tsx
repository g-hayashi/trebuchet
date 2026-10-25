import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaxSetting } from "@/features/entities/api";
import { Route } from "@/routes/e/$entityId/tax-settings";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const PATH = "/api/entities/e1/tax-settings";

const setting = (
  id: string,
  effectiveFrom: string,
  taxpayerStatus: TaxSetting["taxpayerStatus"],
  accountingMethod: TaxSetting["accountingMethod"],
): TaxSetting => ({ id, effectiveFrom, taxpayerStatus, accountingMethod });

const s2024 = setting("a", "2024-01-01", "exempt", "tax_included");
const s2024mar = setting("b", "2024-03-01", "two_tenths", "tax_included");
const s2027 = setting("c", "2027-01-01", "general", "tax_excluded");
const toInput = ({ id: _, ...input }: TaxSetting) => input;

function renderTaxSettings() {
  return renderRoute(Route, { path: "/e/$entityId/tax-settings", url: "/e/e1/tax-settings" });
}

/** 一覧の行を [適用期間, 課税区分, 経理方式] として読む */
function readRows() {
  return within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .slice(0, 3)
        .map((cell) => cell.textContent?.trim()),
    );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("消費税の設定の画面", () => {
  it("適用開始日の順に並べ、次の設定の前日を適用終了日として表示する（うるう年・最後は空欄）", async () => {
    mockApi({ [`GET ${PATH}`]: () => ok({ taxSettings: [s2027, s2024, s2024mar] }) });
    renderTaxSettings();

    await screen.findByRole("table");
    expect(readRows()).toEqual([
      ["2024-01-01 〜 2024-02-29", "免税", "税込経理"],
      ["2024-03-01 〜 2026-12-31", "課税（2割特例）", "税込経理"],
      ["2027-01-01 〜", "課税（本則）", "税抜経理"],
    ]);
  });

  it("設定が 1 件だけなら削除できない", async () => {
    mockApi({ [`GET ${PATH}`]: () => ok({ taxSettings: [s2024] }) });
    renderTaxSettings();

    expect(
      await screen.findByRole("button", { name: "削除（2024-01-01 からの設定）" }),
    ).toBeDisabled();
  });

  it("設定を追加すると、全件を送って一覧を置き換える", async () => {
    let taxSettings = [s2024];
    const calls = mockApi({
      [`GET ${PATH}`]: () => ok({ taxSettings }),
      [`PUT ${PATH}`]: (call) => {
        const inputs = call.body as Omit<TaxSetting, "id">[];
        taxSettings = inputs.map((input, i) => ({ id: `n${i}`, ...input }));
        return ok({ taxSettings });
      },
    });
    const user = userEvent.setup();
    renderTaxSettings();
    await screen.findByRole("table");

    await user.type(screen.getByLabelText("適用開始日"), "2027-01-01");
    await user.selectOptions(screen.getByLabelText("課税区分"), "課税（簡易）");
    await user.selectOptions(screen.getByLabelText("経理方式"), "税抜経理");
    await user.click(screen.getByRole("button", { name: "追加して保存" }));

    expect(await screen.findByText("2027-01-01 〜")).toBeInTheDocument();
    expect(readRows()).toEqual([
      ["2024-01-01 〜 2026-12-31", "免税", "税込経理"],
      ["2027-01-01 〜", "課税（簡易）", "税抜経理"],
    ]);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual([
      toInput(s2024),
      {
        effectiveFrom: "2027-01-01",
        taxpayerStatus: "simplified",
        accountingMethod: "tax_excluded",
      },
    ]);
    expect(screen.getByLabelText("適用開始日")).toHaveValue("");
  });

  it("確認してから設定を削除し、残りの全件を送る", async () => {
    let taxSettings = [s2024, s2027];
    const calls = mockApi({
      [`GET ${PATH}`]: () => ok({ taxSettings }),
      [`PUT ${PATH}`]: () => {
        taxSettings = [s2024];
        return ok({ taxSettings });
      },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderTaxSettings();

    await user.click(await screen.findByRole("button", { name: "削除（2027-01-01 からの設定）" }));

    expect(confirm).toHaveBeenCalledWith("2027-01-01 からの設定を削除しますか？");
    expect(await screen.findByText("2024-01-01 〜")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual([toInput(s2024)]);
  });

  it("期間に空白ができるとサーバーのエラーを表示し、入力を残す", async () => {
    mockApi({
      [`GET ${PATH}`]: () => ok({ taxSettings: [s2024] }),
      [`PUT ${PATH}`]: () =>
        apiError(422, "TAX_SETTING_GAP", "最初の設定は事業開始日から適用してください"),
    });
    const user = userEvent.setup();
    renderTaxSettings();
    await screen.findByRole("table");

    await user.type(screen.getByLabelText("適用開始日"), "2023-01-01");
    await user.click(screen.getByRole("button", { name: "追加して保存" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("消費税の設定の期間に空白または重複があります。");
    expect(alert).toHaveTextContent("最初の設定は事業開始日から適用してください");
    expect(screen.getByLabelText("適用開始日")).toHaveValue("2023-01-01");
  });
});
