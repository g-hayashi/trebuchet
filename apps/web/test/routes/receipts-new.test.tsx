import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RECEIPT_MAX_BYTES, type ReceiptDetail } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiptKeys } from "@/features/receipts/api";
import { Route } from "@/routes/e/$entityId/receipts/$receiptId";
import { Route as ListRoute } from "@/routes/e/$entityId/receipts/index";
import { Route as NewRoute } from "@/routes/e/$entityId/receipts/new";
import { Route as EntitiesRoute } from "@/routes/index";
import { type ApiCall, apiError, formFields, mockApi, ok } from "../mock-api";
import { RECEIPT_ID, receiptDetail, receiptReading } from "../receipts-fixtures";
import { renderRoute } from "../render-route";

// T017b: 理由なしで未入力の値を埋める（H: §2 の PATCH。US2 シナリオ 3、D1）

const DETAIL = `/api/entities/e1/receipts/${RECEIPT_ID}`;
const LIST = "/api/entities/e1/receipts";
const SECOND = "00000000-0000-4000-8000-0000000000a2";
const jpeg = (name: string) => new File(["synthetic"], name, { type: "image/jpeg" });
const renderNew = (entityId = "e1") =>
  renderRoute(NewRoute, {
    path: "/e/$entityId/receipts/new",
    url: `/e/${entityId}/receipts/new`,
  });
async function addFiles(names: string[]) {
  const form = await screen.findByRole("form", { name: "証憑を追加" });
  await userEvent.upload(within(form).getByLabelText("ファイルを選ぶ"), names.map(jpeg));
  await userEvent.click(within(form).getByRole("radio", { name: "電子取引" }));
  await userEvent.click(within(form).getByRole("button", { name: "追加する" }));
}

beforeEach(() => localStorage.clear());

describe("証憑の追加と連続入力（T023）", () => {
  it("一覧は追加ページへのリンクを持ち、アップロードフォームは表示しない", async () => {
    mockApi({ [`GET ${LIST}`]: () => ok({ receipts: [], nextCursor: null }) });
    renderRoute(ListRoute, { path: "/e/$entityId/receipts/", url: "/e/e1/receipts" });
    expect(await screen.findByRole("link", { name: "追加する" })).toHaveAttribute(
      "href",
      "/e/e1/receipts/new",
    );
    expect(screen.queryByRole("form", { name: "証憑を追加" })).not.toBeInTheDocument();
  });

  it("事業体の一覧の証憑追加リンクは各事業体の追加ページを開く", async () => {
    mockApi({
      "GET /api/entities": () =>
        ok({
          entities: ["e1", "e2"].map((id) => ({
            id,
            name: `合成事業${id}`,
            kind: "individual",
            createdAt: "2026-01-01T00:00:00.000Z",
            demo: false,
          })),
        }),
    });
    renderRoute(EntitiesRoute, { path: "/", url: "/" });
    const links = await screen.findAllByRole("link", { name: "証憑を追加" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/e/e1/receipts/new",
      "/e/e2/receipts/new",
    ]);
  });
  it("必須項目を検証し、サイズ超過だけを送らず他のファイルは追加する", async () => {
    const calls = mockApi({ [`POST ${LIST}`]: () => ok({ receipt: receiptDetail() }, 201) });
    renderNew();
    const form = await screen.findByRole("form", { name: "証憑を追加" });
    await userEvent.click(within(form).getByRole("button", { name: "追加する" }));
    expect(within(form).getByText("ファイルを選んでください")).toBeInTheDocument();
    expect(within(form).getByText("区分を選んでください")).toBeInTheDocument();
    await userEvent.upload(within(form).getByLabelText("ファイルを選ぶ"), [
      new File([new Uint8Array(RECEIPT_MAX_BYTES + 1)], "big.jpg", { type: "image/jpeg" }),
      jpeg("ok.jpg"),
    ]);
    await userEvent.click(within(form).getByRole("radio", { name: "電子取引" }));
    await userEvent.click(within(form).getByRole("button", { name: "追加する" }));
    expect(await screen.findByText(/ファイルが大きすぎます/)).toHaveTextContent(
      "この証憑は保存されていません",
    );
    await screen.findByText("追加しました。");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(formFields(posts[0]?.form)?.options))).toEqual({
      category: "electronic",
    });
  });

  it("3件の追加後、一覧に戻らず値を入れ終えられる", async () => {
    const ids = [RECEIPT_ID, SECOND, "00000000-0000-4000-8000-0000000000a3"];
    const records = ids.map((id) => receiptDetail({ ...EMPTY, id }));
    let index = 0;
    const calls = mockApi({
      [`POST ${LIST}`]: () => ok({ receipt: records[index++] }, 201),
      ...Object.fromEntries(
        ids.flatMap((id, i) => [
          [`GET ${LIST}/${id}`, () => ok({ receipt: records[i] })],
          [
            `PATCH ${LIST}/${id}`,
            ({ body }: ApiCall) => {
              records[i] = receiptDetail({
                ...EMPTY,
                id,
                ...(body as object),
                version: 2,
                warnings: [],
              });
              return ok({ receipt: records[i] });
            },
          ],
        ]),
      ),
    });
    renderNew();
    await addFiles(["one.jpg", "two.jpg", "three.jpg"]);
    await waitFor(() => expect(screen.getAllByText("追加しました。")).toHaveLength(3));
    for (let i = 0; i < 3; i++) {
      const form = await screen.findByRole("form", { name: "証憑の値" });
      await userEvent.type(within(form).getByLabelText("取引年月日"), "2026-10-20");
      await userEvent.type(within(form).getByLabelText("金額"), "1000");
      await userEvent.type(within(form).getByLabelText("取引先"), `合成店${i}`);
      await userEvent.click(within(form).getByRole("button", { name: "次の未入力の証憑へ" }));
      await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(i + 1));
      await waitFor(() => expect(form).not.toBeInTheDocument());
    }
    expect(await screen.findByText(/追加した証憑の入力を終えました/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.path)).toEqual(
      ids.map((id) => `${LIST}/${id}`),
    );
  });

  it.each([
    ["LOCKED", 423, "Mac の帳簿が施錠されています"],
    ["RECEIPT_FORMAT_UNSUPPORTED", 422, "JPEG・PNG・HEIC・PDF"],
  ] as const)("追加失敗 %s の理由と未保存を示す", async (code, status, message) => {
    mockApi({ [`POST ${LIST}`]: () => apiError(status, code, message) });
    renderNew();
    await addFiles(["one.jpg"]);
    const results = await screen.findByRole("list", { name: "追加の結果" });
    expect(await within(results).findByText(new RegExp(message))).toHaveTextContent(
      "この証憑は保存されていません",
    );
    expect(screen.queryByRole("form", { name: "証憑の値" })).not.toBeInTheDocument();
  });

  it("3件を順送信し、追加・重複・エラーを各件表示する。成功だけ入力でき、二重送信しない", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const calls = mockApi({
      [`POST ${LIST}`]: async () => {
        count += 1;
        if (count === 1) {
          await gate;
          return ok({ receipt: receiptDetail(EMPTY) }, 201);
        }
        if (count === 2)
          return apiError(409, "RECEIPT_DUPLICATE", "同じ内容です", { receiptId: SECOND });
        return apiError(500, "RECEIPT_FILE_UNREADABLE", "保存に失敗しました");
      },
      [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail(EMPTY) }),
    });
    renderNew();
    await addFiles(["one.jpg", "duplicate.jpg", "error.jpg"]);
    expect(count).toBe(1);
    expect(screen.getByRole("button", { name: "追加中…" })).toBeDisabled();
    expect(screen.queryByText("追加しました。")).not.toBeInTheDocument();
    release();
    const results = await screen.findByRole("list", { name: "追加の結果" });
    await waitFor(() => expect(within(results).getAllByRole("listitem")).toHaveLength(3));
    const rows = within(results).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("one.jpg");
    expect(rows[0]).toHaveTextContent("追加しました。");
    expect(rows[1]).toHaveTextContent("重複");
    expect(within(rows[1] as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      `/e/e1/receipts/${SECOND}`,
    );
    expect(rows[2]).toHaveTextContent("この証憑は保存されていません");
    expect(await screen.findByRole("form", { name: "証憑の値" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "GET" && c.path.endsWith(SECOND))).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST").map((c) => formFields(c.form)?.file)).toEqual([
      expect.objectContaining({ name: "one.jpg" }),
      expect.objectContaining({ name: "duplicate.jpg" }),
      expect.objectContaining({ name: "error.jpg" }),
    ]);
    expect(screen.getByText("1件: error.jpg")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "追加する" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(4));
    expect(formFields(calls.filter((c) => c.method === "POST").at(-1)?.form)?.file).toMatchObject({
      name: "error.jpg",
    });
  });

  it("複数選択は撮影を強制せず、区分の理由と事業体ごとの既定を保つ", async () => {
    localStorage.setItem("trebuchet.receiptCategory.e1", "paper_scan");
    localStorage.setItem("trebuchet.receiptCategory.e2", "paper_scan");
    mockApi({});
    const first = renderNew();
    const picker = await screen.findByLabelText("ファイルを選ぶ");
    expect(picker).toHaveAttribute("multiple");
    expect(picker).not.toHaveAttribute("capture");
    expect(picker).toHaveAttribute(
      "accept",
      "image/jpeg,image/png,image/heic,image/heif,application/pdf",
    );
    const paper = screen.getByRole("radio", { name: "紙を撮影（原本は保存）" });
    expect(paper).toBeChecked();
    expect(paper).toHaveAccessibleDescription(/紙の原本は捨てずに保存する/);
    await userEvent.click(screen.getByRole("radio", { name: "電子取引" }));
    expect(localStorage.getItem("trebuchet.receiptCategory.e1")).toBe("electronic");
    first.unmount();
    renderNew("e2");
    expect(await screen.findByRole("radio", { name: "紙を撮影（原本は保存）" })).toBeChecked();
    expect(localStorage.getItem("trebuchet.receiptCategory.e2")).toBe("paper_scan");
  });

  it("ブラウザが保存を拒否しても選択と追加ができる", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied");
    });
    mockApi({
      [`POST ${LIST}`]: () => ok({ receipt: receiptDetail(EMPTY) }, 201),
      [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail(EMPTY) }),
    });
    renderNew();
    await addFiles(["one.jpg"]);
    expect(await screen.findByText("追加しました。")).toBeInTheDocument();
  });

  it("保存が失敗したら次へ進まず入力を残す。保存成功後は新しい版で次へ進む", async () => {
    let count = 0;
    let fail = true;
    const records = [receiptDetail(EMPTY), receiptDetail({ ...EMPTY, id: SECOND })];
    const calls = mockApi({
      [`POST ${LIST}`]: () => ok({ receipt: records[count++] }, 201),
      [`GET ${DETAIL}`]: () => ok({ receipt: records[0] }),
      [`GET ${LIST}/${SECOND}`]: () => ok({ receipt: records[1] }),
      [`PATCH ${DETAIL}`]: ({ body }) => {
        if (fail) return apiError(500, "RECEIPT_FILE_UNREADABLE", "保存できませんでした");
        records[0] = receiptDetail({ ...EMPTY, ...(body as object), version: 2 });
        return ok({ receipt: records[0] });
      },
    });
    renderNew();
    await addFiles(["one.jpg", "two.jpg"]);
    const form = await screen.findByRole("form", { name: "証憑の値" });
    await userEvent.type(within(form).getByLabelText("金額"), "1100");
    await userEvent.click(within(form).getByRole("button", { name: "次の未入力の証憑へ" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "証憑のファイルを読み出せません",
    );
    expect(within(form).getByLabelText("金額")).toHaveValue("1100");
    fail = false;
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    await screen.findByText("保存しました。");
    await userEvent.type(within(form).getByLabelText("メモ"), "合成メモ");
    await userEvent.click(within(form).getByRole("button", { name: "次の未入力の証憑へ" }));
    await waitFor(() => expect(screen.getByLabelText("金額")).toHaveValue(""));
    expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
      version: 2,
      memo: "合成メモ",
    });
  });

  it("AI の設定を読み込む前に追加が終わっても、読み込んだ後で設定が有効なら自動の読み取りを呼ぶ", async () => {
    const receipt = receiptDetail(EMPTY);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = mockApi({
      "GET /api/settings/ai": async () => {
        await gate;
        return ok({ externalEnabled: true, receiptImagesEnabled: true });
      },
      [`POST ${LIST}`]: () => ok({ receipt }, 201),
      [`GET ${DETAIL}`]: () => ok({ receipt }),
      [`POST ${DETAIL}/readings`]: () => ok({ reading: receiptReading() }, 201),
    });
    renderNew();
    await addFiles(["one.jpg"]);
    // 追加の応答が返っても、設定の応答はまだ（読み込み中）
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === LIST)).toBe(true),
    );
    expect(calls.some((c) => c.path === `${DETAIL}/readings`)).toBe(false);
    release();
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === `${DETAIL}/readings`)).toBe(true),
    );
  });

  it.each([
    [true, true],
    [false, true],
    [true, false],
  ])(
    "AI外部設定=%s、画像設定=%sのとき読み取りの操作と候補を切り替える",
    async (external, images) => {
      const enabled = external && images;
      const receipt = receiptDetail(EMPTY);
      const reading = receiptReading({
        candidates: {
          transactionDate: "2026-10-20",
          amount: 2200,
          partnerName: "合成AI店",
          accountCode: null,
          taxCategory: null,
        },
      });
      mockApi({
        "GET /api/settings/ai": () =>
          ok({ externalEnabled: external, receiptImagesEnabled: images }),
        [`POST ${LIST}`]: () => ok({ receipt }, 201),
        [`GET ${DETAIL}`]: () => ok({ receipt }),
        [`POST ${DETAIL}/readings`]: () => ok({ reading }, 201),
      });
      renderNew();
      await addFiles(["one.jpg"]);
      await screen.findByRole("form", { name: "証憑の値" });
      if (enabled) {
        await userEvent.click(await screen.findByRole("button", { name: "AI で読み取る" }));
        await waitFor(() => expect(screen.getByLabelText("金額")).toHaveValue("2,200"));
        expect(screen.getAllByText("AI の候補（未保存）")).toHaveLength(3);
      } else
        expect(screen.queryByRole("button", { name: "AI で読み取る" })).not.toBeInTheDocument();
    },
  );
});

const EMPTY: Partial<ReceiptDetail> = {
  category: "paper_scan",
  transactionDate: null,
  amount: null,
  partnerName: null,
  memo: null,
  warnings: [{ code: "FIELDS_MISSING" }],
};

const renderDetail = () =>
  renderRoute(Route, {
    path: "/e/$entityId/receipts/$receiptId",
    url: `/e/e1/receipts/${RECEIPT_ID}`,
  });

/** PATCH を受けて値を変え、version を進める状態つきの応答 */
function statefulApi(initial: Partial<ReceiptDetail>, patchReply?: () => ReturnType<typeof ok>) {
  let current = receiptDetail(initial);
  const calls = mockApi({
    [`GET ${DETAIL}`]: () => ok({ receipt: current }),
    [`PATCH ${DETAIL}`]: ({ body }) => {
      if (patchReply) return patchReply();
      const { version: _version, ...values } = body as Record<string, unknown>;
      current = {
        ...current,
        ...values,
        version: current.version + 1,
        warnings: [],
      } as ReceiptDetail;
      return ok({ receipt: current });
    },
  });
  return calls;
}

const patches = (calls: ApiCall[]) => calls.filter((c) => c.method === "PATCH");

async function openForm() {
  return await screen.findByRole("form", { name: "証憑の値" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("証憑の値の入力（未入力を埋める）", () => {
  it("今の値を入れて開く。未入力の欄は空", async () => {
    statefulApi({ ...EMPTY, partnerName: "合成の店", memo: "メモ" });
    renderDetail();
    const form = await openForm();
    expect(within(form).getByLabelText("取引年月日")).toHaveValue("");
    expect(within(form).getByLabelText("金額")).toHaveValue("");
    expect(within(form).getByLabelText("取引先")).toHaveValue("合成の店");
    expect(within(form).getByLabelText("メモ")).toHaveValue("メモ");
  });

  it("入れた値だけを version と一緒に PATCH で送る。理由は求めない", async () => {
    const calls = statefulApi(EMPTY);
    const { queryClient } = renderDetail();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const form = await openForm();
    const user = userEvent.setup();

    expect(within(form).queryByLabelText("理由")).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("取引年月日"), "2026-10-20");
    await user.type(within(form).getByLabelText("金額"), "1,100");
    await user.type(within(form).getByLabelText("取引先"), "合成の店");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.body).toEqual({
      version: 1,
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
    });
    // 保存の知らせは画面の上の toast に出る（フォームの外）
    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
    // 検索の結果に出るよう、証憑のクエリ（一覧・検索・詳細）を読み直す
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: receiptKeys.all("e1") }),
    );
    // 保存後は新しい version で開き直し、未入力の警告が消える
    await waitFor(() =>
      expect(screen.queryByText("未入力の項目があります")).not.toBeInTheDocument(),
    );
    await user.clear(within(form).getByLabelText("メモ"));
    await user.type(within(form).getByLabelText("メモ"), "会議");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]?.body).toEqual({ version: 2, memo: "会議" });
  });

  it("メモは入力済みでも変えられる。空にすると null を送る", async () => {
    const calls = statefulApi({ ...EMPTY, memo: "古いメモ" });
    renderDetail();
    const form = await openForm();
    await userEvent.clear(within(form).getByLabelText("メモ"));
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.body).toEqual({ version: 1, memo: null });
  });

  it("変えていなければ送らずに知らせる", async () => {
    const calls = statefulApi(EMPTY);
    renderDetail();
    const form = await openForm();
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("変更がありません")).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);
  });

  it("金額が 1 円以上の整数でなければ送らない。取引年月日は日付の入力欄", async () => {
    const calls = statefulApi(EMPTY);
    renderDetail();
    const form = await openForm();
    expect(within(form).getByLabelText("取引年月日")).toHaveAttribute("type", "date");
    await userEvent.type(within(form).getByLabelText("金額"), "12.5");
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText("1 円以上の整数で入力してください")).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);
  });

  it("入力済みの値を変えると、server が 422 REASON_REQUIRED を返し、理由を求める（値は変わらない。訂正は receipt-edit.test.tsx）", async () => {
    const calls = statefulApi(
      {
        category: "electronic",
        transactionDate: "2026-10-20",
        amount: 1100,
        partnerName: "合成の店",
      },
      () => apiError(422, "REASON_REQUIRED", "入力済みの値を変えるときは理由が必要です"),
    );
    renderDetail();
    const form = await openForm();
    expect(
      within(form).getByText(
        /入力済みの値（取引年月日・金額・取引先・区分）を変えるには理由が必要です/,
      ),
    ).toBeInTheDocument();
    const amount = within(form).getByLabelText("金額");
    expect(amount).toHaveValue("1,100");
    await userEvent.clear(amount);
    await userEvent.type(amount, "2000");
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("理由");
    expect(patches(calls)[0]?.body).toEqual({ version: 1, amount: 2000 });
    expect(within(form).queryByText("保存しました。")).not.toBeInTheDocument();
  });

  it("他の操作で更新されていれば（409 VERSION_CONFLICT）エラーを示し、最新を読み直す", async () => {
    let reads = 0;
    mockApi({
      [`GET ${DETAIL}`]: () => {
        reads += 1;
        return ok({ receipt: receiptDetail(EMPTY) });
      },
      [`PATCH ${DETAIL}`]: () =>
        apiError(409, "VERSION_CONFLICT", "別の操作で更新されています。開き直してください"),
    });
    renderDetail();
    const form = await openForm();
    await userEvent.type(within(form).getByLabelText("金額"), "100");
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("別の操作で更新されています");
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });
});
