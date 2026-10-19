import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePicker } from "@/features/imports/FilePicker";
import { uploadForm } from "@/features/imports/upload";
import { ApiError } from "@/lib/api";
import { apiError, formFields, mockApi, ok } from "../mock-api";

const PREVIEW = "/api/entities/e1/imports/freee/preview";
const csv = (name: string, content = '"取引日","仕訳ID"\n') =>
  new File([content], name, { type: "text/csv" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FilePicker（T017）", () => {
  it("ラベルで入力欄を見つけられ、CSV だけを受け付ける", () => {
    render(<FilePicker label="仕訳帳のファイル" onChange={() => {}} />);
    const input = screen.getByLabelText("仕訳帳のファイル");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("accept", ".csv");
    expect(input).toHaveAccessibleDescription("ファイルが選ばれていません。");
  });

  it("ファイルを選ぶと名前を表示し、選んだファイルを渡す", async () => {
    const onChange = vi.fn();
    render(
      <FilePicker
        label="仕訳帳のファイル"
        description="freee から書き出した CSV"
        onChange={onChange}
      />,
    );
    const file = csv("仕訳帳_2025.csv");

    await userEvent.upload(screen.getByLabelText("仕訳帳のファイル"), file);

    expect(screen.getByText("選んだファイル: 仕訳帳_2025.csv")).toBeInTheDocument();
    expect(screen.getByLabelText("仕訳帳のファイル")).toHaveAccessibleDescription(
      "freee から書き出した CSV 選んだファイル: 仕訳帳_2025.csv",
    );
    expect(onChange).toHaveBeenCalledWith(file);
  });

  it("CSV 以外のファイルは選べない", async () => {
    const onChange = vi.fn();
    render(<FilePicker label="仕訳帳のファイル" onChange={onChange} />);

    await userEvent.upload(
      screen.getByLabelText("仕訳帳のファイル"),
      new File(["x"], "memo.txt", { type: "text/plain" }),
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("ファイルが選ばれていません。")).toBeInTheDocument();
  });
});

describe("uploadForm（T017）", () => {
  it("multipart でファイルと追加のフィールドを送り、JSON の応答を返す", async () => {
    const calls = mockApi({
      [`POST ${PREVIEW}`]: async (call) => {
        const file = call.form?.get("file");
        return ok({ received: file instanceof File ? await file.text() : null });
      },
    });
    const options = JSON.stringify({ fiscalYears: [2025] });

    const result = await uploadForm<{ received: string }>(PREVIEW, {
      file: csv("journal.csv", "a,b\n1,2\n"),
      options,
    });

    expect(result).toEqual({ received: "a,b\n1,2\n" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(PREVIEW);
    expect(calls[0]?.body).toBeUndefined();
    expect(formFields(calls[0]?.form)).toEqual({
      file: { name: "journal.csv", type: "text/csv", size: 8 },
      options,
    });
  });

  it("エラーの応答は、コードと詳細を持つ ApiError にする", async () => {
    mockApi({
      [`POST ${PREVIEW}`]: () =>
        apiError(400, "VALIDATION", "options が JSON ではありません", { field: "options" }),
    });

    const error = await uploadForm(PREVIEW, { file: csv("journal.csv") }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "VALIDATION",
      message: "options が JSON ではありません",
      details: { field: "options" },
    });
  });

  it("エラーの形でない失敗は INTERNAL にする", async () => {
    mockApi({ [`POST ${PREVIEW}`]: () => ok(undefined, 502) });
    await expect(uploadForm(PREVIEW, { file: csv("journal.csv") })).rejects.toMatchObject({
      status: 502,
      code: "INTERNAL",
    });
  });
});
